//! 本地模型推荐：硬件探测 + Library 热度 + 场景分栏。

use crate::background::gpu_local::collect_local_gpu;
use crate::commands::ollama_catalog::{
    catalog_source_label, load_library_catalog, LibraryModelEntry,
};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalHardwareInfo {
    #[specta(type = f64)]
    pub total_memory_mb: u64,
    #[specta(type = f64)]
    pub vram_mb: u64,
    pub has_discrete_gpu: bool,
    pub gpu_name: Option<String>,
    pub hardware_tier: String,
    /// 推荐量化档，如 Q4_K_M
    pub quant_pref: String,
    /// 估测可跑参数量（B）
    pub max_param_b: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedModel {
    pub name: String,
    /// coding | chinese_chat | embedding
    pub scenario: String,
    pub kind: String,
    pub approx_size_gb: f64,
    pub description: String,
    pub tier: String,
    pub quant_hint: String,
    #[specta(type = Option<f64>)]
    pub pulls: Option<u64>,
    pub from_library: bool,
}

pub fn probe_hardware(total_memory_mb: u64) -> LocalHardwareInfo {
    let gpu = collect_local_gpu();
    let mut best_vram = 0u64;
    let mut gpu_name: Option<String> = None;
    let mut has_discrete = false;

    for dev in &gpu.devices {
        let name_l = dev.name.to_lowercase();
        let vendor_l = dev.vendor.to_lowercase();
        let integrated = name_l.contains("intel")
            || name_l.contains("uhd")
            || name_l.contains("iris")
            || (name_l.contains("radeon graphics") && !name_l.contains("rx"));
        let discrete = vendor_l.contains("nvidia")
            || name_l.contains("geforce")
            || name_l.contains("rtx")
            || name_l.contains("gtx")
            || name_l.contains("quadro")
            || name_l.contains("radeon rx")
            || name_l.contains("apple m");
        if discrete && !integrated {
            has_discrete = true;
        }
        if let Some(mem) = dev.memory_total {
            let mb = if mem > 256_000 {
                mem / (1024 * 1024)
            } else {
                mem
            };
            if mb > best_vram {
                best_vram = mb;
                gpu_name = Some(dev.name.clone());
            }
        } else if gpu_name.is_none() {
            gpu_name = Some(dev.name.clone());
        }
        if name_l.contains("apple m") {
            has_discrete = true;
            if best_vram == 0 {
                best_vram = total_memory_mb / 2;
            }
        }
    }

    let (quant_pref, max_param_b, tier) =
        recommend_quant_and_size(total_memory_mb, best_vram, has_discrete);

    LocalHardwareInfo {
        total_memory_mb,
        vram_mb: best_vram,
        has_discrete_gpu: has_discrete,
        gpu_name,
        hardware_tier: tier.into(),
        quant_pref: quant_pref.into(),
        max_param_b,
    }
}

fn recommend_quant_and_size(
    ram_mb: u64,
    vram_mb: u64,
    has_discrete: bool,
) -> (&'static str, f64, &'static str) {
    let budget_mb = if has_discrete && vram_mb > 0 {
        vram_mb
    } else if vram_mb > 0 {
        vram_mb.min(ram_mb / 2)
    } else {
        ram_mb / 2
    };

    // Q4_K_M 约 0.6–0.7 GB / B；取 0.7 保守估算
    let max_param_b = (budget_mb as f64 / 1024.0) / 0.7;

    let (quant, tier) = if budget_mb >= 24 * 1024 {
        ("Q5_K_M", "strong")
    } else if budget_mb >= 12 * 1024 {
        ("Q4_K_M", "strong")
    } else if budget_mb >= 6 * 1024 {
        ("Q4_K_M", "balanced")
    } else {
        ("Q4_K_M", "entry")
    };

    (quant, max_param_b.max(1.0), tier)
}

fn parse_size_tag_b(tag: &str) -> Option<f64> {
    let t = tag.trim().to_lowercase();
    t.strip_suffix('b')?.parse::<f64>().ok()
}

fn size_tags(entry: &LibraryModelEntry) -> Vec<f64> {
    let mut sizes: Vec<f64> = entry
        .tags
        .iter()
        .filter_map(|t| parse_size_tag_b(t))
        .collect();
    sizes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sizes.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    sizes
}

fn format_size_tag(b: f64) -> String {
    if (b - b.round()).abs() < 1e-6 {
        format!("{}b", b as u64)
    } else {
        format!("{b}b")
    }
}

fn pick_size_tag(entry: &LibraryModelEntry, max_param_b: f64) -> Option<String> {
    let sizes = size_tags(entry);
    if sizes.is_empty() {
        return None;
    }
    let fit = sizes
        .iter()
        .copied()
        .filter(|s| *s <= max_param_b * 1.05)
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(format_size_tag(fit.unwrap_or(sizes[0])))
}

fn approx_gb_for(param_b: f64, quant: &str) -> f64 {
    let factor = match quant {
        "Q8_0" => 1.05,
        "Q5_K_M" => 0.75,
        _ => 0.6,
    };
    (param_b * factor * 10.0).round() / 10.0
}

fn is_embedding(entry: &LibraryModelEntry) -> bool {
    let n = entry.name.to_lowercase();
    entry.tags.iter().any(|t| t == "embedding")
        || n.contains("embed")
        || n.contains("bge-")
        || n.starts_with("nomic-embed")
        || n.contains("mxbai-embed")
}

fn is_coding(entry: &LibraryModelEntry) -> bool {
    let n = entry.name.to_lowercase();
    n.contains("coder")
        || n.contains("codellama")
        || n.contains("starcoder")
        || n.contains("deepseek-coder")
        || n.contains("codegemma")
        || (n.contains("kimi-k2") && n.contains("code"))
}

fn is_chinese_friendly(entry: &LibraryModelEntry) -> bool {
    let n = entry.name.to_lowercase();
    // 排除纯 embedding / 纯 coder（coder 归编码栏）
    if is_embedding(entry) || is_coding(entry) {
        return false;
    }
    n.starts_with("qwen")
        || n.starts_with("glm")
        || n.starts_with("deepseek")
        || n.starts_with("yi")
        || n.starts_with("internlm")
        || n.starts_with("chatglm")
        || n.starts_with("hunyuan")
}

fn build_pull_name(entry: &LibraryModelEntry, size: Option<&str>, _quant: &str) -> String {
    // 拉取名用官方尺寸 tag（默认量化多为 Q4_K_M）。
    // 高配机器在 quant_hint 中提示可尝试显式量化标签。
    match size {
        Some(sz) => format!("{}:{}", entry.name, sz),
        None => entry.name.clone(),
    }
}

fn quant_hint_text(quant: &str, size: Option<&str>) -> String {
    match (quant, size) {
        ("Q5_K_M", Some(sz)) => format!(
            "建议 {quant}；可试 `{sz}-q5_K_M`，失败则用 `:{sz}`（默认多为 Q4_K_M）"
        ),
        ("Q5_K_M", None) => format!("建议 {quant}；可试 `:q5_K_M`"),
        (_, Some(_)) => format!("{quant}（Ollama 默认尺寸 tag 常见为此量化）"),
        _ => quant.to_string(),
    }
}

fn make_rec(
    entry: &LibraryModelEntry,
    scenario: &str,
    hw: &LocalHardwareInfo,
    size: Option<String>,
) -> RecommendedModel {
    let size_ref = size.as_deref();
    let param = size_ref
        .and_then(parse_size_tag_b)
        .unwrap_or(if scenario == "embedding" { 0.3 } else { 3.0 });
    let name = build_pull_name(entry, size_ref, &hw.quant_pref);
    RecommendedModel {
        name,
        scenario: scenario.into(),
        kind: scenario.into(),
        approx_size_gb: if scenario == "embedding" {
            approx_gb_for(param.min(1.0), &hw.quant_pref).max(0.3)
        } else {
            approx_gb_for(param, &hw.quant_pref)
        },
        description: if entry.description.is_empty() {
            format!("{} · 热度 {}", entry.name, format_pulls(entry.pulls))
        } else {
            format!("{} · 热度 {}", entry.description, format_pulls(entry.pulls))
        },
        tier: hw.hardware_tier.clone(),
        quant_hint: quant_hint_text(&hw.quant_pref, size_ref),
        pulls: Some(entry.pulls),
        from_library: true,
    }
}

fn format_pulls(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn pick_top(
    catalog: &[LibraryModelEntry],
    pred: impl Fn(&LibraryModelEntry) -> bool,
    hw: &LocalHardwareInfo,
    scenario: &str,
    limit: usize,
) -> Vec<RecommendedModel> {
    let mut matched: Vec<&LibraryModelEntry> = catalog.iter().filter(|e| pred(e)).collect();
    matched.sort_by(|a, b| b.pulls.cmp(&a.pulls));
    let mut out = Vec::new();
    for entry in matched {
        let size = pick_size_tag(entry, hw.max_param_b);
        if scenario != "embedding" {
            if let Some(min) = size_tags(entry).first().copied() {
                if min > hw.max_param_b * 1.25 {
                    continue;
                }
            }
        }
        out.push(make_rec(entry, scenario, hw, size));
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 生成分场景推荐列表。返回 (推荐, 目录来源说明)。
pub async fn build_recommendations(
    hw: &LocalHardwareInfo,
    force_refresh: bool,
) -> (Vec<RecommendedModel>, String) {
    let (catalog, source) = load_library_catalog(force_refresh).await;
    let source_label = catalog_source_label(&source).to_string();

    let mut list = Vec::new();
    list.extend(pick_top(&catalog, is_coding, hw, "coding", 4));
    list.extend(pick_top(
        &catalog,
        is_chinese_friendly,
        hw,
        "chinese_chat",
        4,
    ));
    list.extend(pick_top(&catalog, is_embedding, hw, "embedding", 3));

    if list.iter().all(|m| m.scenario != "embedding") {
        list.push(RecommendedModel {
            name: "nomic-embed-text".into(),
            scenario: "embedding".into(),
            kind: "embedding".into(),
            approx_size_gb: 0.3,
            description: "知识库 / Skill 向量化推荐".into(),
            tier: hw.hardware_tier.clone(),
            quant_hint: "—".into(),
            pulls: None,
            from_library: false,
        });
    }

    if list.is_empty() {
        let chat = if hw.max_param_b >= 12.0 {
            ("qwen2.5-coder:14b", 9.0, "coding", "编码 14B")
        } else if hw.max_param_b >= 6.0 {
            ("qwen2.5-coder:7b", 4.7, "coding", "编码 7B")
        } else {
            ("qwen2.5:3b", 2.0, "chinese_chat", "中文轻量 3B")
        };
        list.push(RecommendedModel {
            name: chat.0.into(),
            scenario: chat.2.into(),
            kind: chat.2.into(),
            approx_size_gb: chat.1,
            description: chat.3.into(),
            tier: hw.hardware_tier.clone(),
            quant_hint: hw.quant_pref.clone(),
            pulls: None,
            from_library: false,
        });
    }

    (list, source_label)
}
