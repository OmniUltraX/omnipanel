     1|use std::collections::HashMap;
     2|
     3|use omnipanel_db::{DbParams, QueryResult, mysql_connect_options};
     4|use omnipanel_error::OmniError;
     5|pub use omnipanel_store::{
     6|    DbConnectionConfig, SchemaFiltersSnapshot, load_schema_filters, prune_connection_filters,
     7|    save_schema_filters,
     8|};
     9|use serde::{Deserialize, Serialize};
    10|use sqlx::Row;
    11|use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
    12|use sqlx::postgres::{PgPool, PgPoolOptions};
    13|use tauri::State;
    14|
    15|use crate::state::AppState;
    16|
    17|/// `information_schema` 部分列在 MySQL 驱动下为 BLOB，需兼容解码为 `String`。
    18|fn mysql_row_string(row: &MySqlRow, index: usize) -> String {
    19|    if let Ok(v) = row.try_get::<String, _>(index) {
    20|        return v;
    21|    }
    22|    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(index) {
    23|        return v;
    24|    }
    25|    if let Ok(v) = row.try_get::<Vec<u8>, _>(index) {
    26|        return String::from_utf8_lossy(&v).into_owned();
    27|    }
    28|    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(index) {
    29|        return String::from_utf8_lossy(&v).into_owned();
    30|    }
    31|    String::new()
    32|}
    33|
    34|fn mysql_row_i32(row: &MySqlRow, index: usize, default: i32) -> i32 {
    35|    if let Ok(v) = row.try_get::<i32, _>(index) {
    36|        return v;
    37|    }
    38|    if let Ok(v) = row.try_get::<i8, _>(index) {
    39|        return i32::from(v);
    40|    }
    41|    if let Ok(v) = row.try_get::<u8, _>(index) {
    42|        return i32::from(v);
    43|    }
    44|    if let Ok(v) = row.try_get::<i64, _>(index) {
    45|        return v as i32;
    46|    }
    47|    mysql_row_string(row, index).parse().unwrap_or(default)
    48|}
    49|
    50|#[derive(Debug, Serialize, Deserialize)]
    51|pub struct TableInfo {
    52|    pub name: String,
    53|    pub rows: Vec<HashMap<String, serde_json::Value>>,
    54|    pub columns: Vec<String>,
    55|}
    56|
    57|#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
    58|#[serde(rename_all = "camelCase")]
    59|pub struct DbColumnMeta {
    60|    pub name: String,
    61|    #[serde(rename = "type")]
    62|    pub column_type: String,
    63|    pub is_pk: bool,
    64|    pub is_fk: bool,
    65|}
    66|
    67|#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
    68|#[serde(rename_all = "camelCase")]
    69|pub struct DbIndexMeta {
    70|    pub name: String,
    71|    pub columns: Vec<String>,
    72|    pub unique: bool,
    73|}
    74|
    75|#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
    76|pub struct DbTableSchema {
    77|    pub name: String,
    78|    pub columns: Vec<DbColumnMeta>,
    79|    #[serde(default)]
    80|    pub indexes: Vec<DbIndexMeta>,
    81|}
    82|
    83|#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
    84|pub struct DbIntrospectResult {
    85|    pub database: String,
    86|    pub tables: Vec<DbTableSchema>,
    87|}
    88|
    89|#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
    90|#[serde(rename_all = "camelCase")]
    91|pub struct TableRowCount {
    92|    pub name: String,
    93|    /// 统计成功时为行数；单表失败时为 `null`（如视图、权限不足）。
    94|    pub count: Option<i64>,
    95|}
    96|
    97|/// 将领域错误转为前端可读文案（含底层 cause）。
    98|fn err_msg(e: OmniError) -> String {
    99|    e.user_message()
   100|}
   101|
   102|/// 将 IPC 连接配置转换为 omnipanel-db 的领域连接参数。
   103|fn to_params(c: &DbConnectionConfig) -> DbParams {
   104|    DbParams {
   105|        db_type: c.db_type.clone(),
   106|        host: c.host.clone(),
   107|        port: c.port,
   108|        user: c.user.clone(),
   109|        password: c.password.clone(),
   110|        database: c.database.clone(),
   111|        ssl: c.ssl,
   112|    }
   113|}
   114|
   115|async fn mysql_pool(connection: &DbConnectionConfig) -> Result<MySqlPool, String> {
   116|    let opts = mysql_connect_options(&to_params(connection));
   117|    MySqlPoolOptions::new()
   118|        .max_connections(1)
   119|        .connect_with(opts)
   120|        .await
   121|        .map_err(|e| format!("MySQL 连接失败: {e}"))
   122|}
   123|
   124|async fn pg_pool(connection: &DbConnectionConfig) -> Result<PgPool, String> {
   125|    let p = to_params(connection);
   126|    let opts = sqlx::postgres::PgConnectOptions::new()
   127|        .host(&p.host)
   128|        .port(p.port)
   129|        .username(&p.user)
   130|        .password(&p.password)
   131|        .database(&p.database);
   132|    PgPoolOptions::new()
   133|        .max_connections(1)
   134|        .connect_with(opts)
   135|        .await
   136|        .map_err(|e| format!("PostgreSQL 连接失败: {e}"))
   137|}
   138|
   139|fn with_schema(c: &DbConnectionConfig, schema: Option<String>) -> DbParams {
   140|    let mut params = to_params(c);
   141|    if let Some(s) = schema.filter(|name| !name.trim().is_empty()) {
   142|        params.database = s;
   143|    }
   144|    params
   145|}
   146|
   147|#[tauri::command]
   148|#[specta::specta]
   149|pub async fn db_list_connections(
   150|    state: State<'_, AppState>,
   151|) -> Result<Vec<DbConnectionConfig>, String> {
   152|    state.db_connections.list().map_err(|e| e.to_string())
   153|}
   154|
   155|#[tauri::command]
   156|#[specta::specta]
   157|pub async fn db_save_connection(
   158|    state: State<'_, AppState>,
   159|    connection: DbConnectionConfig,
   160|) -> Result<DbConnectionConfig, String> {
   161|    state
   162|        .db_connections
   163|        .save(connection)
   164|        .map_err(|e| e.to_string())
   165|}
   166|
   167|#[tauri::command]
   168|#[specta::specta]
   169|pub async fn db_delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
   170|    state
   171|        .db_connections
   172|        .delete(&id)
   173|        .map_err(|e| e.to_string())?;
   174|    let mut filters = load_schema_filters().map_err(|e| e.to_string())?;
   175|    prune_connection_filters(&mut filters, &id);
   176|    save_schema_filters(&filters).map_err(|e| e.to_string())?;
   177|    Ok(())
   178|}
   179|
   180|#[tauri::command]
   181|#[specta::specta]
   182|pub async fn db_load_schema_filters() -> Result<SchemaFiltersSnapshot, String> {
   183|    load_schema_filters().map_err(|e| e.to_string())
   184|}
   185|
   186|#[tauri::command]
   187|#[specta::specta]
   188|pub async fn db_save_schema_filters(snapshot: SchemaFiltersSnapshot) -> Result<(), String> {
   189|    save_schema_filters(&snapshot).map_err(|e| e.to_string())
   190|}
   191|
   192|#[tauri::command]
   193|#[specta::specta]
   194|pub async fn db_test_connection(connection: DbConnectionConfig) -> Result<String, String> {
   195|    let driver = omnipanel_db::connect(&to_params(&connection))
   196|        .await
   197|        .map_err(err_msg)?;
   198|    driver.version().await.map_err(err_msg)
   199|}
   200|
   201|#[tauri::command]
   202|#[specta::specta]
   203|pub async fn db_list_databases(connection: DbConnectionConfig) -> Result<Vec<String>, String> {
   204|    match connection.db_type.to_lowercase().as_str() {
   205|        "mysql" | "mariadb" => {
   206|            let pool = mysql_pool(&connection).await?;
   207|            let rows = sqlx::query(
   208|                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
   209|                 WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') \
   210|                 ORDER BY SCHEMA_NAME",
   211|            )
   212|            .fetch_all(&pool)
   213|            .await
   214|            .map_err(|e| format!("Query failed: {e}"))?;
   215|            let databases: Vec<String> = rows.iter().map(|r| mysql_row_string(r, 0)).collect();
   216|            pool.close().await;
   217|            Ok(databases)
   218|        }
   219|        _ if !connection.database.trim().is_empty() => Ok(vec![connection.database.clone()]),
   220|        _ => Ok(vec![]),
   221|    }
   222|}
   223|
   224|#[tauri::command]
   225|#[specta::specta]
   226|pub async fn db_introspect_schema(
   227|    connection: DbConnectionConfig,
   228|    schema: Option<String>,
   229|) -> Result<DbIntrospectResult, String> {
   230|    let db_name = schema
   231|        .filter(|name| !name.trim().is_empty())
   232|        .unwrap_or_else(|| connection.database.clone());
   233|    if db_name.trim().is_empty() {
   234|        return Err("未指定数据库".to_string());
   235|    }
   236|
   237|    match connection.db_type.to_lowercase().as_str() {
   238|        "mysql" | "mariadb" => introspect_mysql_schema(&connection, &db_name).await,
   239|        "postgresql" | "postgres" => introspect_pg_schema(&connection, &db_name).await,
   240|        "sqlite" => introspect_sqlite_schema(&connection).await,
   241|        _ => {
   242|            let params = with_schema(&connection, Some(db_name.clone()));
   243|            let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
   244|            let table_names = driver.list_tables().await.map_err(err_msg)?;
   245|            Ok(DbIntrospectResult {
   246|                database: db_name,
   247|                tables: table_names
   248|                    .into_iter()
   249|                    .map(|name| DbTableSchema {
   250|                        name,
   251|                        columns: Vec::new(),
   252|                        indexes: Vec::new(),
   253|                    })
   254|                    .collect(),
   255|            })
   256|        }
   257|    }
   258|}
   259|
   260|#[tauri::command]
   261|#[specta::specta]
   262|pub async fn db_introspect_table(
   263|    connection: DbConnectionConfig,
   264|    schema: Option<String>,
   265|    table: String,
   266|) -> Result<DbTableSchema, String> {
   267|    let db_name = schema
   268|        .filter(|name| !name.trim().is_empty())
   269|        .unwrap_or_else(|| connection.database.clone());
   270|    if db_name.trim().is_empty() {
   271|        return Err("未指定数据库".to_string());
   272|    }
   273|    if table.trim().is_empty() {
   274|        return Err("未指定数据表".to_string());
   275|    }
   276|
   277|    match connection.db_type.to_lowercase().as_str() {
   278|        "mysql" | "mariadb" => introspect_mysql_table(&connection, &db_name, table.trim()).await,
   279|        "postgresql" | "postgres" => introspect_pg_table(&connection, &db_name, table.trim()).await,
   280|        "sqlite" => introspect_sqlite_table(&connection, table.trim()).await,
   281|        _ => Ok(DbTableSchema {
   282|            name: table,
   283|            columns: Vec::new(),
   284|            indexes: Vec::new(),
   285|        }),
   286|    }
   287|}
   288|
   289|async fn introspect_mysql_schema(
   290|    connection: &DbConnectionConfig,
   291|    db_name: &str,
   292|) -> Result<DbIntrospectResult, String> {
   293|    let pool = mysql_pool(connection).await?;
   294|
   295|    let col_rows = sqlx::query(
   296|        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY \
   297|         FROM information_schema.COLUMNS \
   298|         WHERE TABLE_SCHEMA = ? \
   299|         ORDER BY TABLE_NAME, ORDINAL_POSITION",
   300|    )
   301|    .bind(db_name)
   302|    .fetch_all(&pool)
   303|    .await
   304|    .map_err(|e| format!("Query failed: {e}"))?;
   305|
   306|    let idx_rows = sqlx::query(
   307|        "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
   308|         FROM information_schema.STATISTICS \
   309|         WHERE TABLE_SCHEMA = ? \
   310|         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
   311|    )
   312|    .bind(db_name)
   313|    .fetch_all(&pool)
   314|    .await
   315|    .map_err(|e| format!("Query failed: {e}"))?;
   316|    pool.close().await;
   317|
   318|    let mut tables: Vec<DbTableSchema> = Vec::new();
   319|    for row in &col_rows {
   320|        let table_name = mysql_row_string(row, 0);
   321|        let column_name = mysql_row_string(row, 1);
   322|        let data_type = mysql_row_string(row, 2);
   323|        let column_key = mysql_row_string(row, 3);
   324|        let is_pk = column_key == "PRI";
   325|        let is_fk = column_key == "MUL";
   326|
   327|        if let Some(table) = tables.iter_mut().find(|t| t.name == table_name) {
   328|            table.columns.push(DbColumnMeta {
   329|                name: column_name,
   330|                column_type: data_type,
   331|                is_pk,
   332|                is_fk,
   333|            });
   334|        } else {
   335|            tables.push(DbTableSchema {
   336|                name: table_name,
   337|                columns: vec![DbColumnMeta {
   338|                    name: column_name,
   339|                    column_type: data_type,
   340|                    is_pk,
   341|                    is_fk,
   342|                }],
   343|                indexes: Vec::new(),
   344|            });
   345|        }
   346|    }
   347|
   348|    apply_mysql_index_rows(&mut tables, idx_rows);
   349|
   350|    Ok(DbIntrospectResult {
   351|        database: db_name.to_string(),
   352|        tables,
   353|    })
   354|}
   355|
   356|async fn introspect_mysql_table(
   357|    connection: &DbConnectionConfig,
   358|    db_name: &str,
   359|    table_name: &str,
   360|) -> Result<DbTableSchema, String> {
   361|    let pool = mysql_pool(connection).await?;
   362|
   363|    let col_rows = sqlx::query(
   364|        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY \
   365|         FROM information_schema.COLUMNS \
   366|         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
   367|         ORDER BY ORDINAL_POSITION",
   368|    )
   369|    .bind(db_name)
   370|    .bind(table_name)
   371|    .fetch_all(&pool)
   372|    .await
   373|    .map_err(|e| format!("Query failed: {e}"))?;
   374|
   375|    let idx_rows = sqlx::query(
   376|        "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
   377|         FROM information_schema.STATISTICS \
   378|         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
   379|         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
   380|    )
   381|    .bind(db_name)
   382|    .bind(table_name)
   383|    .fetch_all(&pool)
   384|    .await
   385|    .map_err(|e| format!("Query failed: {e}"))?;
   386|    pool.close().await;
   387|
   388|    let columns: Vec<DbColumnMeta> = col_rows
   389|        .iter()
   390|        .map(|row| {
   391|            let column_name = mysql_row_string(row, 0);
   392|            let data_type = mysql_row_string(row, 1);
   393|            let column_key = mysql_row_string(row, 2);
   394|            DbColumnMeta {
   395|                name: column_name,
   396|                column_type: data_type,
   397|                is_pk: column_key == "PRI",
   398|                is_fk: column_key == "MUL",
   399|            }
   400|        })
   401|        .collect();
   402|
   403|    let mut table = DbTableSchema {
   404|        name: table_name.to_string(),
   405|        columns,
   406|        indexes: Vec::new(),
   407|    };
   408|    push_mysql_index_row(&mut table.indexes, idx_rows);
   409|    Ok(table)
   410|}
   411|
   412|fn push_mysql_index_row(indexes: &mut Vec<DbIndexMeta>, idx_rows: Vec<sqlx::mysql::MySqlRow>) {
   413|    for row in &idx_rows {
   414|        let index_name = mysql_row_string(row, 0);
   415|        let column_name = mysql_row_string(row, 1);
   416|        let non_unique = mysql_row_i32(row, 2, 1);
   417|        if index_name == "PRIMARY" {
   418|            continue;
   419|        }
   420|        let unique = non_unique == 0;
   421|        if let Some(index) = indexes.iter_mut().find(|i| i.name == index_name) {
   422|            index.columns.push(column_name);
   423|        } else {
   424|            indexes.push(DbIndexMeta {
   425|                name: index_name,
   426|                columns: vec![column_name],
   427|                unique,
   428|            });
   429|        }
   430|    }
   431|}
   432|
   433|fn apply_mysql_index_rows(tables: &mut [DbTableSchema], idx_rows: Vec<sqlx::mysql::MySqlRow>) {
   434|    for row in &idx_rows {
   435|        let table_name = mysql_row_string(row, 0);
   436|        let index_name = mysql_row_string(row, 1);
   437|        let column_name = mysql_row_string(row, 2);
   438|        let non_unique = mysql_row_i32(row, 3, 1);
   439|        let table = match tables.iter_mut().find(|t| t.name == table_name) {
   440|            Some(t) => t,
   441|            None => continue,
   442|        };
   443|        if index_name == "PRIMARY" {
   444|            continue;
   445|        }
   446|        let unique = non_unique == 0;
   447|        if let Some(index) = table.indexes.iter_mut().find(|i| i.name == index_name) {
   448|            index.columns.push(column_name);
   449|        } else {
   450|            table.indexes.push(DbIndexMeta {
   451|                name: index_name,
   452|                columns: vec![column_name],
   453|                unique,
   454|            });
   455|        }
   456|    }
   457|}
   458|
   459|#[tauri::command]
   460|#[specta::specta]
   461|pub async fn db_list_tables(
   462|    connection: DbConnectionConfig,
   463|    schema: Option<String>,
   464|) -> Result<Vec<String>, String> {
   465|    let params = with_schema(&connection, schema);
   466|    if params.database.trim().is_empty() {
   467|        return Err("未指定数据库".to_string());
   468|    }
   469|    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
   470|    driver.list_tables().await.map_err(err_msg)
   471|}
   472|
   473|#[tauri::command]
   474|pub async fn db_preview_table(
   475|    connection: DbConnectionConfig,
   476|    table: String,
   477|    limit: u32,
   478|    offset: u32,
   479|) -> Result<TableInfo, String> {
   480|    let driver = omnipanel_db::connect(&to_params(&connection))
   481|        .await
   482|        .map_err(err_msg)?;
   483|    let result = driver
   484|        .preview(&table, limit as i64, offset as i64)
   485|        .await
   486|        .map_err(err_msg)?;
   487|    Ok(to_table_info(table, result))
   488|}
   489|
   490|#[tauri::command]
   491|#[specta::specta]
   492|pub async fn db_count_table(
   493|    connection: DbConnectionConfig,
   494|    schema: Option<String>,
   495|    table: String,
   496|) -> Result<i64, String> {
   497|    let params = with_schema(&connection, schema);
   498|    if params.database.trim().is_empty() {
   499|        return Err("未指定数据库".to_string());
   500|    }
   501|
     1|
     2|// ─── PostgreSQL Introspection ────────────────────────────────────────────
     3|
     4|async fn introspect_pg_schema(
     5|    connection: &DbConnectionConfig,
     6|    db_name: &str,
     7|) -> Result<DbIntrospectResult, String> {
     8|    let pool = pg_pool(connection).await?;
     9|
    10|    let col_rows = sqlx::query(
    11|        "SELECT c.table_name, c.column_name, c.data_type, \
    12|         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk \
    13|         FROM information_schema.columns c \
    14|         LEFT JOIN ( \
    15|             SELECT ku.column_name, ku.table_name \
    16|             FROM information_schema.table_constraints tc \
    17|             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
    18|             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' \
    19|         ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name \
    20|         WHERE c.table_schema = 'public' \
    21|         ORDER BY c.table_name, c.ordinal_position",
    22|    )
    23|    .fetch_all(&pool)
    24|    .await
    25|    .map_err(|e| format!("PG columns query failed: {e}"))?;
    26|
    27|    let idx_rows = sqlx::query(
    28|        "SELECT t.relname AS table_name, i.relname AS index_name, \
    29|         a.attname AS column_name, ix.indisunique AS is_unique \
    30|         FROM pg_class t \
    31|         JOIN pg_index ix ON t.oid = ix.indrelid \
    32|         JOIN pg_class i ON i.oid = ix.indexrelid \
    33|         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
    34|         JOIN pg_namespace n ON n.oid = t.relnamespace \
    35|         WHERE n.nspname = 'public' AND NOT ix.indisprimary \
    36|         ORDER BY t.relname, i.relname, a.attnum",
    37|    )
    38|    .fetch_all(&pool)
    39|    .await
    40|    .map_err(|e| format!("PG indexes query failed: {e}"))?;
    41|    pool.close().await;
    42|
    43|    let mut tables: Vec<DbTableSchema> = Vec::new();
    44|    for row in &col_rows {
    45|        let table_name: String = row.try_get(0).unwrap_or_default();
    46|        let column_name: String = row.try_get(1).unwrap_or_default();
    47|        let data_type: String = row.try_get(2).unwrap_or_default();
    48|        let is_pk: bool = row.try_get(3).unwrap_or(false);
    49|
    50|        if let Some(table) = tables.iter_mut().find(|t| t.name == table_name) {
    51|            table.columns.push(DbColumnMeta {
    52|                name: column_name,
    53|                column_type: data_type,
    54|                is_pk,
    55|                is_fk: false,
    56|            });
    57|        } else {
    58|            tables.push(DbTableSchema {
    59|                name: table_name,
    60|                columns: vec![DbColumnMeta {
    61|                    name: column_name,
    62|                    column_type: data_type,
    63|                    is_pk,
    64|                    is_fk: false,
    65|                }],
    66|                indexes: Vec::new(),
    67|            });
    68|        }
    69|    }
    70|
    71|    for row in &idx_rows {
    72|        let table_name: String = row.try_get(0).unwrap_or_default();
    73|        let index_name: String = row.try_get(1).unwrap_or_default();
    74|        let column_name: String = row.try_get(2).unwrap_or_default();
    75|        let is_unique: bool = row.try_get(3).unwrap_or(false);
    76|
    77|        if let Some(table) = tables.iter_mut().find(|t| t.name == table_name) {
    78|            if let Some(index) = table.indexes.iter_mut().find(|i| i.name == index_name) {
    79|                index.columns.push(column_name);
    80|            } else {
    81|                table.indexes.push(DbIndexMeta {
    82|                    name: index_name,
    83|                    columns: vec![column_name],
    84|                    unique: is_unique,
    85|                });
    86|            }
    87|        }
    88|    }
    89|
    90|    Ok(DbIntrospectResult {
    91|        database: db_name.to_string(),
    92|        tables,
    93|    })
    94|}
    95|
    96|async fn introspect_pg_table(
    97|    connection: &DbConnectionConfig,
    98|    db_name: &str,
    99|    table_name: &str,
   100|) -> Result<DbTableSchema, String> {
   101|    let pool = pg_pool(connection).await?;
   102|
   103|    let col_rows = sqlx::query(
   104|        "SELECT c.column_name, c.data_type, \
   105|         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk \
   106|         FROM information_schema.columns c \
   107|         LEFT JOIN ( \
   108|             SELECT ku.column_name \
   109|             FROM information_schema.table_constraints tc \
   110|             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
   111|             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = 'public' \
   112|         ) pk ON c.column_name = pk.column_name \
   113|         WHERE c.table_schema = 'public' AND c.table_name = $1 \
   114|         ORDER BY c.ordinal_position",
   115|    )
   116|    .bind(table_name)
   117|    .fetch_all(&pool)
   118|    .await
   119|    .map_err(|e| format!("PG columns query failed: {e}"))?;
   120|
   121|    let idx_rows = sqlx::query(
   122|        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
   123|         FROM pg_class t \
   124|         JOIN pg_index ix ON t.oid = ix.indrelid \
   125|         JOIN pg_class i ON i.oid = ix.indexrelid \
   126|         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
   127|         JOIN pg_namespace n ON n.oid = t.relnamespace \
   128|         WHERE n.nspname = 'public' AND t.relname = $1 AND NOT ix.indisprimary \
   129|         ORDER BY i.relname, a.attnum",
   130|    )
   131|    .bind(table_name)
   132|    .fetch_all(&pool)
   133|    .await
   134|    .map_err(|e| format!("PG indexes query failed: {e}"))?;
   135|    pool.close().await;
   136|
   137|    let columns: Vec<DbColumnMeta> = col_rows
   138|        .iter()
   139|        .map(|row| {
   140|            let name: String = row.try_get(0).unwrap_or_default();
   141|            let dtype: String = row.try_get(1).unwrap_or_default();
   142|            let is_pk: bool = row.try_get(2).unwrap_or(false);
   143|            DbColumnMeta { name, column_type: dtype, is_pk, is_fk: false }
   144|        })
   145|        .collect();
   146|
   147|    let mut indexes: Vec<DbIndexMeta> = Vec::new();
   148|    for row in &idx_rows {
   149|        let index_name: String = row.try_get(0).unwrap_or_default();
   150|        let column_name: String = row.try_get(1).unwrap_or_default();
   151|        let is_unique: bool = row.try_get(2).unwrap_or(false);
   152|        if let Some(idx) = indexes.iter_mut().find(|i| i.name == index_name) {
   153|            idx.columns.push(column_name);
   154|        } else {
   155|            indexes.push(DbIndexMeta { name: index_name, columns: vec![column_name], unique: is_unique });
   156|        }
   157|    }
   158|
   159|    Ok(DbTableSchema { name: table_name.to_string(), columns, indexes })
   160|}
   161|
   162|// ─── SQLite Introspection ────────────────────────────────────────────────
   163|
   164|async fn introspect_sqlite_schema(
   165|    connection: &DbConnectionConfig,
   166|) -> Result<DbIntrospectResult, String> {
   167|    let path = connection.database.clone();
   168|    tokio::task::spawn_blocking(move || {
   169|        let conn = rusqlite::Connection::open(&path)
   170|            .map_err(|e| format!("SQLite open failed: {e}"))?;
   171|
   172|        let mut stmt = conn
   173|            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
   174|            .map_err(|e| format!("SQLite query failed: {e}"))?;
   175|        let table_names: Vec<String> = stmt
   176|            .query_map([], |row| row.get(0))
   177|            .map_err(|e| format!("SQLite query failed: {e}"))?
   178|            .collect::<Result<Vec<_>, _>>()
   179|            .map_err(|e| format!("SQLite query failed: {e}"))?;
   180|
   181|        let mut tables = Vec::new();
   182|        for tname in &table_names {
   183|            let table = sqlite_introspect_table_inner(&conn, tname)?;
   184|            tables.push(table);
   185|        }
   186|
   187|        Ok(DbIntrospectResult { database: path.clone(), tables })
   188|    })
   189|    .await
   190|    .map_err(|e| format!("SQLite task failed: {e}"))?
   191|}
   192|
   193|async fn introspect_sqlite_table(
   194|    connection: &DbConnectionConfig,
   195|    table_name: &str,
   196|) -> Result<DbTableSchema, String> {
   197|    let path = connection.database.clone();
   198|    let tname = table_name.to_string();
   199|    tokio::task::spawn_blocking(move || {
   200|        let conn = rusqlite::Connection::open(&path)
   201|            .map_err(|e| format!("SQLite open failed: {e}"))?;
   202|        sqlite_introspect_table_inner(&conn, &tname)
   203|    })
   204|    .await
   205|    .map_err(|e| format!("SQLite task failed: {e}"))?
   206|}
   207|
   208|fn sqlite_introspect_table_inner(conn: &rusqlite::Connection, table_name: &str) -> Result<DbTableSchema, String> {
   209|    let safe_name = table_name.replace('\'', "''");
   210|
   211|    // Columns via PRAGMA table_info
   212|    let mut stmt = conn
   213|        .prepare(&format!("PRAGMA table_info('{safe_name}')"))
   214|        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?;
   215|    let columns: Vec<DbColumnMeta> = stmt
   216|        .query_map([], |row| {
   217|            let name: String = row.get(1)?;
   218|            let col_type: String = row.get(2)?;
   219|            let _notnull: i32 = row.get(3)?;
   220|            let pk: i32 = row.get(5)?;
   221|            Ok(DbColumnMeta {
   222|                name,
   223|                column_type: col_type,
   224|                is_pk: pk > 0,
   225|                is_fk: false,
   226|            })
   227|        })
   228|        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?
   229|        .collect::<Result<Vec<_>, _>>()
   230|        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?;
   231|
   232|    // Indexes via PRAGMA index_list
   233|    let mut stmt = conn
   234|        .prepare(&format!("PRAGMA index_list('{safe_name}')"))
   235|        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?;
   236|    let index_entries: Vec<(String, bool)> = stmt
   237|        .query_map([], |row| {
   238|            let name: String = row.get(1)?;
   239|            let unique: i32 = row.get(2)?;
   240|            Ok((name, unique != 0))
   241|        })
   242|        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?
   243|        .collect::<Result<Vec<_>, _>>()
   244|        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?;
   245|
   246|    let mut indexes = Vec::new();
   247|    for (idx_name, unique) in index_entries {
   248|        if idx_name.starts_with("sqlite_autoindex_") {
   249|            continue;
   250|        }
   251|        let safe_idx = idx_name.replace('\'', "''");
   252|        let mut col_stmt = conn
   253|            .prepare(&format!("PRAGMA index_info('{safe_idx}')"))
   254|            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?;
   255|        let idx_columns: Vec<String> = col_stmt
   256|            .query_map([], |row| row.get(2))
   257|            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?
   258|            .collect::<Result<Vec<_>, _>>()
   259|            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?;
   260|
   261|        if !idx_columns.is_empty() {
   262|            indexes.push(DbIndexMeta { name: idx_name, columns: idx_columns, unique });
   263|        }
   264|    }
   265|
   266|    Ok(DbTableSchema { name: table_name.to_string(), columns, indexes })
   267|}
   268|
