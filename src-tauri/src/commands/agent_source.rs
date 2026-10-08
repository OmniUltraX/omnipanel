use omnipanel_ai::{AgentSourceCard, AgentSourceCreditPackage, AgentSourceCredits};
use specta::Type;

use crate::state::AppState;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceCardDto {
    pub id: String,
    pub title: String,
    pub signed_in: bool,
    pub account: Option<String>,
    pub token_expires_at_ms: Option<i64>,
    pub catalog_source: String,
    pub error: Option<String>,
    pub models: Vec<AgentSourceModelDto>,
    pub credits: Option<AgentSourceCreditsDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceModelDto {
    pub id: String,
    pub name: String,
    pub credits: Option<String>,
    pub badges: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceCreditsDto {
    pub total: f64,
    pub unlimited: bool,
    pub packages: Vec<AgentSourceCreditPackageDto>,
    pub cycle_reset_time: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceCreditPackageDto {
    pub name: String,
    pub remain: f64,
    pub size: f64,
    pub unlimited: bool,
}

impl From<AgentSourceCreditPackage> for AgentSourceCreditPackageDto {
    fn from(package: AgentSourceCreditPackage) -> Self {
        Self {
            name: package.name,
            remain: package.remain,
            size: package.size,
            unlimited: package.unlimited,
        }
    }
}

impl From<AgentSourceCredits> for AgentSourceCreditsDto {
    fn from(credits: AgentSourceCredits) -> Self {
        Self {
            total: credits.total,
            unlimited: credits.unlimited,
            packages: credits.packages.into_iter().map(Into::into).collect(),
            cycle_reset_time: credits.cycle_reset_time,
            error: credits.error,
        }
    }
}

impl From<AgentSourceCard> for AgentSourceCardDto {
    fn from(card: AgentSourceCard) -> Self {
        Self {
            id: card.id,
            title: card.title,
            signed_in: card.signed_in,
            account: card.account,
            token_expires_at_ms: card.token_expires_at_ms,
            catalog_source: card.catalog_source,
            error: card.error,
            models: card
                .models
                .into_iter()
                .map(|model| AgentSourceModelDto {
                    id: model.id,
                    name: model.name,
                    credits: model.credits,
                    badges: model.badges,
                })
                .collect(),
            credits: card.credits.map(Into::into),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn agent_source_list() -> Result<Vec<AgentSourceCardDto>, String> {
    let cards = tokio::task::spawn_blocking(|| omnipanel_ai::agent_source_registry().cards())
        .await
        .map_err(|e| e.to_string())?;
    Ok(cards.into_iter().map(AgentSourceCardDto::from).collect())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_source_refresh(id: String) -> Result<AgentSourceCardDto, String> {
    let card =
        tokio::task::spawn_blocking(move || omnipanel_ai::agent_source_registry().refresh(&id))
            .await
            .map_err(|e| e.to_string())??;
    Ok(card.into())
}

pub async fn open_agent_provider(
    state: &AppState,
    source_id: &str,
    model_id: &str,
) -> Result<Option<Box<dyn omnipanel_ai::AiProvider>>, String> {
    let source_id_for_origin = source_id.to_string();
    let origin = tokio::task::spawn_blocking(move || {
        omnipanel_ai::agent_source_registry()
            .get(&source_id_for_origin)
            .map(|source| source.upstream_origin().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(origin) = origin else {
        return Ok(None);
    };
    let proxy_config = state.proxy_config.lock().await.clone();
    let client = crate::commands::proxy::build_http_client_for_url(
        &origin,
        &proxy_config,
        std::time::Duration::from_secs(300),
    )?;
    let source_id = source_id.to_string();
    let model_id = model_id.to_string();
    tokio::task::spawn_blocking(move || {
        omnipanel_ai::agent_source_registry().open_provider(&source_id, &model_id, client)
    })
    .await
    .map_err(|e| e.to_string())?
}
