from pathlib import Path

p = Path(r"c:/Users/chaoj/dev/omnipanel/crates/omnipanel-server/src/ipc.rs")
t = p.read_text(encoding="utf-8")
marker = "        other => InvokeResponse::ok(crate::soft_degrade::soft_degrade_value(other)),"
if '"db_get_table_details"' in t:
    print("p2 already registered")
    raise SystemExit(0)
block = r'''
        /* ---------------- P2b/P2c DB introspect / sync / export ---------------- */
        "db_get_table_details" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            let schema = get_str(&args, "schema");
            let table = get_str(&args, "table").unwrap_or_default();
            respond(crate::db::db_get_table_details(connection, schema, table).await)
        }
        "db_table_ddl" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            let schema = get_str(&args, "schema");
            let table = get_str(&args, "table").unwrap_or_default();
            respond(crate::db::db_table_ddl(connection, schema, table).await)
        }
        "db_batch_table_ddl" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            let schema = get_str(&args, "schema");
            let tables: Vec<String> = args.get("tables").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            respond(crate::db_sync::batch_table_ddl(connection, schema, tables).await)
        }
        "db_create_database" => {
            let args_in: crate::db::CreateDatabaseArgs = match serde_json::from_value(args.clone()) {
                Ok(a) => a,
                Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
            };
            respond(crate::db::db_create_database(args_in).await)
        }
        "db_list_character_sets" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            respond(crate::db::db_list_character_sets(connection).await)
        }
        "db_list_connection_users" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            respond(crate::db::db_list_connection_users(connection).await)
        }
        "db_list_databases_with_stats" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            respond(crate::db::db_list_databases_with_stats(connection).await)
        }
        "db_list_table_details" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid connection: {e}")),
            };
            let schema = get_str(&args, "schema");
            respond(crate::db::db_list_table_details(connection, schema).await)
        }
        "db_data_sync_generate_sql" => {
            let source: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid source: {e}")),
            };
            let target: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid target: {e}")),
            };
            let tables = match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                Ok(t) => t,
                Err(e) => return InvokeResponse::err(format!("invalid tables: {e}")),
            };
            respond(crate::db_sync::generate_data_sync_sql_script(source, target, tables).await)
        }
        "db_data_sync_read_sql_file" => {
            let path = get_str(&args, "sqlFilePath").or_else(|| get_str(&args, "path")).unwrap_or_default();
            respond(crate::db_sync::read_sync_sql_file(&path))
        }
        "db_data_sync_write_sql_file" => {
            let sql = get_str(&args, "sql").unwrap_or_default();
            respond(crate::db_sync::save_sync_sql_file(&sql))
        }
        "db_schema_sync_preview_sql" => {
            let source: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid source: {e}")),
            };
            let target: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("invalid target: {e}")),
            };
            let source_db = get_str(&args, "sourceDb").unwrap_or_default();
            let target_db = get_str(&args, "targetDb").unwrap_or_default();
            let tables = match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                Ok(t) => t,
                Err(e) => return InvokeResponse::err(format!("invalid tables: {e}")),
            };
            let create_missing = args.get("createMissingTables").and_then(|v| v.as_bool()).unwrap_or(true);
            respond(crate::db_sync::preview_schema_sync_sql(source, target, source_db, target_db, tables, create_missing).await)
        }
        "db_sync_row_diff_page" => {
            let cache_id = get_str(&args, "cacheId").unwrap_or_default();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as u32;
            let kinds = args.get("kinds").and_then(|v| serde_json::from_value(v.clone()).ok());
            respond(crate::db_sync_diff::db_sync_row_diff_page(cache_id, offset, limit, kinds).await)
        }
        "db_mysql_export_list" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::db_mysql_export::list_mysql_exports(&connection_id))
        }
        "db_mysql_export_delete" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let export_id = get_str(&args, "exportId").unwrap_or_default();
            respond(crate::db_mysql_export::delete_mysql_export(&connection_id, &export_id))
        }
        "db_mysql_export_save_as" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let export_id = get_str(&args, "exportId").unwrap_or_default();
            let dest_path = get_str(&args, "destPath").unwrap_or_default();
            respond(crate::db_mysql_export::copy_mysql_export_file(&connection_id, &export_id, &dest_path))
        }
        "db_qdrant_delete_points" => {
            let args_in: crate::db::QdrantDeletePointsArgs = match serde_json::from_value(args.clone()) {
                Ok(a) => a,
                Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
            };
            respond(crate::db::db_qdrant_delete_points(state, args_in).await)
        }

'''
if marker not in t:
    raise SystemExit("marker missing")
p.write_text(t.replace(marker, block + marker, 1), encoding="utf-8")
print("inserted p2 ipc")
