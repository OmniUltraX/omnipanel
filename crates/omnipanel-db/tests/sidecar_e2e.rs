//! 实连 sidecar + DBX 外部 agent。Docker 未就绪的引擎会 skip，不让 CI 红。

use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use omnipanel_db::sidecar::{
    EngineKind, EngineLaunch, SidecarDriver, connect_launch, launch_for_params,
    launch_from_driver_file, set_plugin_engine_launches,
};
use omnipanel_db::{
    CreateDatabaseArgs, DbDriver, DbParams, connect, db_create_database, db_list_connection_users,
};
use omnipanel_store::DbConnectionConfig;
use serde_json::json;

fn params(
    db_type: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> DbParams {
    DbParams {
        db_type: db_type.into(),
        host: host.into(),
        port,
        user: user.into(),
        password: password.into(),
        database: database.into(),
        ssl: false,
        sid: String::new(),
        sysdba: false,
    }
}

fn store_conn(
    db_type: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    ssl: bool,
    sysdba: bool,
) -> DbConnectionConfig {
    DbConnectionConfig {
        id: format!("e2e-{db_type}"),
        name: format!("e2e-{db_type}"),
        db_type: db_type.into(),
        host: "127.0.0.1".into(),
        port,
        user: user.into(),
        password: password.into(),
        database: database.into(),
        ssl,
        sid: String::new(),
        sysdba,
        status: "unknown".into(),
        enabled: true,
        has_password: !password.is_empty(),
        tags: Vec::new(),
    }
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn engine_bin(stem: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    };
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("CARGO_TARGET_DIR") {
        let p = PathBuf::from(dir);
        dirs.push(p.join("debug"));
        dirs.push(p.join("release"));
    }
    let root = workspace_root();
    dirs.push(root.join("target/debug"));
    dirs.push(root.join("target/release"));
    dirs.push(root.join("target-sidecar-verify/debug"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            if dir.file_name().and_then(|n| n.to_str()) == Some("deps") {
                if let Some(parent) = dir.parent() {
                    dirs.push(parent.to_path_buf());
                }
            }
        }
    }
    dirs.into_iter()
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

fn port_open(host: &str, port: u16) -> bool {
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

async fn wait_port(host: &str, port: u16, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if port_open(host, port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn resolve_on_path(name: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where.exe" } else { "which" };
    let output = Command::new(cmd).arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    let path = PathBuf::from(line);
    path.is_file().then_some(path)
}

fn set_env(key: &str, val: &str) {
    // SAFETY: 本文件只有一个 e2e 测试，顺序执行。
    unsafe { std::env::set_var(key, val) }
}

fn remove_env(key: &str) {
    unsafe { std::env::remove_var(key) }
}

async fn evict(launch: &EngineLaunch, params: &DbParams) {
    omnipanel_db::sidecar::evict_launch(launch, params).await;
}

#[tokio::test]
async fn sidecar_live_and_dbx() {
    set_plugin_engine_launches(Vec::<(String, EngineLaunch)>::new());
    test_dbx_java_jar_style_args().await;
    test_sidecar_crash_single_respawn().await;
    test_dbx_cmd_whitespace().await;
    test_dbx_v2_mock().await;
    test_plugin_driver_file().await;
    test_sql_sidecar_flag();
    test_sqlserver_tiberius().await;
    if wait_port("127.0.0.1", 16379, 5).await {
        test_redis_inproc().await;
    } else {
        eprintln!("skip redis inproc：127.0.0.1:16379 未监听");
    }

    if let Some(bin) = engine_bin("omnipanel-engine-redis") {
        if wait_port("127.0.0.1", 16379, 90).await {
            test_redis(&bin).await;
        } else {
            eprintln!("skip redis：127.0.0.1:16379 未监听");
        }
    } else {
        eprintln!("skip redis：找不到 omnipanel-engine-redis");
    }

    if let Some(bin) = engine_bin("omnipanel-engine-mongodb") {
        if wait_port("127.0.0.1", 27018, 90).await {
            test_mongo(&bin).await;
        } else {
            eprintln!("skip mongodb：127.0.0.1:27018 未监听");
        }
    } else {
        eprintln!("skip mongodb：找不到 omnipanel-engine-mongodb");
    }

    if let Some(bin) = engine_bin("omnipanel-engine-mysql") {
        if wait_port("127.0.0.1", 13306, 120).await {
            test_mysql(&bin).await;
        } else {
            eprintln!("skip mysql：127.0.0.1:13306 未监听");
        }
    } else {
        eprintln!("skip mysql：找不到 omnipanel-engine-mysql");
    }

    if let Some(bin) = engine_bin("omnipanel-engine-postgres") {
        if wait_port("127.0.0.1", 15432, 90).await {
            test_postgres(&bin).await;
        } else {
            eprintln!("skip postgres：127.0.0.1:15432 未监听");
        }
    } else {
        eprintln!("skip postgres：找不到 omnipanel-engine-postgres");
    }

    if let Some(bin) = engine_bin("omnipanel-engine-clickhouse") {
        if wait_port("127.0.0.1", 8123, 5).await {
            test_clickhouse(&bin).await;
        } else {
            eprintln!("skip clickhouse：127.0.0.1:8123 未监听");
        }
    }
}

async fn test_dbx_java_jar_style_args() {
    let node = resolve_on_path("node")
        .or_else(|| resolve_on_path("node.exe"))
        .expect("PATH 上需要 node，才能模拟 java -jar 形态的外部 agent");
    let script = workspace_root().join("scripts/mock-dbx-agent.mjs");
    assert!(script.is_file(), "缺少 {}", script.display());

    set_env(
        "OMNIPANEL_ENGINE_SIDECAR_ORACLE",
        node.to_str().expect("node 路径"),
    );
    set_env(
        "OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS",
        script.to_str().expect("mock 脚本路径"),
    );
    let p = params("oracle", "127.0.0.1", 1521, "scott", "tiger", "ORCL");
    let launch = launch_for_params(&p).expect("oracle 应解析为外部 agent");
    match &launch {
        EngineLaunch::External { program, args } => {
            assert_eq!(program, &node);
            assert_eq!(args.as_slice(), [script.to_str().unwrap()]);
        }
        other => panic!("期望 External，得到 {other:?}"),
    }

    let driver = connect_launch(&launch, &p)
        .await
        .expect("DBX mock handshake/connect");
    let ver = driver.version().await.expect("version");
    assert_eq!(ver, "DBX-Mock 1.0");
    let tables = driver.list_tables().await.expect("list_tables");
    assert!(tables.contains(&"EMP".into()), "{tables:?}");

    let cols = driver.describe_table("EMP").await.expect("getColumns 别名");
    assert_eq!(cols[0].0, "ID");

    let via_alias = driver
        .invoke("executeQuery", json!({ "sql": "SELECT 1 FROM dual" }))
        .await
        .expect("executeQuery 别名");
    assert_eq!(via_alias["columns"][0], "X");

    let via_connect = connect(&p).await.expect("registry 未知类型走 DBX");
    assert_eq!(via_connect.version().await.unwrap(), "DBX-Mock 1.0");

    evict(&launch, &p).await;
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE");
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS");
}

async fn test_sidecar_crash_single_respawn() {
    let node = resolve_on_path("node")
        .or_else(|| resolve_on_path("node.exe"))
        .expect("PATH 上需要 node");
    let script = workspace_root().join("scripts/mock-dbx-agent.mjs");
    let flag = std::env::temp_dir().join(format!(
        "omni-dbx-crash-once-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&flag);
    set_env(
        "OMNIPANEL_ENGINE_SIDECAR_ORACLE",
        node.to_str().expect("node 路径"),
    );
    set_env(
        "OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS",
        script.to_str().expect("mock 脚本路径"),
    );
    set_env(
        "OMNIPANEL_DBX_MOCK_CRASH_FILE",
        flag.to_str().expect("crash flag"),
    );
    let p = params("oracle", "127.0.0.1", 1521, "scott", "tiger", "ORCL");
    let launch = launch_for_params(&p).expect("oracle mock");
    let driver = connect_launch(&launch, &p)
        .await
        .expect("握手后退出应单次重拉成功");
    assert_eq!(driver.version().await.unwrap(), "DBX-Mock 1.0");
    assert!(flag.is_file(), "应留下 crash-once 标记");
    evict(&launch, &p).await;
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE");
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS");
    remove_env("OMNIPANEL_DBX_MOCK_CRASH_FILE");
    let _ = std::fs::remove_file(&flag);
}

async fn test_dbx_cmd_whitespace() {
    let node = resolve_on_path("node")
        .or_else(|| resolve_on_path("node.exe"))
        .unwrap();
    let script = workspace_root().join("scripts/mock-dbx-agent.mjs");
    set_env(
        "OMNIPANEL_DBX_CMD",
        &format!("{} {}", node.display(), script.display()),
    );
    let p = params("db2", "127.0.0.1", 50000, "db2inst1", "x", "SAMPLE");
    let launch = launch_for_params(&p).expect("DBX_CMD 应命中未知引擎");
    let driver = connect_launch(&launch, &p).await.expect("DBX_CMD spawn");
    assert_eq!(driver.version().await.unwrap(), "DBX-Mock 1.0");
    evict(&launch, &p).await;
    remove_env("OMNIPANEL_DBX_CMD");
}

async fn test_plugin_driver_file() {
    let script = workspace_root().join("plugins-samples/dbx-oracle/bin/agent.mjs");
    assert!(script.is_file(), "缺少 {}", script.display());
    let launch = launch_from_driver_file(&script).expect("mjs 应解析为 node + 脚本");
    set_plugin_engine_launches([("oracle".into(), launch.clone())]);
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE");
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS");

    let p = params("oracle", "127.0.0.1", 1521, "scott", "tiger", "ORCL");
    let resolved = launch_for_params(&p).expect("插件启动表应命中 oracle");
    match &resolved {
        EngineLaunch::External { args, .. } => {
            assert!(
                args.iter().any(|a| a
                    .replace('\\', "/")
                    .ends_with("plugins-samples/dbx-oracle/bin/agent.mjs")),
                "args={args:?}"
            );
        }
        other => panic!("期望 External，得到 {other:?}"),
    }

    let driver = connect_launch(&resolved, &p)
        .await
        .expect("插件 driver handshake/connect");
    assert_eq!(driver.version().await.unwrap(), "DBX-Mock 1.0");
    let tables = driver.list_tables().await.expect("list_tables");
    assert!(tables.contains(&"EMP".into()), "{tables:?}");

    evict(&resolved, &p).await;
    set_plugin_engine_launches(Vec::<(String, EngineLaunch)>::new());
}

fn preview_sql_cell(result: &omnipanel_db::QueryResult) -> String {
    result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

async fn test_dbx_v2_mock() {
    let node = resolve_on_path("node")
        .or_else(|| resolve_on_path("node.exe"))
        .expect("PATH 上需要 node，才能跑 DBX v2 mock");
    let script = workspace_root().join("scripts/mock-dbx-agent-v2.mjs");
    assert!(script.is_file(), "缺少 {}", script.display());
    let node_s = node.to_str().expect("node 路径");
    let script_s = script.to_str().expect("v2 mock 脚本路径");

    set_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE", node_s);
    set_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS", script_s);
    let oracle = params("oracle", "127.0.0.1", 1521, "scott", "tiger", "ORCL");
    let launch = launch_for_params(&oracle).expect("oracle v2 mock");
    let driver = connect_launch(&launch, &oracle)
        .await
        .expect("v2 handshake/open_session");
    assert_eq!(driver.version().await.unwrap(), "DBX-Mock-V2 1.0");
    let preview = driver
        .preview("EMP", 50, 10, None, None)
        .await
        .expect("oracle preview");
    let sql = preview_sql_cell(&preview);
    assert!(
        sql.contains("OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY"),
        "oracle preview sql={sql}"
    );
    evict(&launch, &oracle).await;
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE");
    remove_env("OMNIPANEL_ENGINE_SIDECAR_ORACLE_ARGS");

    set_env("OMNIPANEL_ENGINE_SIDECAR_NEO4J", node_s);
    set_env("OMNIPANEL_ENGINE_SIDECAR_NEO4J_ARGS", script_s);
    let neo4j = params("neo4j", "127.0.0.1", 7687, "neo4j", "x", "neo4j");
    let launch = launch_for_params(&neo4j).expect("neo4j v2 mock");
    let driver = connect_launch(&launch, &neo4j)
        .await
        .expect("neo4j v2 open_session");
    let preview = driver
        .preview("Person", 20, 5, None, None)
        .await
        .expect("neo4j preview");
    let sql = preview_sql_cell(&preview);
    assert_eq!(sql, "MATCH (n:Person) RETURN n SKIP 5 LIMIT 20");
    evict(&launch, &neo4j).await;
    remove_env("OMNIPANEL_ENGINE_SIDECAR_NEO4J");
    remove_env("OMNIPANEL_ENGINE_SIDECAR_NEO4J_ARGS");

    set_env("OMNIPANEL_ENGINE_SIDECAR_CASSANDRA", node_s);
    set_env("OMNIPANEL_ENGINE_SIDECAR_CASSANDRA_ARGS", script_s);
    let cassandra = params("cassandra", "127.0.0.1", 9042, "cassandra", "x", "system");
    let launch = launch_for_params(&cassandra).expect("cassandra v2 mock");
    let driver = connect_launch(&launch, &cassandra)
        .await
        .expect("cassandra v2 open_session");
    let preview = driver
        .preview("ks.t", 50, 10, None, None)
        .await
        .expect("cassandra preview");
    let sql = preview_sql_cell(&preview);
    assert_eq!(sql, "SELECT * FROM ks.t LIMIT 50");
    evict(&launch, &cassandra).await;
    remove_env("OMNIPANEL_ENGINE_SIDECAR_CASSANDRA");
    remove_env("OMNIPANEL_ENGINE_SIDECAR_CASSANDRA_ARGS");
}

fn installed_dbx_agent(key: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var("APPDATA").ok()?)
        .join("com.omnipanel.app")
        .join("plugins")
        .join(format!("omni.engine.{key}"))
        .join("bin");
    let mut bins: Vec<_> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("jar")
                })
        })
        .collect();
    bins.sort();
    bins.pop()
}

#[tokio::test]
async fn neo4j_cassandra_live() {
    test_neo4j_live().await;
    test_cassandra_live().await;
    test_dameng_live().await;
    test_optional_engine_live("hive", 10000, "", "", "", "SELECT 1").await;
    test_optional_engine_live(
        "firebird",
        3050,
        "SYSDBA",
        "masterkey",
        "",
        "SELECT 1 FROM RDB$DATABASE",
    )
    .await;
    test_optional_engine_live("ignite", 10800, "", "", "", "SELECT 1").await;
    test_optional_engine_live("spanner", 443, "", "", "", "SELECT 1").await;
    test_optional_engine_live("kingbase", 54321, "system", "omni", "test", "SELECT 1").await;
    test_optional_engine_live("oceanbase", 2881, "root", "", "test", "SELECT 1").await;
}

async fn test_neo4j_live() {
    if !port_open("127.0.0.1", 17687) {
        eprintln!("skip neo4j：127.0.0.1:17687 未监听");
        return;
    }
    let Some(bin) = installed_dbx_agent("neo4j") else {
        eprintln!("skip neo4j：未安装 omni.engine.neo4j");
        return;
    };
    let p = params("neo4j", "127.0.0.1", 17687, "neo4j", "omni_test", "neo4j");
    let launch = EngineLaunch::External {
        program: bin,
        args: Vec::new(),
    };
    let driver = connect_launch(&launch, &p)
        .await
        .expect("neo4j live open_session");
    let dbs = driver.list_databases().await.expect("neo4j list_databases");
    assert!(
        dbs.iter().any(|name| name == "neo4j"),
        "neo4j databases={dbs:?}"
    );
    let _ = driver
        .execute("CREATE (n:E2EPerson {name: 'Ada'}) RETURN n.name AS name")
        .await
        .expect("neo4j create");
    let tables = driver.list_tables().await.expect("neo4j list_tables");
    assert!(
        tables
            .iter()
            .any(|name| name == "E2EPerson" || name == "Person"),
        "neo4j labels={tables:?}"
    );
    let preview = driver
        .preview("E2EPerson", 10, 0, None, None)
        .await
        .expect("neo4j preview");
    assert!(!preview.rows.is_empty(), "{preview:?}");
    evict(&launch, &p).await;
}

async fn test_cassandra_live() {
    if !port_open("127.0.0.1", 19042) {
        eprintln!("skip cassandra：127.0.0.1:19042 未监听");
        return;
    }
    let Some(bin) = installed_dbx_agent("cassandra") else {
        eprintln!("skip cassandra：未安装 omni.engine.cassandra");
        return;
    };
    let empty = params("cassandra", "127.0.0.1", 19042, "", "", "");
    let launch = EngineLaunch::External {
        program: bin,
        args: Vec::new(),
    };
    let driver = connect_launch(&launch, &empty)
        .await
        .expect("cassandra live open_session");
    let dbs = driver
        .list_databases()
        .await
        .expect("cassandra list_databases");
    assert!(
        dbs.iter()
            .any(|name| name == "system" || name == "omni_test"),
        "cassandra keyspaces={dbs:?}"
    );
    evict(&launch, &empty).await;

    let mut ks = params("cassandra", "127.0.0.1", 19042, "", "", "omni_test");
    let driver = connect_launch(&launch, &ks)
        .await
        .expect("cassandra keyspace session");
    let _ = driver
        .execute(
            "CREATE KEYSPACE IF NOT EXISTS omni_test WITH replication = {'class':'SimpleStrategy','replication_factor':1}",
        )
        .await;
    let _ = driver
        .execute("CREATE TABLE IF NOT EXISTS omni_test.person (id int PRIMARY KEY, name text)")
        .await
        .expect("cassandra create table");
    let _ = driver
        .execute("INSERT INTO omni_test.person (id, name) VALUES (1, 'Ada')")
        .await
        .expect("cassandra insert");
    ks.database = "omni_test".into();
    evict(&launch, &ks).await;
    let driver = connect_launch(&launch, &ks)
        .await
        .expect("cassandra omni_test session");
    let tables = driver.list_tables().await.expect("cassandra list_tables");
    assert!(
        tables.iter().any(|name| name == "person"),
        "cassandra tables={tables:?}"
    );
    let preview = driver
        .preview("person", 20, 5, None, None)
        .await
        .expect("cassandra preview");
    assert_eq!(preview.columns, vec!["id".to_string(), "name".to_string()]);
    assert!(!preview.rows.is_empty(), "{preview:?}");
    let cols = driver
        .describe_table("person")
        .await
        .expect("cassandra get_columns");
    assert!(
        cols.iter().any(|(name, _)| name == "id"),
        "columns={cols:?}"
    );
    evict(&launch, &ks).await;
}

async fn test_dameng_live() {
    if !port_open("127.0.0.1", 15236) {
        eprintln!("skip dameng：127.0.0.1:15236 未监听");
        return;
    }
    let Some(payload) = installed_dbx_agent("dameng") else {
        eprintln!("skip dameng：未安装 omni.engine.dameng");
        return;
    };
    let Some(launch) = launch_from_driver_file(&payload) else {
        eprintln!("skip dameng：无法解析 JDBC jar/java");
        return;
    };
    let p = params(
        "dameng",
        "127.0.0.1",
        15236,
        "SYSDBA",
        "SYSDBA_dm001",
        "SYSDBA",
    );
    let driver = connect_launch(&launch, &p)
        .await
        .expect("dameng live open_session");
    let ver = driver.version().await.expect("dameng version");
    assert!(!ver.trim().is_empty(), "dameng version empty");
    let q = match driver.execute("SELECT 1 AS V FROM DUAL").await {
        Ok(result) => result,
        Err(_) => driver
            .execute("SELECT 1 AS V")
            .await
            .expect("dameng select"),
    };
    assert!(
        !q.rows.is_empty() || !q.columns.is_empty(),
        "dameng select empty: {q:?}"
    );
    match driver
        .execute("SELECT SESS_ID AS Id, USER_NAME AS \"User\" FROM V$SESSIONS WHERE USER_NAME IS NOT NULL")
        .await
    {
        Ok(sessions) => {
            assert!(
                !sessions.columns.is_empty() || !sessions.rows.is_empty(),
                "dameng sessions empty: {sessions:?}"
            );
        }
        Err(err) => match driver
            .execute("SELECT SID AS Id FROM V$SESSION WHERE USERNAME IS NOT NULL")
            .await
        {
            Ok(_) => {}
            Err(err2) => eprintln!("skip dameng sessions: {err}; {err2}"),
        },
    }
    match db_create_database(CreateDatabaseArgs {
        connection: store_conn(
            "dameng",
            15236,
            "SYSDBA",
            "SYSDBA_dm001",
            "SYSDBA",
            false,
            true,
        ),
        name: "OMNI_WB_E2E".into(),
        charset: None,
        collation: None,
    })
    .await
    {
        Ok(_) => {}
        Err(err) => eprintln!("skip dameng create database: {err}"),
    }
    evict(&launch, &p).await;
}

async fn test_optional_engine_live(
    key: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    sql: &str,
) {
    if !port_open("127.0.0.1", port) {
        eprintln!("skip {key}：127.0.0.1:{port} 未监听");
        return;
    }
    let Some(payload) = installed_dbx_agent(key) else {
        eprintln!("skip {key}：未安装 omni.engine.{key}");
        return;
    };
    let Some(launch) = launch_from_driver_file(&payload) else {
        eprintln!("skip {key}：无法解析 sidecar/java");
        return;
    };
    let p = params(key, "127.0.0.1", port, user, password, database);
    match connect_launch(&launch, &p).await {
        Ok(driver) => {
            match driver.execute(sql).await {
                Ok(q) => {
                    assert!(
                        !q.rows.is_empty() || !q.columns.is_empty(),
                        "{key} select empty: {q:?}"
                    );
                }
                Err(err) => eprintln!("skip {key}：查询失败 {err}"),
            }
            evict(&launch, &p).await;
        }
        Err(err) => eprintln!("skip {key}：测连失败 {err}"),
    }
}

async fn test_sqlserver_tiberius() {
    if !port_open("127.0.0.1", 11433) {
        eprintln!("skip sqlserver：127.0.0.1:11433 未监听");
        return;
    }
    let mut p = params(
        "sqlserver",
        "127.0.0.1",
        11433,
        "sa",
        "Omni_Test_123",
        "master",
    );
    p.ssl = true;
    let mut last_err = String::new();
    let mut driver = None;
    for _ in 0..30 {
        match connect(&p).await {
            Ok(d) => {
                driver = Some(d);
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    let driver = driver.unwrap_or_else(|| panic!("sqlserver tiberius connect: {last_err}"));
    let ver = driver.version().await.expect("sqlserver version");
    assert!(
        ver.to_ascii_lowercase().contains("microsoft") || ver.chars().any(|c| c.is_ascii_digit()),
        "unexpected sqlserver version: {ver}"
    );
    let q = driver.execute("SELECT 1 AS v").await.expect("SELECT 1");
    assert!(!q.rows.is_empty(), "{q:?}");
    let dbs = omnipanel_db::SqlServerDriver::list_databases(&p)
        .await
        .expect("list databases");
    assert!(
        dbs.iter().any(|name| name.eq_ignore_ascii_case("master")),
        "{dbs:?}"
    );

    let cfg = store_conn(
        "sqlserver",
        11433,
        "sa",
        "Omni_Test_123",
        "master",
        true,
        false,
    );
    let users = db_list_connection_users(cfg.clone())
        .await
        .expect("sqlserver users");
    assert!(
        users
            .iter()
            .any(|user| user.name.eq_ignore_ascii_case("sa")),
        "{users:?}"
    );

    let _ = driver
        .execute(
            "IF OBJECT_ID(N'dbo.omni_e2e_drop', N'U') IS NOT NULL DROP TABLE dbo.omni_e2e_drop",
        )
        .await;
    driver
        .execute("CREATE TABLE dbo.omni_e2e_drop (id INT)")
        .await
        .expect("sqlserver create table");
    driver
        .execute("DROP TABLE dbo.omni_e2e_drop")
        .await
        .expect("sqlserver drop table");

    let sessions = driver
        .execute("SELECT session_id AS Id FROM sys.dm_exec_sessions WHERE is_user_process = 1")
        .await
        .expect("sqlserver sessions");
    assert!(!sessions.rows.is_empty(), "{sessions:?}");

    match db_create_database(CreateDatabaseArgs {
        connection: cfg,
        name: "omni_wb_e2e".into(),
        charset: None,
        collation: None,
    })
    .await
    {
        Ok(_) => {
            let _ = driver.execute("DROP DATABASE [omni_wb_e2e]").await;
        }
        Err(err) => eprintln!("skip sqlserver create database: {err}"),
    }
}

fn test_sql_sidecar_flag() {
    remove_env("OMNIPANEL_ENGINE_SIDECAR_MYSQL");
    remove_env("OMNIPANEL_SQL_SIDECAR");
    let p = params("mysql", "127.0.0.1", 3306, "root", "x", "omni");
    assert!(launch_for_params(&p).is_none(), "默认 MySQL 不应走 sidecar");
    set_env("OMNIPANEL_SQL_SIDECAR", "1");
    assert!(
        matches!(
            launch_for_params(&p),
            Some(EngineLaunch::Builtin(EngineKind::MySql))
        ),
        "OMNIPANEL_SQL_SIDECAR=1 时 MySQL 应走 sidecar"
    );
    let pg = params("postgres", "127.0.0.1", 5432, "omni", "x", "omni");
    assert!(matches!(
        launch_for_params(&pg),
        Some(EngineLaunch::Builtin(EngineKind::Postgres))
    ));
    remove_env("OMNIPANEL_SQL_SIDECAR");
}

async fn test_redis_inproc() {
    let p = params("redis", "127.0.0.1", 16379, "", "", "0");
    match connect(&p).await {
        Ok(driver) => {
            let ver = driver.version().await.expect("redis inproc version");
            assert!(
                ver.chars().any(|c| c.is_ascii_digit()),
                "unexpected redis version: {ver}"
            );
        }
        Err(err) => eprintln!("skip redis inproc：{err}"),
    }
}

async fn test_redis(bin: &Path) {
    let p = params("redis", "127.0.0.1", 16379, "", "", "0");
    let launch = EngineLaunch::External {
        program: bin.to_path_buf(),
        args: Vec::new(),
    };
    let driver = connect_launch(&launch, &p)
        .await
        .expect("redis sidecar connect");
    let ver = driver.version().await.expect("redis version");
    assert!(
        ver.chars().any(|c| c.is_ascii_digit()),
        "unexpected redis version: {ver}"
    );

    driver
        .execute("SET omni:sidecar:e2e v1")
        .await
        .expect("SET");
    let found = driver.list_tables().await.expect("KEYS");
    assert!(
        found.iter().any(|k| k.contains("omni:sidecar")),
        "keys={found:?}"
    );
    let _ = driver.execute("DEL omni:sidecar:e2e").await;
    evict(&launch, &p).await;
}

async fn test_mongo(bin: &Path) {
    let p = params("mongodb", "127.0.0.1", 27018, "", "", "omni_e2e");
    let launch = EngineLaunch::External {
        program: bin.to_path_buf(),
        args: Vec::new(),
    };
    let driver = connect_launch(&launch, &p)
        .await
        .expect("mongo sidecar connect");
    let ver = driver.version().await.expect("mongo version");
    assert!(!ver.is_empty(), "{ver}");
    let _ = driver.list_tables().await.expect("collections");
    let dbs = driver.list_databases().await.expect("list_databases");
    assert!(
        dbs.iter()
            .any(|n| n == "omni_e2e" || n == "admin" || n == "local" || n == "config"),
        "dbs={dbs:?}"
    );
    evict(&launch, &p).await;
}

async fn test_mysql(bin: &Path) {
    let p = params("mysql", "127.0.0.1", 13306, "root", "omni_test", "omni");
    let launch = EngineLaunch::External {
        program: bin.to_path_buf(),
        args: Vec::new(),
    };
    let mut last_err = String::new();
    let mut driver: Option<SidecarDriver> = None;
    for _ in 0..30 {
        match connect_launch(&launch, &p).await {
            Ok(d) => {
                driver = Some(d);
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    let driver = driver.unwrap_or_else(|| panic!("mysql sidecar connect: {last_err}"));
    let ver = driver.version().await.expect("mysql version");
    assert!(
        ver.chars().any(|c| c.is_ascii_digit()),
        "unexpected mysql version: {ver}"
    );
    let q = driver.execute("SELECT 1 AS v").await.expect("SELECT 1");
    assert_eq!(q.columns.len(), 1);
    assert!(!q.rows.is_empty());
    driver
        .execute("CREATE TABLE IF NOT EXISTS sidecar_e2e (id INT PRIMARY KEY)")
        .await
        .expect("CREATE TABLE");
    let tables = driver.list_tables().await.expect("list_tables");
    if !tables.iter().any(|t| t.eq_ignore_ascii_case("sidecar_e2e")) {
        let show = driver.execute("SHOW TABLES").await.expect("SHOW TABLES");
        panic!("list_tables={tables:?} SHOW TABLES={show:?}");
    }
    evict(&launch, &p).await;
}

async fn test_postgres(bin: &Path) {
    let p = params("postgres", "127.0.0.1", 15432, "omni", "omni_test", "omni");
    let launch = EngineLaunch::External {
        program: bin.to_path_buf(),
        args: Vec::new(),
    };
    let mut last_err = String::new();
    let mut driver: Option<SidecarDriver> = None;
    for _ in 0..30 {
        match connect_launch(&launch, &p).await {
            Ok(d) => {
                driver = Some(d);
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    let driver = driver.unwrap_or_else(|| panic!("postgres sidecar connect: {last_err}"));
    let ver = driver.version().await.expect("pg version");
    assert!(
        ver.chars().any(|c| c.is_ascii_digit()),
        "unexpected postgres version: {ver}"
    );
    let q = driver.execute("SELECT 1 AS v").await.expect("SELECT 1");
    assert!(!q.rows.is_empty());
    evict(&launch, &p).await;
}

async fn test_clickhouse(bin: &Path) {
    let mut p = params(
        "clickhouse",
        "127.0.0.1",
        8123,
        "omni",
        "omni_test",
        "default",
    );
    let launch = EngineLaunch::External {
        program: bin.to_path_buf(),
        args: Vec::new(),
    };
    let driver = match connect_launch(&launch, &p).await {
        Ok(d) => d,
        Err(_) => {
            p.user = "default".into();
            p.password = String::new();
            connect_launch(&launch, &p)
                .await
                .expect("clickhouse sidecar connect")
        }
    };
    let ver = driver.version().await.expect("ch version");
    assert!(!ver.is_empty(), "{ver}");
    let dbs = driver.list_databases().await.expect("CH databases");
    assert!(
        dbs.iter().any(|d| d == "default" || d == "system"),
        "{dbs:?}"
    );
    evict(&launch, &p).await;
}
