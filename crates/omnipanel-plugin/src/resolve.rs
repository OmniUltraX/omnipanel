//! marketplace 版本与依赖解决（纯函数，无 IO，可单测）。
//!
//! 约束语法与 manifest `dependencies[].versionReq` 一致：
//! `^x.y.z`（缺省）/ `>=x.y.z` / `=x.y.z`，语义复用 `semver::VersionReq`
//!（caret 对 0.x 的收紧与 cargo/npm 一致）。
//!
//! 策略（有意简化，非 SAT 求解器）：
//! - 同一 id 的多约束取交集（逐个匹配），首次选定版本后不再回溯；
//!   后续约束与已选版本冲突 → `Conflict` 可读错误（提示手工指定版本）。
//! - 已安装且满足全部约束 → 跳过（不进安装计划）。
//! - `min_host_api` 高于宿主的版本不参与选择。

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use semver::{Version, VersionReq};

/// registry v2 某一插件的某一版本条目（resolver 只消费这些字段）。
#[derive(Debug, Clone, PartialEq)]
pub struct VersionEntry {
    pub version: Version,
    pub min_host_api: u32,
    pub dependencies: Vec<DependencyReq>,
}

/// 依赖边 polled。
#[derive(Debug, Clone, PartialEq)]
pub struct DependencyReq {
    pub id: String,
    pub req: String,
}

/// 安装计划项（已按拓扑序：依赖在前）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlanItem {
    pub id: String,
    pub version: Version,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResolveError {
    UnknownPlugin(String),
    NoSatisfyingVersion { id: String, reqs: Vec<String> },
    IncompatibleHostApi { id: String, best: Version },
    Conflict { id: String, chosen: Version, req: String },
    Cycle(Vec<String>),
    TooDeep(String),
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownPlugin(id) => write!(f, "未知插件: {id}"),
            Self::NoSatisfyingVersion { id, reqs } => {
                write!(f, "无满足版本: {id}（约束 {}）", reqs.join(", "))
            }
            Self::IncompatibleHostApi { id, best } => {
                write!(f, "{id} 最高版本 {best} 需要更新宿主")
            }
            Self::Conflict { id, chosen, req } => {
                write!(f, "版本冲突: {id} 已选 {chosen}，不满足新增约束 {req}（请手工指定版本）")
            }
            Self::Cycle(path) => write!(f, "依赖成环: {}", path.join(" -> ")),
            Self::TooDeep(id) => write!(f, "依赖过深（>50），疑似超长链: {id}"),
        }
    }
}

impl std::error::Error for ResolveError {}

/// 最大满足版本（不考虑 host_api；调用方另行过滤）。
pub fn max_satisfying(versions: &[Version], req_str: &str) -> Option<Version> {
    let req = VersionReq::parse(req_str.trim()).ok()?;
    versions
        .iter()
        .filter(|v| req.matches(v))
        .max()
        .cloned()
}

/// registry 最新 compatible 版本高于已安装 → 返回新版本号。
pub fn update_available(
    installed: &Version,
    entries: &[VersionEntry],
    host_api: u32,
) -> Option<Version> {
    entries
        .iter()
        .filter(|e| e.min_host_api <= host_api)
        .map(|e| &e.version)
        .filter(|v| *v > installed)
        .max()
        .cloned()
}

struct State<'a> {
    index: &'a HashMap<String, Vec<VersionEntry>>,
    host_api: u32,
    installed: &'a HashMap<String, Version>,
    chosen: BTreeMap<String, Version>,
    order: Vec<PlanItem>,
    stack: Vec<String>,
}

/// 计算安装计划（拓扑序，依赖在前）。
///
/// `roots`: `(id, req)` 入口约束；`installed`: 已安装版本（满足则跳过）。
pub fn resolve_install(
    roots: &[(String, String)],
    index: &HashMap<String, Vec<VersionEntry>>,
    host_api: u32,
    installed: &HashMap<String, Version>,
) -> Result<Vec<PlanItem>, ResolveError> {
    let mut state = State {
        index,
        host_api,
        installed,
        chosen: BTreeMap::new(),
        order: Vec::new(),
        stack: Vec::new(),
    };
    for (id, req) in roots {
        visit(id, req, &mut state)?;
    }
    Ok(state.order)
}

