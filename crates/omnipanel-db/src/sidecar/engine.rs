//! 第一方 sidecar 引擎种类 + DBX/外部 agent 启动描述。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::DbParams;

const JRE_MISSING: &str = "未找到捆绑 JRE，请重新安装该引擎";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineKind {
    ClickHouse,
    MongoDb,
    Redis,
    MySql,
    Postgres,
}

impl EngineKind {
    pub fn from_db_type(db_type: &str) -> Option<Self> {
        match db_type.to_ascii_lowercase().as_str() {
            "clickhouse" | "ch" => Some(Self::ClickHouse),
            "mongodb" | "mongo" => Some(Self::MongoDb),
            "redis" => Some(Self::Redis),
            "mysql" | "mariadb" => Some(Self::MySql),
            "postgres" | "postgresql" | "pg" => Some(Self::Postgres),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClickHouse => "clickhouse",
            Self::MongoDb => "mongodb",
            Self::Redis => "redis",
            Self::MySql => "mysql",
            Self::Postgres => "postgres",
        }
    }

    pub fn bin_stem(self) -> &'static str {
        match self {
            Self::ClickHouse => "omnipanel-engine-clickhouse",
            Self::MongoDb => "omnipanel-engine-mongodb",
            Self::Redis => "omnipanel-engine-redis",
            Self::MySql => "omnipanel-engine-mysql",
            Self::Postgres => "omnipanel-engine-postgres",
        }
    }

    pub fn crate_name(self) -> &'static str {
        self.bin_stem()
    }

    pub fn plugin_id(self) -> &'static str {
        match self {
            Self::ClickHouse => "omni.engine.clickhouse",
            Self::MongoDb => "omni.engine.mongodb",
            Self::Redis => "omni.engine.redis",
            Self::MySql => "omni.engine.mysql",
            Self::Postgres => "omni.engine.postgres",
        }
    }

    pub fn from_plugin_id(id: &str) -> Option<Self> {
        Self::all().into_iter().find(|kind| kind.plugin_id() == id)
    }

    pub fn plugin_folder(self) -> &'static str {
        match self {
            Self::ClickHouse => "db-clickhouse",
            Self::MongoDb => "db-mongodb",
            Self::Redis => "db-redis",
            Self::MySql => "db-mysql",
            Self::Postgres => "db-postgres",
        }
    }

    pub fn env_var(self) -> String {
        sidecar_env_var(self.as_str())
    }

    pub fn all() -> [Self; 5] {
        [
            Self::ClickHouse,
            Self::MongoDb,
            Self::Redis,
            Self::MySql,
            Self::Postgres,
        ]
    }
}

#[derive(Debug, Clone)]
pub enum EngineLaunch {
    Builtin(EngineKind),
    External { program: PathBuf, args: Vec<String> },
}

impl EngineLaunch {
    pub fn cache_id(&self) -> String {
        match self {
            Self::Builtin(kind) => kind.as_str().to_string(),
            Self::External { program, args } => {
                format!("ext:{}:{}", program.display(), args.join("\u{1f}"))
            }
        }
    }
}

pub fn sidecar_env_var(db_type: &str) -> String {
    let mut key = String::from("OMNIPANEL_ENGINE_SIDECAR_");
    for ch in db_type.chars() {
        if ch.is_ascii_alphanumeric() {
            key.push(ch.to_ascii_uppercase());
        } else {
            key.push('_');
        }
    }
    key
}