// ─── PostgreSQL Introspection ────────────────────────────────────────────

async fn introspect_pg_schema(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<DbIntrospectResult, String> {
    let pool = pg_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT c.table_name, c.column_name, c.data_type, \
         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
             SELECT ku.column_name, ku.table_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' \
         ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name \
         WHERE c.table_schema = 'public' \
         ORDER BY c.table_name, c.ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG columns query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT t.relname AS table_name, i.relname AS index_name, \
         a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE n.nspname = 'public' AND NOT ix.indisprimary \
         ORDER BY t.relname, i.relname, a.attnum",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG indexes query failed: {e}"))?;
    pool.close().await;

    let mut tables: Vec<DbTableSchema> = Vec::new();
    for row in &col_rows {
        let table_name: String = row.try_get(0).unwrap_or_default();
        let column_name: String = row.try_get(1).unwrap_or_default();
        let data_type: String = row.try_get(2).unwrap_or_default();
        let is_pk: bool = row.try_get(3).unwrap_or(false);

        if let Some(table) = tables.iter_mut().find(|t| t.name == table_name) {
            table.columns.push(DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk,
                is_fk: false,
            });
        } else {
            tables.push(DbTableSchema {
                name: table_name,
                columns: vec![DbColumnMeta {
                    name: column_name,
                    column_type: data_type,
                    is_pk,
                    is_fk: false,
                }],
                indexes: Vec::new(),
            });
        }
    }

    for row in &idx_rows {
        let table_name: String = row.try_get(0).unwrap_or_default();
        let index_name: String = row.try_get(1).unwrap_or_default();
        let column_name: String = row.try_get(2).unwrap_or_default();
        let is_unique: bool = row.try_get(3).unwrap_or(false);

        if let Some(table) = tables.iter_mut().find(|t| t.name == table_name) {
            if let Some(index) = table.indexes.iter_mut().find(|i| i.name == index_name) {
                index.columns.push(column_name);
            } else {
                table.indexes.push(DbIndexMeta {
                    name: index_name,
                    columns: vec![column_name],
                    unique: is_unique,
                });
            }
        }
    }

    Ok(DbIntrospectResult {
        database: db_name.to_string(),
        tables,
    })
}

