use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ServerHandler,
};
use tokio::sync::Mutex;

use omnipanel_store::{KnowledgeEntry, Storage};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateDocumentParams {
    title: String,
    content: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    tags: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    env_tag: Option<String>,
    #[serde(default)]
    risk_level: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RemoveDocumentParams {
    id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListDocumentsParams {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    tag: Option<String>,
}

#[derive(Clone)]
pub struct OmniMcpHandler {
    #[allow(dead_code)]
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
    storage: Arc<Mutex<Storage>>,
}

#[tool_router]
impl OmniMcpHandler {
    pub fn new(storage: Arc<Mutex<Storage>>) -> Self {
        Self {
            tool_router: Self::tool_router(),
            storage,
        }
    }

    #[tool(description = "Create a knowledge document in the knowledge base")]
    async fn create_document(
        &self,
        Parameters(CreateDocumentParams {
            title,
            content,
            kind,
            tags,
            source,
            env_tag,
            risk_level,
            parent_id,
        }): Parameters<CreateDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        let id = format!("doc_{now}");
        let entry = KnowledgeEntry {
            id: id.clone(),
            kind: kind.unwrap_or_else(|| "snippet".to_string()),
            title,
            content,
            tags: tags
                .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
                .unwrap_or_default(),
            risk_level: risk_level.unwrap_or_else(|| "safe".to_string()),
            source: source.unwrap_or_else(|| "mcp".to_string()),
            env_tag: env_tag.unwrap_or_else(|| "dev".to_string()),
            language: String::new(),
            usage_count: 0,
            created_at: now as i64,
            updated_at: now as i64,
            parent_id: parent_id.unwrap_or_default(),
            node_type: "document".to_string(),
            sort_order: 0,
        };

        let storage = self.storage.lock().await;
        storage
            .save_knowledge(&entry)
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(
            serde_json::json!({ "id": id }).to_string(),
        )]))
    }

    #[tool(description = "Remove a knowledge document by its ID")]
    async fn remove_document(
        &self,
        Parameters(RemoveDocumentParams { id }): Parameters<RemoveDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let storage = self.storage.lock().await;
        storage
            .delete_knowledge(&id)
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(
            serde_json::json!({ "deleted": true, "id": id }).to_string(),
        )]))
    }

    #[tool(description = "List knowledge documents, optionally filtered by kind or tag")]
    async fn list_documents(
        &self,
        Parameters(ListDocumentsParams { kind, tag }): Parameters<ListDocumentsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let storage = self.storage.lock().await;
        let entries = storage
            .list_knowledge(kind.as_deref(), tag.as_deref())
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string()),
        )]))
    }
}

#[tool_handler]
impl ServerHandler for OmniMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "OmniMCP is the built-in MCP server of OmniPanel. \
                 It provides knowledge-base operations (create/remove/list documents).",
            )
    }
}