pub fn sql_sidecars_enabled() -> bool {
    match std::env::var("OMNIPANEL_SQL_SIDECAR") {
        Ok(value) => {
            let v = value.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

fn plugin_launches() -> &'static Mutex<HashMap<String, EngineLaunch>> {
    static PLUGIN_LAUNCHES: OnceLock<Mutex<HashMap<String, EngineLaunch>>> = OnceLock::new();
    PLUGIN_LAUNCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 由宿主在插件装载/启用变化后写入：`engineKey`/别名 → 安装目录内的 sidecar。
pub fn set_plugin_engine_launches(entries: impl IntoIterator<Item = (String, EngineLaunch)>) {
    let mut map = HashMap::new();
    for (key, launch) in entries {
        let key = key.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        map.insert(key, launch);
    }
    *plugin_launches()
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = map;
}

fn plugin_claims() -> &'static Mutex<HashMap<String, Option<String>>> {
    static PLUGIN_CLAIMS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    PLUGIN_CLAIMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 已激活引擎插件声明的 `db_type`：`None` 表示 sidecar 可启动，`Some` 为启动失败原因。
/// 已声明则禁止再静默回退 sqlx 兼容驱动。
pub fn set_plugin_engine_claims(entries: impl IntoIterator<Item = (String, Option<String>)>) {
    let mut map = HashMap::new();
    for (key, err) in entries {
        let key = key.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        map.insert(key, err);
    }
    *plugin_claims()
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = map;
}

#[cfg(test)]
static PLUGIN_ENGINE_TEST_LOCK: Mutex<()> = Mutex::new(());

/// 测试互斥：claims / launches 是进程全局状态，并行用例会互相清空。
#[cfg(test)]
pub fn lock_plugin_engine_for_test() -> std::sync::MutexGuard<'static, ()> {
    PLUGIN_ENGINE_TEST_LOCK
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

pub fn plugin_engine_claimed(db_type: &str) -> bool {
    plugin_claims()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .contains_key(&db_type.trim().to_ascii_lowercase())
}

pub fn plugin_engine_claim_error(db_type: &str) -> Option<String> {
    plugin_claims()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .get(&db_type.trim().to_ascii_lowercase())
        .and_then(|err| err.clone())
}

fn plugin_launch_for_type(db_type: &str) -> Option<EngineLaunch> {
    plugin_launches()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .get(&db_type.trim().to_ascii_lowercase())
        .cloned()
}

/// 把插件包内的 `entry.driver` 解析成可 spawn 的命令。
///
/// - `.js` / `.mjs` → `node <file>`（DBX mock / Node agent）
/// - `.jar` → `java -jar <file>`（DBX JDBC agent）
/// - 其它 → 直接执行该文件
pub fn launch_from_driver_file(driver: &Path) -> Option<EngineLaunch> {
    launch_from_driver_file_result(driver).ok()
}

/// 与 [`launch_from_driver_file`] 相同，但 jar 缺 JRE 时返回明确错误。
pub fn launch_from_driver_file_result(driver: &Path) -> Result<EngineLaunch, String> {
    if !driver.is_file() {
        return Err(format!("sidecar driver 不存在: {}", driver.display()));
    }
    let ext = driver
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => {
            let node = resolve_on_path("node")
                .or_else(|| resolve_on_path("node.exe"))
                .ok_or_else(|| "未找到 node，无法启动 JS sidecar".to_string())?;
            Ok(EngineLaunch::External {
                program: node,
                args: vec![driver.to_string_lossy().into_owned()],
            })
        }
        "jar" => {
            let java = resolve_java_for_jar(driver)?;
            Ok(EngineLaunch::External {
                program: java,
                args: vec![
                    "-Dfile.encoding=UTF-8".into(),
                    "-Dsun.jnu.encoding=UTF-8".into(),
                    "-jar".into(),
                    driver.to_string_lossy().into_owned(),
                ],
            })
        }
        _ => Ok(EngineLaunch::External {
            program: driver.to_path_buf(),
            args: Vec::new(),
        }),
    }
}

/// 在 JRE 根目录递归查找 `java` / `java.exe`，优先 `bin/` 下的正式入口。
pub fn find_java_binary(root: &Path) -> Option<PathBuf> {
    let expected = if cfg!(windows) { "java.exe" } else { "java" };
    let mut found = Vec::new();
    fn walk(dir: &Path, expected: &str, found: &mut Vec<PathBuf>, depth: usize) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, expected, found, depth + 1);
                continue;
            }
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(expected))
            {
                found.push(path);
            }
        }
    }
    walk(root, expected, &mut found, 0);
    found.sort_by_key(|path| {
        let lower = path.to_string_lossy().to_ascii_lowercase();
        (!lower.replace('\\', "/").contains("/bin/"), lower.len())
    });
    found.into_iter().next()
}

/// 从 `plugins/.dbx-jre/21` 递归查找捆绑 JRE，兼容多一层 `dbx-jre/`。
pub fn bundled_jre_java(driver: &Path) -> Option<PathBuf> {
    let plugins = driver.parent()?.parent()?.parent()?;
    find_java_binary(&plugins.join(".dbx-jre").join("21"))
        .or_else(|| find_java_binary(&plugins.join(".dbx-jre")))
}

