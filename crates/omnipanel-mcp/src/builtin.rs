use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rmcp::{
    handler::server::{
        tool::ToolCallContext,
        wrapper::Parameters,
    },
    model::{CallToolResult, Content, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler,
};
use tokio::sync::Mutex;

use omnipanel_store::{KnowledgeEntry, Storage};

use crate::exposed_tools::merge_exposed_spec_tools;
use crate::omni_module::{
    ensure_tool_allowed_for_module, filter_tools_for_request, request_omni_module_scope,
};
use crate::registry::native::is_router_native_tool;
use crate::registry::omnimcp_execute::execute_omnimcp_tool;

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

    #[tool(
        name = "omni_knowledge_create_document",
        description = "Create a knowledge document in the knowledge base"
    )]
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
            resource_type: String::new(),
            resource_id: String::new(),
        };

        let storage = self.storage.lock().await;
        storage
            .save_knowledge(&entry)
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;

        Ok(CallToolResult::success(vec![Content::text(
            serde_json::json!({ "id": id }).to_string(),
        )]))
    }

    #[tool(
        name = "omni_knowledge_remove_document",
        description = "Remove a knowledge document by its ID"
    )]
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

    #[tool(
        name = "omni_knowledge_list_documents",
        description = "List knowledge documents, optionally filtered by kind or tag"
    )]
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
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let scope = request_omni_module_scope(&context);
        let storage = self.storage.lock().await;
        let router_tools = self.tool_router.list_all();
        let merged = merge_exposed_spec_tools(&storage, router_tools);
        let tools = filter_tools_for_request(
            merged,
            &scope,
            |name| storage.builtin_tool_is_exposed_available(name).unwrap_or(false),
        );
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = request_omni_module_scope(&context);
        let tool_name = request.name.as_ref();
        ensure_tool_allowed_for_module(tool_name, &scope)
            .map_err(|message| ErrorData::invalid_params(message, None))?;

        {
            let storage = self.storage.lock().await;
            if !storage.builtin_tool_is_exposed_available(tool_name).unwrap_or(false) {
                return Err(ErrorData::invalid_params(
                    format!("MCP 工具不可用: {tool_name}"),
                    None,
                ));
            }
        }

        if is_router_native_tool(tool_name) {
            let tcc = ToolCallContext::new(self, request, context);
            return self.tool_router.call(tcc).await;
        }

        let arguments = request.arguments.clone().map_or_else(
            || serde_json::Value::Object(serde_json::Map::new()),
            serde_json::Value::Object,
        );

        match execute_omnimcp_tool(tool_name, arguments, self.storage.clone()).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(message) => Err(ErrorData::internal_error(message, None)),
        }
    }

    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "OmniMCP is the built-in MCP server of OmniPanel. \
                 Tool names follow omni_{module}_{function_name} (e.g. omni_knowledge_create_document). \
                 Send HTTP header X-Omni-Module (e.g. knowledge, database, terminal) to list only tools for that module; \
                 set X-Omni-Module=master to receive all enabled tools. \
                 Requests without the header or with an empty value receive no tools.",
            )
    }
}