fn parse_req(req: &str) -> Result<VersionReq, ResolveError> {
    // 空约束视为 ^0.0.0？不——空约束非法，调用方应在 manifest 校验拦掉；
    // 此处兜底为匹配任意版本，避免 resolver 崩。
    if req.trim().is_empty() {
        return Ok(VersionReq::STAR);
    }
    VersionReq::parse(req.trim())
        .map_err(|_| ResolveError::NoSatisfyingVersion {
            id: String::new(),
            reqs: vec![req.to_string()],
        })
}

fn visit(id: &str, req_str: &str, state: &mut State) -> Result<(), ResolveError> {
    if state.stack.len() > 50 {
        return Err(ResolveError::TooDeep(id.to_string()));
    }
    let req = parse_req(req_str).map_err(|_| ResolveError::NoSatisfyingVersion {
        id: id.to_string(),
        reqs: vec![req_str.to_string()],
    })?;
    // 栈检查在前：DFS 路径上重访 = 正在 resolve 它 = 环（即使已有初选版本）。
    // 菱形依赖不触发：d 完成 resolve 后已出栈，重访走下面的 chosen 检查。
    if state.stack.contains(&id.to_string()) {
        let mut cycle = state.stack.clone();
        cycle.push(id.to_string());
        return Err(ResolveError::Cycle(cycle));
    }
    if let Some(chosen) = state.chosen.get(id) {
        if !req.matches(chosen) {
            return Err(ResolveError::Conflict {
                id: id.to_string(),
                chosen: chosen.clone(),
                req: req_str.to_string(),
            });
        }
        return Ok(());
    }
    // 已安装且满足 → 跳过（其依赖视为安装时已满足）
    if let Some(have) = state.installed.get(id) {
        if req.matches(have) {
            state.chosen.insert(id.to_string(), have.clone());
            return Ok(());
        }
    }
    let entries = state
        .index
        .get(id)
        .ok_or_else(|| ResolveError::UnknownPlugin(id.to_string()))?;
    let best = entries
        .iter()
        .filter(|e| e.min_host_api <= state.host_api && req.matches(&e.version))
        .max_by(|a, b| a.version.cmp(&b.version));
    let Some(picked) = best else {
        // 区分"有版本但 host 不兼容"与"真无满足"
        if let Some(top) = entries.iter().max_by(|a, b| a.version.cmp(&b.version)) {
            if req.matches(&top.version) {
                return Err(ResolveError::IncompatibleHostApi {
                    id: id.to_string(),
                    best: top.version.clone(),
                });
            }
        }
        return Err(ResolveError::NoSatisfyingVersion {
            id: id.to_string(),
            reqs: vec![req_str.to_string()],
        });
    };
    // 若已安装版本满足但更低：升级到 picked（计划含该项）
    state
        .chosen
        .insert(id.to_string(), picked.version.clone());
    state.stack.push(id.to_string());
    let deps = picked.dependencies.clone();
    for dep in &deps {
        visit(&dep.id, &dep.req, state)?;
    }
    state.stack.pop();
    // 已安装同版本满足 → 不进计划；否则（新装/升级）进计划
    let installed_same = state
        .installed
        .get(id)
        .is_some_and(|have| *have == picked.version);
    if !installed_same {
        state.order.push(PlanItem {
            id: id.to_string(),
            version: picked.version.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(version: &str, deps: &[(&str, &str)]) -> VersionEntry {
        VersionEntry {
            version: Version::parse(version).unwrap(),
            min_host_api: 1,
            dependencies: deps
                .iter()
                .map(|(id, req)| DependencyReq {
                    id: id.to_string(),
                    req: req.to_string(),
                })
                .collect(),
        }
    }

    fn index(pairs: &[(&str, Vec<VersionEntry>)]) -> HashMap<String, Vec<VersionEntry>> {
        pairs
            .iter()
            .map(|(id, entries)| (id.to_string(), entries.clone()))
            .collect()
    }

    #[test]
    fn caret_semantics_match_cargo() {
        let versions: Vec<Version> = ["1.2.3", "1.9.0", "2.0.0"]
            .iter()
            .map(|v| Version::parse(v).unwrap())
            .collect();
        assert_eq!(
            max_satisfying(&versions, "^1.2.3").unwrap().to_string(),
            "1.9.0"
        );
        assert_eq!(
            max_satisfying(&versions, ">=1.0.0").unwrap().to_string(),
            "2.0.0"
        );
        assert_eq!(
            max_satisfying(&versions, "=1.2.3").unwrap().to_string(),
            "1.2.3"
        );
        assert!(max_satisfying(&versions, "^3.0.0").is_none());
    }

    #[test]
    fn diamond_resolves_once_in_topo_order() {
        let idx = index(&[
            ("a", vec![entry("1.0.0", &[("b", "^1.0.0"), ("c", "^1.0.0")])]),
            ("b", vec![entry("1.0.0", &[("d", "^1.0.0")])]),
            ("c", vec![entry("1.0.0", &[("d", "^1.0.0")])]),
            ("d", vec![entry("1.0.0", &[])]),
        ]);
        let plan = resolve_install(
            &[("a".into(), "^1.0.0".into())],
            &idx,
            1,
            &HashMap::new(),
        )
        .unwrap();
        let ids: Vec<_> = plan.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.first(), Some(&"d"));
        assert_eq!(ids.last(), Some(&"a"));
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn cycle_reports_path() {
        let idx = index(&[
            ("a", vec![entry("1.0.0", &[("b", "^1.0.0")])]),
            ("b", vec![entry("1.0.0", &[("a", "^1.0.0")])]),
        ]);
        let err = resolve_install(&[("a".into(), "^1.0.0".into())], &idx, 1, &HashMap::new())
            .err()
            .unwrap();
        assert!(matches!(err, ResolveError::Cycle(_)), "actual: {err}");
    }

    #[test]
    fn conflict_on_second_constraint() {
        let idx = index(&[
            ("a", vec![entry("1.0.0", &[("d", "=1.0.0")])]),
            ("b", vec![entry("1.0.0", &[("d", "=2.0.0")])]),
            ("d", vec![entry("1.0.0", &[]), entry("2.0.0", &[])]),
            (
                "root",
                vec![entry("1.0.0", &[("a", "^1.0.0"), ("b", "^1.0.0")])],
            ),
        ]);
        let err = resolve_install(
            &[("root".into(), "^1.0.0".into())],
            &idx,
            1,
            &HashMap::new(),
        )
        .err()
        .unwrap();
        assert!(matches!(err, ResolveError::Conflict { .. }), "actual: {err}");
    }

    #[test]
    fn installed_satisfying_is_skipped() {
        let idx = index(&[("a", vec![entry("1.0.0", &[])])]);
        let installed: HashMap<String, Version> =
            [("a".into(), Version::parse("1.0.0").unwrap())].into();
        let plan = resolve_install(&[("a".into(), "^1.0.0".into())], &idx, 1, &installed).unwrap();
        assert!(plan.is_empty());
    }

    #[test]
    fn host_api_filters_versions() {
        let mut new_entry = entry("2.0.0", &[]);
        new_entry.min_host_api = 99;
        let idx = index(&[("a", vec![entry("1.0.0", &[]), new_entry])]);
        let plan = resolve_install(
            &[("a".into(), ">=1.0.0".into())],
            &idx,
            1,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(plan[0].version.to_string(), "1.0.0");
        assert_eq!(
            update_available(&Version::parse("1.0.0").unwrap(), &idx["a"], 1),
            None
        );
    }
}