/// 解析 JDBC agent 用的 java：显式环境变量 → 捆绑 JRE。找不到不落到 PATH 上的假 `java.exe`。
pub fn resolve_java_for_jar(driver: &Path) -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("OMNIPANEL_DBX_JAVA") {
        let path = PathBuf::from(explicit.trim());
        if path.is_file() {
            return Ok(path);
        }
    }
    bundled_jre_java(driver).ok_or_else(|| JRE_MISSING.to_string())
}

/// `java -version` 能跑才视为健康；安装后失败则下次覆盖。
pub fn java_version_ok(java: &Path) -> bool {
    if !java.is_file() {
        return false;
    }
    let mut cmd = Command::new(java);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn resolve_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            if !name.to_ascii_lowercase().ends_with(".exe") {
                let with_exe = dir.join(format!("{name}.exe"));
                if with_exe.is_file() {
                    return Some(with_exe);
                }
            }
        }
    }
    None
}

/// 解析本连接应拉起的 sidecar：环境变量覆盖 → 第一方引擎 → 已安装插件 driver → DBX 通用命令。
pub fn launch_for_params(params: &DbParams) -> Option<EngineLaunch> {
    if let Some(launch) = env_launch_for_type(&params.db_type) {
        return Some(launch);
    }
    match EngineKind::from_db_type(&params.db_type) {
        Some(kind) => builtin_launch(kind),
        None => plugin_launch_for_type(&params.db_type)
            .or_else(|| env_launch_for_type("DBX"))
            .or_else(env_dbx_cmd),
    }
}

fn builtin_launch(kind: EngineKind) -> Option<EngineLaunch> {
    use crate::engine_contract::{FirstPartyEngine, FirstPartyRuntime};
    let inproc = FirstPartyEngine::from_db_type(kind.as_str())
        .is_some_and(|engine| engine.runtime() == FirstPartyRuntime::Inproc);
    if inproc
        && !(matches!(kind, EngineKind::MySql | EngineKind::Postgres) && sql_sidecars_enabled())
    {
        return None;
    }
    Some(EngineLaunch::Builtin(kind))
}