async fn introspect_pg_table(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let pool = pg_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT c.column_name, c.data_type, \
         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
             SELECT ku.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = 'public' \
         ) pk ON c.column_name = pk.column_name \
         WHERE c.table_schema = 'public' AND c.table_name = $1 \
         ORDER BY c.ordinal_position",
    )
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG columns query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE n.nspname = 'public' AND t.relname = $1 AND NOT ix.indisprimary \
         ORDER BY i.relname, a.attnum",
    )
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG indexes query failed: {e}"))?;
    pool.close().await;

    let columns: Vec<DbColumnMeta> = col_rows
        .iter()
        .map(|row| {
            let name: String = row.try_get(0).unwrap_or_default();
            let dtype: String = row.try_get(1).unwrap_or_default();
            let is_pk: bool = row.try_get(2).unwrap_or(false);
            DbColumnMeta { name, column_type: dtype, is_pk, is_fk: false }
        })
        .collect();

    let mut indexes: Vec<DbIndexMeta> = Vec::new();
    for row in &idx_rows {
        let index_name: String = row.try_get(0).unwrap_or_default();
        let column_name: String = row.try_get(1).unwrap_or_default();
        let is_unique: bool = row.try_get(2).unwrap_or(false);
        if let Some(idx) = indexes.iter_mut().find(|i| i.name == index_name) {
            idx.columns.push(column_name);
        } else {
            indexes.push(DbIndexMeta { name: index_name, columns: vec![column_name], unique: is_unique });
        }
    }

    Ok(DbTableSchema { name: table_name.to_string(), columns, indexes })
}

// ─── SQLite Introspection ────────────────────────────────────────────────

async fn introspect_sqlite_schema(
    connection: &DbConnectionConfig,
) -> Result<DbIntrospectResult, String> {
    let path = connection.database.clone();
    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&path)
            .map_err(|e| format!("SQLite open failed: {e}"))?;

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(|e| format!("SQLite query failed: {e}"))?;
        let table_names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("SQLite query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("SQLite query failed: {e}"))?;

        let mut tables = Vec::new();
        for tname in &table_names {
            let table = sqlite_introspect_table_inner(&conn, tname)?;
            tables.push(table);
        }

        Ok(DbIntrospectResult { database: path.clone(), tables })
    })
    .await
    .map_err(|e| format!("SQLite task failed: {e}"))?
}

async fn introspect_sqlite_table(
    connection: &DbConnectionConfig,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let path = connection.database.clone();
    let tname = table_name.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&path)
            .map_err(|e| format!("SQLite open failed: {e}"))?;
        sqlite_introspect_table_inner(&conn, &tname)
    })
    .await
    .map_err(|e| format!("SQLite task failed: {e}"))?
}

fn sqlite_introspect_table_inner(conn: &rusqlite::Connection, table_name: &str) -> Result<DbTableSchema, String> {
    let safe_name = table_name.replace('\'', "''");

    // Columns via PRAGMA table_info
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info('{safe_name}')"))
        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?;
    let columns: Vec<DbColumnMeta> = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let col_type: String = row.get(2)?;
            let _notnull: i32 = row.get(3)?;
            let pk: i32 = row.get(5)?;
            Ok(DbColumnMeta {
                name,
                column_type: col_type,
                is_pk: pk > 0,
                is_fk: false,
            })
        })
        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?;

    // Indexes via PRAGMA index_list
    let mut stmt = conn
        .prepare(&format!("PRAGMA index_list('{safe_name}')"))
        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?;
    let index_entries: Vec<(String, bool)> = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let unique: i32 = row.get(2)?;
            Ok((name, unique != 0))
        })
        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?;

    let mut indexes = Vec::new();
    for (idx_name, unique) in index_entries {
        if idx_name.starts_with("sqlite_autoindex_") {
            continue;
        }
        let safe_idx = idx_name.replace('\'', "''");
        let mut col_stmt = conn
            .prepare(&format!("PRAGMA index_info('{safe_idx}')"))
            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?;
        let idx_columns: Vec<String> = col_stmt
            .query_map([], |row| row.get(2))
            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?;

        if !idx_columns.is_empty() {
            indexes.push(DbIndexMeta { name: idx_name, columns: idx_columns, unique });
        }
    }

    Ok(DbTableSchema { name: table_name.to_string(), columns, indexes })
}