fn env_launch_for_type(db_type: &str) -> Option<EngineLaunch> {
    let var = sidecar_env_var(db_type);
    let raw = std::env::var(&var).ok()?;
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return None;
    }
    let args_var = format!("{var}_ARGS");
    let args: Vec<String> = std::env::var(&args_var)
        .ok()
        .map(|s| {
            s.split(';')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(kind) = EngineKind::from_db_type(db_type) {
        if args.is_empty() && path_looks_like_builtin(&path, kind) {
            return Some(EngineLaunch::Builtin(kind));
        }
    }
    Some(EngineLaunch::External {
        program: path,
        args,
    })
}

fn env_dbx_cmd() -> Option<EngineLaunch> {
    let raw = std::env::var("OMNIPANEL_DBX_CMD").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    let program = PathBuf::from(parts.next()?);
    let args = parts.map(str::to_string).collect();
    Some(EngineLaunch::External { program, args })
}

fn path_looks_like_builtin(path: &Path, kind: EngineKind) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| {
            stem == kind.bin_stem() || stem.starts_with(&format!("{}-", kind.bin_stem()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_aliases() {
        assert_eq!(EngineKind::from_db_type("ch"), Some(EngineKind::ClickHouse));
        assert_eq!(EngineKind::from_db_type("mongo"), Some(EngineKind::MongoDb));
        assert_eq!(
            EngineKind::from_db_type("postgresql"),
            Some(EngineKind::Postgres)
        );
        assert_eq!(EngineKind::from_db_type("oracle"), None);
        assert_eq!(
            EngineKind::from_plugin_id("omni.engine.mongodb"),
            Some(EngineKind::MongoDb)
        );
        assert_eq!(EngineKind::from_plugin_id("omni.engine.qdrant"), None);
        for kind in EngineKind::all() {
            let engine = crate::FirstPartyEngine::from_plugin_id(kind.plugin_id())
                .expect("sidecar 引擎必须出现在 FirstPartyEngine");
            assert_eq!(engine.plugin_id(), kind.plugin_id());
            assert_eq!(engine.plugin_folder(), kind.plugin_folder());
        }
    }

    #[test]
    fn sidecar_env_var_normalizes() {
        assert_eq!(
            sidecar_env_var("clickhouse"),
            "OMNIPANEL_ENGINE_SIDECAR_CLICKHOUSE"
        );
        assert_eq!(
            sidecar_env_var("sql-server"),
            "OMNIPANEL_ENGINE_SIDECAR_SQL_SERVER"
        );
    }

    fn dummy(db_type: &str) -> DbParams {
        DbParams {
            db_type: db_type.into(),
            host: "127.0.0.1".into(),
            port: 1,
            user: String::new(),
            password: String::new(),
            database: String::new(),
            ssl: false,
            sid: String::new(),
            sysdba: false,
        }
    }

    fn env_interferes(keys: &[&str]) -> bool {
        keys.iter().any(|key| std::env::var(key).is_ok())
    }

    #[test]
    fn mysql_pg_stay_in_process_by_default() {
        if env_interferes(&[
            "OMNIPANEL_SQL_SIDECAR",
            "OMNIPANEL_ENGINE_SIDECAR_MYSQL",
            "OMNIPANEL_ENGINE_SIDECAR_POSTGRES",
            "OMNIPANEL_ENGINE_SIDECAR_POSTGRESQL",
            "OMNIPANEL_ENGINE_SIDECAR_PG",
        ]) {
            return;
        }
        assert!(launch_for_params(&dummy("mysql")).is_none());
        assert!(launch_for_params(&dummy("postgres")).is_none());
    }

    #[test]
    fn redis_stays_in_process_by_default() {
        if env_interferes(&["OMNIPANEL_ENGINE_SIDECAR_REDIS"]) {
            return;
        }
        assert!(launch_for_params(&dummy("redis")).is_none());
    }

    #[test]
    fn mongo_clickhouse_default_to_sidecar() {
        if env_interferes(&[
            "OMNIPANEL_ENGINE_SIDECAR_MONGODB",
            "OMNIPANEL_ENGINE_SIDECAR_MONGO",
            "OMNIPANEL_ENGINE_SIDECAR_CLICKHOUSE",
            "OMNIPANEL_ENGINE_SIDECAR_CH",
        ]) {
            return;
        }
        assert!(matches!(
            launch_for_params(&dummy("mongodb")),
            Some(EngineLaunch::Builtin(EngineKind::MongoDb))
        ));
        assert!(matches!(
            launch_for_params(&dummy("clickhouse")),
            Some(EngineLaunch::Builtin(EngineKind::ClickHouse))
        ));
    }

    #[test]
    fn sqlite_qdrant_stay_t0_without_dbx_env() {
        if env_interferes(&[
            "OMNIPANEL_ENGINE_SIDECAR_SQLITE",
            "OMNIPANEL_ENGINE_SIDECAR_QDRANT",
            "OMNIPANEL_ENGINE_SIDECAR_DBX",
            "OMNIPANEL_DBX_CMD",
        ]) {
            return;
        }
        assert!(launch_for_params(&dummy("sqlite")).is_none());
        assert!(launch_for_params(&dummy("qdrant")).is_none());
    }

    struct ClearPluginLaunches;
    impl Drop for ClearPluginLaunches {
        fn drop(&mut self) {
            set_plugin_engine_launches(Vec::<(String, EngineLaunch)>::new());
        }
    }

    #[test]
    fn installed_plugin_driver_resolves_unknown_engine() {
        if env_interferes(&["OMNIPANEL_ENGINE_SIDECAR_ORACLE"]) {
            return;
        }
        let _guard = ClearPluginLaunches;
        set_plugin_engine_launches([(
            "oracle".into(),
            EngineLaunch::External {
                program: PathBuf::from("node"),
                args: vec!["agent.mjs".into()],
            },
        )]);
        match launch_for_params(&dummy("oracle")) {
            Some(EngineLaunch::External { program, args }) => {
                assert_eq!(program, PathBuf::from("node"));
                assert_eq!(args, vec!["agent.mjs"]);
            }
            other => panic!("oracle 应走插件 driver，得到 {other:?}"),
        }
    }

    #[test]
    fn launch_from_missing_driver_is_none() {
        assert!(launch_from_driver_file(Path::new("definitely-missing-dbx-agent.bin")).is_none());
        let err = launch_from_driver_file_result(Path::new("definitely-missing-dbx-agent.bin"))
            .unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn bundled_jre_walks_nested_dbx_jre_dir() {
        let root = std::env::temp_dir().join(format!(
            "omni-jre-nested-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let plugin_bin = root.join("plugins").join("omni.engine.dameng").join("bin");
        let java_dir = root
            .join("plugins")
            .join(".dbx-jre")
            .join("21")
            .join("dbx-jre")
            .join("bin");
        std::fs::create_dir_all(&plugin_bin).unwrap();
        std::fs::create_dir_all(&java_dir).unwrap();
        let java_name = if cfg!(windows) { "java.exe" } else { "java" };
        let java = java_dir.join(java_name);
        std::fs::write(&java, b"dummy").unwrap();
        let jar = plugin_bin.join("agent.jar");
        std::fs::write(&jar, b"pk").unwrap();
        let prev = std::env::var("OMNIPANEL_DBX_JAVA").ok();
        unsafe { std::env::remove_var("OMNIPANEL_DBX_JAVA") };

        let found = bundled_jre_java(&jar).expect("应命中嵌套 dbx-jre/bin/java");
        assert_eq!(found, java);
        let via_root = find_java_binary(&root.join("plugins").join(".dbx-jre").join("21"))
            .expect("walk 应从 21/ 找到 java");
        assert_eq!(via_root, java);

        let err = resolve_java_for_jar(&jar);
        // dummy 文件不是真 java，但路径必须先被解析到，不能落到 PATH 上的 java.exe
        assert_eq!(err.as_ref().ok(), Some(&java));

        match prev {
            Some(v) => unsafe { std::env::set_var("OMNIPANEL_DBX_JAVA", v) },
            None => unsafe { std::env::remove_var("OMNIPANEL_DBX_JAVA") },
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn jar_without_jre_returns_explicit_error() {
        let root = std::env::temp_dir().join(format!(
            "omni-jre-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let plugin_bin = root.join("plugins").join("omni.engine.hive").join("bin");
        std::fs::create_dir_all(&plugin_bin).unwrap();
        let jar = plugin_bin.join("agent.jar");
        std::fs::write(&jar, b"pk").unwrap();
        let prev = std::env::var("OMNIPANEL_DBX_JAVA").ok();
        unsafe { std::env::remove_var("OMNIPANEL_DBX_JAVA") };

        let err = resolve_java_for_jar(&jar).unwrap_err();
        assert!(err.contains("未找到捆绑 JRE"), "{err}");
        assert!(launch_from_driver_file(&jar).is_none());
        let launch_err = launch_from_driver_file_result(&jar).unwrap_err();
        assert!(launch_err.contains("未找到捆绑 JRE"), "{launch_err}");

        match prev {
            Some(v) => unsafe { std::env::set_var("OMNIPANEL_DBX_JAVA", v) },
            None => unsafe { std::env::remove_var("OMNIPANEL_DBX_JAVA") },
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn jar_launch_injects_utf8_file_encoding() {
        let root = std::env::temp_dir().join(format!(
            "omni-jar-utf8-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let plugin_bin = root.join("plugins").join("omni.engine.highgo").join("bin");
        std::fs::create_dir_all(&plugin_bin).unwrap();
        let jar = plugin_bin.join("agent.jar");
        std::fs::write(&jar, b"pk").unwrap();
        let java = plugin_bin.join("java.exe");
        std::fs::write(&java, b"dummy").unwrap();
        let prev = std::env::var("OMNIPANEL_DBX_JAVA").ok();
        unsafe { std::env::set_var("OMNIPANEL_DBX_JAVA", java.to_string_lossy().as_ref()) };

        let launch = launch_from_driver_file_result(&jar).expect("应解析 jar 启动");
        match launch {
            EngineLaunch::External { args, .. } => {
                assert!(
                    args.iter().any(|a| a == "-Dfile.encoding=UTF-8"),
                    "{args:?}"
                );
                assert!(
                    args.iter().any(|a| a == "-Dsun.jnu.encoding=UTF-8"),
                    "{args:?}"
                );
                assert!(args.iter().any(|a| a == "-jar"), "{args:?}");
            }
            other => panic!("应为 External，得到 {other:?}"),
        }

        match prev {
            Some(v) => unsafe { std::env::set_var("OMNIPANEL_DBX_JAVA", v) },
            None => unsafe { std::env::remove_var("OMNIPANEL_DBX_JAVA") },
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plugin_claims_block_lookup() {
        let _guard = lock_plugin_engine_for_test();
        set_plugin_engine_claims([(
            "highgo".into(),
            Some("未找到捆绑 JRE，请重新安装该引擎".into()),
        )]);
        assert!(plugin_engine_claimed("HighGo"));
        assert!(
            plugin_engine_claim_error("highgo")
                .unwrap_or_default()
                .contains("JRE")
        );
        set_plugin_engine_claims(Vec::<(String, Option<String>)>::new());
        assert!(!plugin_engine_claimed("highgo"));
    }
}
