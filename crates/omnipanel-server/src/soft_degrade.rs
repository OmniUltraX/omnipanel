//! Web IPC 未知命令软降级（**由 scripts/gen-soft-degrade-stubs.mjs 生成，勿手改**）。
//!
//! 原则：
//! 1. 返回类型含数组字段的 object → 带空数组的形状 stub（禁止回 `[]`）
//! 2. bindings 为 T[] 的未注册命令 → `[]`
//! 3. 其余未知 object / 默认 → `{}`（历史默认 `[]` 是 `.tools is not iterable` 主因）
//! 4. void / 写操作类 → `null`
//!
//! 重新生成：`node scripts/gen-soft-degrade-stubs.mjs`
//! 校验：`node scripts/audit-soft-degrade.mjs`

/// 按命令名返回软降级 JSON 值（调用方包进 InvokeResponse::ok）。
pub fn soft_degrade_value(cmd: &str) -> serde_json::Value {
    let c = cmd.to_ascii_lowercase();
    tracing::warn!(cmd, "web ipc: unknown command, soft-degrade");

    // DbQueryResult：必须先于 list 兜底
    let looks_like_query_result = c.starts_with("db_")
        && (c.contains("redis_client")
            || (c.contains("redis_config_get") && !c.contains("entries"))
            || c.contains("execute_query")
            || c.contains("run_sql")
            || c.contains("preview_table")
            || c.ends_with("_query")
            || c.contains("_query_"));
    if looks_like_query_result {
        return serde_json::json!({
            "columns": [],
            "rows": [],
            "rowsAffected": 0
        });
    }

    // 主机监控快照（未注册时的兜底；已注册走 monitoring 模块）
    if (c.contains("fetch_stats") || c == "local_fetch_stats") && !c.contains("tab_stats") {
        return serde_json::json!({
            "hostId": "local-terminal",
            "hostName": "localhost",
            "load": "0.00 0.00 0.00",
            "cpu": {
                "usage": null,
                "cores": 0,
                "perCoreUsage": [],
                "load1": null,
                "load5": null,
                "load15": null
            },
            "cpuCores": 0,
            "cpuUsage": null,
            "memory": {
                "total": null,
                "used": null,
                "available": null,
                "swapTotal": null,
                "swapUsed": null,
                "swapAvailable": null
            },
            "disk": { "total": null, "used": null, "available": null, "disks": [] },
            "gpu": { "devices": [] },
            "network": { "rxBytes": null, "txBytes": null },
            "osInfo": "",
            "uptimeSecs": null,
            "timestamp": null
        });
    }

    // --- generated shaped object stubs ---
    if c == "acp_connect"
        || c == "acp_connect_default"
        || c == "acp_disconnect"
        || c == "acp_get_status" {
        // AcpStatus arrays=[]
        return serde_json::json!({ "connected": false, "agentName": null, "executable": null });
    }

    if c == "agent_prompt_reset"
        || c == "agent_prompt_save" {
        // AgentPromptEntry arrays=[]
        return serde_json::json!({ "id": "", "content": "", "path": "" });
    }

    if c == "ai_services_probe" {
        // AiServicesHealth arrays=[]
        return serde_json::json!({ "gateway": false, "mcp": false });
    }

    if c == "ssh_pool_list_archive_entries" {
        // ArchiveListResult arrays=[entries]
        return serde_json::json!({ "entries": [], "format": "", "totalUncompressed": null, "toolMissing": null });
    }

    if c == "ssh_pool_install_archive_tool" {
        // ArchiveToolInstallResult arrays=[]
        return serde_json::json!({ "tool": "", "installed": false, "message": "" });
    }

    if c == "assistant_chat_fetch_object" {
        // AssistantChatInboundEvent arrays=[contexts]
        return serde_json::json!({ "contexts": [], "messageId": "", "objectKey": "", "createdAt": "", "text": "", "sessionId": "", "askUser": null });
    }

    if c == "assistant_upload_oss_text" {
        // AssistantUploadTextResult arrays=[]
        return serde_json::json!({ "objectKey": "", "etag": null, "bytes": null });
    }

    if c == "auth_account_links" {
        // AuthAccountLinks arrays=[]
        return serde_json::json!({ "wechat": null, "github": null, "email": null });
    }

    if c == "auth_bindings_wait" {
        // AuthBindingsBound arrays=[]
        return serde_json::json!({ "bindId": "" });
    }

    if c == "auth_bindings_qrcode" {
        // AuthBindingsQrcode arrays=[]
        return serde_json::json!({ "bindId": "", "qrPayload": "", "expireInSec": 0 });
    }

    if c == "auth_device_identity" {
        // AuthDeviceIdentity arrays=[]
        return serde_json::json!({ "deviceId": "", "deviceName": "", "osType": "" });
    }

    if c == "auth_link_email_send"
        || c == "auth_login_email_send" {
        // AuthEmailCodeSent arrays=[]
        return serde_json::json!({ "email": "", "code": "", "expireInSec": 0, "hint": "" });
    }

    if c == "auth_link_wechat_qrcode"
        || c == "auth_login_qrcode" {
        // AuthLoginQrcode arrays=[]
        return serde_json::json!({ "loginId": "", "scene": "", "ticket": "", "qrcodeUrl": "", "expireInSec": 0 });
    }

    if c == "auth_login_email"
        || c == "auth_login_github"
        || c == "auth_login_wait" {
        // AuthLoginSuccess arrays=[]
        return serde_json::json!({ "token": "", "openid": "" });
    }

    if c == "auth_presence" {
        // AuthPresenceResult arrays=[]
        return serde_json::json!({ "ok": false, "ttlSec": null });
    }

    if c == "auth_public_qrcodes" {
        // AuthPublicQrcodes arrays=[]
        return serde_json::json!({ "miniappUrl": "", "h5Url": "", "feedbackGroupUrl": "", "id": null, "openid": "", "nickname": "", "avatarUrl": "", "email": "", "githubId": "", "ossPath": "" });
    }

    if c == "auth_get_me"
        || c == "auth_link_email"
        || c == "auth_unlink_email"
        || c == "auth_unlink_github"
        || c == "auth_unlink_wechat"
        || c == "auth_update_profile" {
        // AuthUserProfile arrays=[]
        return serde_json::json!({ "id": null, "openid": "", "nickname": "", "avatarUrl": "", "email": "", "githubId": "", "ossPath": "" });
    }

    if c == "builtin_tool_set_enabled" {
        // BuiltinToolRecord arrays=[]
        return serde_json::json!({ "tool_name": "", "module_key": "", "description": "", "internal_enabled": false, "external_exposed": false, "input_schema": "" });
    }

    if c == "ssh_pool_probe_capabilities" {
        // CapabilityProbeResult arrays=[tools,lazyProbeIds]
        return serde_json::json!({ "tools": [], "lazyProbeIds": [], "resourceId": "", "elapsedMs": 0, "probedAt": 0 });
    }

    if c == "sniffer_get_stats" {
        // CaptureStats arrays=[]
        return serde_json::json!({ "captureId": "", "iface": "", "filter": "", "running": false, "packetCount": null, "startedAt": "" });
    }

    if c == "client_sync_pull_conversations" {
        return serde_json::json!({ "found": false, "objectKey": null, "bodyJson": null, "bytes": null });
    }

    if c == "client_sync_pull_modules" {
        return serde_json::json!({ "found": false, "objectKey": null, "bytes": null, "appliedConnections": null, "appliedDatabases": null, "appliedKnowledge": null, "appliedHttpRequests": null, "appliedWorkspaces": null, "workspacesJson": null, "sshSidebarTreeJson": null, "folderTreesJson": null });
    }

    if c == "client_sync_push_conversations" {
        // ClientSyncPushConversationsResult arrays=[]
        return serde_json::json!({ "objectKey": "", "etag": null, "bytes": null });
    }

    if c == "client_sync_push_modules" {
        // ClientSyncPushModulesResult arrays=[]
        return serde_json::json!({ "objectKey": "", "etag": null, "bytes": null });
    }

    if c == "cli_provider_patch_cmd"
        || c == "cli_provider_upsert_cmd" {
        // CliProviderRecord arrays=[args,staticModels,manualModelNames,disabledModelNames,modelDiscoveryArgs]
        return serde_json::json!({ "args": [], "staticModels": [], "manualModelNames": [], "disabledModelNames": [], "modelDiscoveryArgs": [], "id": "", "displayName": "", "protocol": "", "binary": null, "env": "", "cwd": null, "timeoutSecs": null, "enabled": false, "builtin": false, "modelDiscoveryCommand": null });
    }

    if c == "file_save_connection" {
        // Connection arrays=[tags]
        return serde_json::json!({ "tags": [], "id": "", "kind": null, "name": "", "group": "", "envTag": "", "config": "", "credentialRef": null, "createdAt": null, "updatedAt": null });
    }

    if c == "db_data_sync_generate_sql" {
        // DbDataSyncSqlGenerateResult arrays=[]
        return serde_json::json!({ "filePath": "", "statementCount": 0 });
    }

    if c == "db_introspect_schema" {
        // DbIntrospectResult_Serialize arrays=[tables,views,routines]
        return serde_json::json!({ "tables": [], "views": [], "routines": [], "database": "" });
    }

    if c == "db_get_table_details" {
        // DbTableDetails_Serialize arrays=[]
        return serde_json::json!({ "rowCount": null, "dataLength": null, "rowFormat": null, "engine": null, "createTime": null, "updateTime": null, "comment": null, "collation": null });
    }

    if c == "db_introspect_table" {
        // DbTableSchema_Serialize arrays=[columns,indexes]
        return serde_json::json!({ "columns": [], "indexes": [], "name": "", "comment": null });
    }

    if c == "docker_probe_ssh_docker" {
        // DockerAutoDetectResult arrays=[]
        return serde_json::json!({ "available": false, "version": null, "os": null, "containers": 0, "images": 0, "error": null });
    }

    if c == "docker_scan_ssh_docker_hosts" {
        // DockerScanResult arrays=[items]
        return serde_json::json!({ "items": [], "scanned": 0, "created": 0, "updated": 0, "unchanged": 0, "noDocker": 0, "failed": 0 });
    }

    if c == "ssh_pool_enable_panel_api" {
        // EnablePanelApiResult arrays=[]
        return serde_json::json!({ "kind": "", "enabled": false, "apiKey": "", "message": "", "restarted": false });
    }

    if c == "file_index_build"
        || c == "file_index_status" {
        // FileIndexStatus arrays=[]
        return serde_json::json!({ "connectionId": "", "status": "", "rootPath": "", "indexedCount": null, "error": "", "startedAt": null, "finishedAt": null });
    }

    if c == "file_index_storage_info" {
        // FileIndexStorageInfo arrays=[]
        return serde_json::json!({ "storageDir": "", "databasePath": "", "defaultDir": "", "isCustom": false });
    }

    if c == "file_transfer_list" {
        // FileTransferListResult arrays=[jobs]
        return serde_json::json!({ "jobs": [] });
    }

    if c == "file_transfer_plan" {
        // FileTransferPlanResult arrays=[]
        return serde_json::json!({ "route": null, "routeReason": "", "needsDirectConfirm": false });
    }

    if c == "grpc_call" {
        // GrpcCallResponse arrays=[headers]
        return serde_json::json!({ "headers": [], "responseJson": "", "statusCode": 0, "grpcStatus": 0, "durationMs": null });
    }

    if c == "ssh_pool_install_tool" {
        // InstallToolResult arrays=[]
        return serde_json::json!({ "toolId": "", "installed": false, "message": "", "state": null });
    }

    if c == "knowledge_save_asset" {
        // KnowledgeAssetSaved arrays=[]
        return serde_json::json!({ "entryId": "", "fileName": "", "absolutePath": "" });
    }

    if c == "knowledge_list_chunks" {
        // KnowledgeChunkListResult arrays=[chunks]
        return serde_json::json!({ "chunks": [], "total": null, "offset": null, "limit": null });
    }

    if c == "knowledge_delete_chunks" {
        // KnowledgeDeleteChunksResult arrays=[]
        return serde_json::json!({ "entryId": "", "deleted": null, "remaining": null });
    }

    if c == "knowledge_import_pdf"
        || c == "knowledge_restore_revision" {
        // KnowledgeEntry arrays=[tags]
        return serde_json::json!({ "tags": [], "id": "", "kind": "", "title": "", "content": "", "riskLevel": "", "source": "", "envTag": "", "language": "", "usageCount": null, "createdAt": null, "updatedAt": null, "parentId": "", "nodeType": "", "sortOrder": null, "resourceType": "", "resourceId": "" });
    }

    if c == "knowledge_vectorize" {
        // KnowledgeVectorizeResult arrays=[]
        return serde_json::json!({ "entryId": "", "chunkCount": null, "embeddedAt": null });
    }

    if c == "local_runtime_install_ollama" {
        // LocalRuntimeInstallResult arrays=[]
        return serde_json::json!({ "method": "", "started": false, "message": "", "manualUrl": "" });
    }

    if c == "local_runtime_probe"
        || c == "local_runtime_refresh_catalog" {
        // LocalRuntimeProbeResult arrays=[recommendedModels]
        return serde_json::json!({ "recommendedModels": [], "ollama": null, "lmStudio": null, "hardware": null, "totalMemoryMb": null, "hardwareTier": "", "catalogSource": "" });
    }

    if c == "local_log_open"
        || c == "sftp_log_open" {
        // LogSessionInfo arrays=[]
        return serde_json::json!({ "sizeBytes": null, "totalLines": null, "linesEstimated": false });
    }

    if c == "local_log_tail_start"
        || c == "sftp_log_tail_start" {
        // LogTailHandle arrays=[]
        return serde_json::json!({ "token": "" });
    }

    if c == "local_runtime_probe_openai_compat" {
        // OpenAiCompatProbeResult arrays=[models]
        return serde_json::json!({ "models": [], "reachable": false, "endpoint": "", "error": null });
    }

    if c == "detect_opencode_install" {
        // OpenCodeInstallStatus arrays=[]
        return serde_json::json!({ "installed": false, "executablePath": null, "version": null });
    }

    if c == "ssh_pool_probe_panels" {
        // PanelProbeResult arrays=[panels]
        return serde_json::json!({ "panels": [], "resourceId": "", "elapsedMs": 0, "probedAt": 0 });
    }

    if c == "pool_get_summary" {
        // PoolSummary arrays=[categories]
        return serde_json::json!({ "categories": [], "active": 0, "idle": 0 });
    }

    if c == "provider_registry_load" {
        // ProvidersFile arrays=[httpProviders,cliProviders]
        return serde_json::json!({ "httpProviders": [], "cliProviders": [], "version": 0 });
    }

    if c == "get_proxy_config" {
        // ProxyConfig arrays=[]
        return serde_json::json!({ "enabled": false, "protocol": "", "host": "", "port": 0, "username": "", "password": "" });
    }

    if c == "assistant_push_snapshot" {
        // PushSnapshotResult arrays=[]
        return serde_json::json!({ "objectKey": "", "etag": null, "bytes": null, "fileCount": null, "generatedAt": "", "dryRun": false });
    }

    if c == "db_redis_key_detail" {
        // RedisKeyDetail_Serialize arrays=[]
        return serde_json::json!({ "key": "", "keyType": "", "ttl": null, "sizeBytes": null, "valueJson": "", "valueTruncated": false });
    }

    if c == "db_redis_search_keys" {
        // RedisSearchKeysResult_Serialize arrays=[entries]
        return serde_json::json!({ "entries": [], "nextCursor": null, "hasMore": false, "scanLimitHit": false });
    }

    if c == "resource_collect_database_snapshot"
        || c == "resource_collect_ssh_snapshot" {
        // ResourceSnapshotResult arrays=[savedKinds,errors]
        return serde_json::json!({ "savedKinds": [], "errors": [] });
    }

    if c == "db_sync_row_diff_page" {
        // RowDiffPageResult_Serialize arrays=[diffs]
        return serde_json::json!({ "diffs": [], "total": 0, "kindCounts": null });
    }

    if c == "secrets_vault_pull" {
        // SecretsVaultPullResult arrays=[]
        return serde_json::json!({ "imported": 0, "skipped": 0, "secretCount": 0 });
    }

    if c == "secrets_vault_push" {
        // SecretsVaultPushResult arrays=[]
        return serde_json::json!({ "objectKey": "", "secretCount": 0, "bytes": 0 });
    }

    if c == "secrets_vault_status"
        || c == "secrets_vault_unlock" {
        // SecretsVaultStatus arrays=[]
        return serde_json::json!({ "unlocked": false, "hasLocalSalt": false, "secretCount": 0 });
    }

    if c == "sync_master_key_status" {
        return serde_json::json!({ "hasKey": false, "key": null });
    }
    if c == "sync_master_key_get_or_create" {
        return serde_json::json!({ "key": "", "created": false });
    }
    if c == "sync_master_key_validate" {
        return serde_json::json!(false);
    }
    if c == "sync_pairing_create_keypair" {
        return serde_json::json!({ "pubkeyB64": "" });
    }
    if c == "sync_pairing_wrap_key" {
        return serde_json::json!({ "wrappedKey": "", "wrapAlg": "" });
    }

    if c == "sftp_probe_media" {
        // SftpMediaProbe arrays=[]
        return serde_json::json!({ "durationSecs": null, "size": null, "posterDataUrl": null });
    }

    if c == "sftp_open_media_stream" {
        // SftpMediaStream arrays=[]
        return serde_json::json!({ "url": "", "token": "", "size": null, "mime": "" });
    }

    if c == "skill_get" {
        // SkillDetail arrays=[]
        return serde_json::json!({ "id": "", "name": "", "description": "", "enabled": false, "body": "" });
    }

    if c == "skill_create"
        || c == "skill_import"
        || c == "skill_set_enabled"
        || c == "skill_update" {
        // SkillRecord arrays=[]
        return serde_json::json!({ "id": "", "name": "", "description": "", "enabled": false, "path": "", "createdAt": null, "updatedAt": null });
    }

    if c == "skill_vectorize" {
        // SkillVectorizeResult arrays=[]
        return serde_json::json!({ "skillId": "", "chunkCount": null });
    }

    if c == "ssh_pool_create_run_script" {
        // SshCreateRunScriptOutput arrays=[]
        return serde_json::json!({ "remotePath": "", "stdout": "", "stderr": "", "exitCode": 0 });
    }

    if c == "ssh_pool_exec_command" {
        // SshExecOutput arrays=[]
        return serde_json::json!({ "stdout": "", "stderr": "", "exitCode": 0 });
    }

    if c == "ssh_pool_load_overview" {
        // SshHostOverview_Serialize arrays=[processes]
        return serde_json::json!({ "processes": [], "stats": null });
    }

    if c == "ssh_generate_key"
        || c == "ssh_import_key" {
        // SshKeyInfo arrays=[]
        return serde_json::json!({ "name": "", "keyType": "", "path": "", "fingerprint": "", "comment": "" });
    }

    if c == "local_process_detail"
        || c == "ssh_pool_process_detail" {
        // SshProcessDetail_Serialize arrays=[args,openFiles]
        return serde_json::json!({ "args": [], "openFiles": [], "pid": 0, "commandLine": null, "cwd": null, "exe": null, "root": null });
    }

    if c == "ssh_terminal_info" {
        // SshTerminalInfo arrays=[]
        return serde_json::json!({ "mode": null, "host": "", "tmuxVersion": null, "tmuxSession": null, "tmuxPaneId": null, "fallbackReason": null });
    }

    if c == "tag_create"
        || c == "tag_move"
        || c == "tag_rename"
        || c == "tag_set_color" {
        // TagDto arrays=[]
        return serde_json::json!({ "id": "", "name": "", "parentId": null, "path": "", "color": null, "kind": "", "createdAt": null, "updatedAt": null, "resourceCount": null });
    }

    if c == "task_get"
        || c == "task_get_output"
        || c == "task_save" {
        // Task arrays=[]
        return serde_json::json!({ "id": "", "task_type": null, "title": "", "description": "", "resource_id": "", "resource_name": "", "env_tag": "", "command": "", "risk": null, "status": null, "source": null, "output": "", "created_at": null, "updated_at": null, "started_at": null, "finished_at": null });
    }

    if c == "check_update" {
        // UpdateInfo arrays=[]
        return serde_json::json!({ "available": false, "version": "", "body": "", "current_version": "" });
    }

    if c == "web_search_test_fetch" {
        // WebFetchTestResultDto arrays=[]
        return serde_json::json!({ "backend": "", "ok": false, "errorKind": null, "message": "", "length": 0 });
    }

    if c == "web_search_get_config" {
        // WebSearchConfigDto arrays=[]
        return serde_json::json!({ "version": 0, "enabled": false, "search": null, "fetch": null });
    }

    if c == "web_search_test_backend" {
        // WebSearchTestResultDto arrays=[]
        return serde_json::json!({ "backend": "", "ok": false, "errorKind": null, "message": "", "sampleCount": 0 });
    }

    if c == "workflow_get"
        || c == "workflow_save" {
        // WorkflowDetail arrays=[steps]
        return serde_json::json!({ "steps": [], "workflow": null });
    }

    if c == "workflow_run" {
        // WorkflowExecution arrays=[]
        return serde_json::json!({ "id": "", "workflow_id": "", "status": null, "triggered_by": "", "started_at": null, "finished_at": null, "duration_ms": null, "output": "" });
    }

    if c == "workflow_get_execution" {
        // WorkflowExecutionDetail arrays=[steps]
        return serde_json::json!({ "steps": [], "execution": null });
    }

    // bindings 标注为 T[] 但未注册的命令 + 命名启发式
    let force_array = matches!(
        c.as_str(),
        "agent_prompt_list"
            | "ai_list_backends"
            | "audit_log_recent"
            | "auth_list_devices"
            | "bg_task_history_list"
            | "bg_task_list"
            | "builtin_tool_audit_list"
            | "cli_provider_list_cmd"
            | "cloud_list_certs"
            | "cloud_list_domains"
            | "cloud_list_ecs"
            | "cloud_list_oss"
            | "cloud_list_swas"
            | "db_batch_table_ddl"
            | "db_list_character_sets"
            | "db_list_connection_users"
            | "db_list_databases_with_stats"
            | "db_list_table_details"
            | "db_mysql_export_list"
            | "db_redis_slowlog"
            | "db_schema_sync_preview_sql"
            | "detect_all_agents"
            | "docker_list_ssh_hosts"
            | "file_index_search"
            | "grpc_list_connections"
            | "knowledge_list"
            | "knowledge_list_revisions"
            | "knowledge_query_document"
            | "knowledge_recall_test"
            | "knowledge_search"
            | "knowledge_tags"
            | "knowledge_todo_list"
            | "list_system_fonts"
            | "local_log_read_lines"
            | "local_log_tail_initial"
            | "modbus_read_coils"
            | "modbus_read_discrete_inputs"
            | "modbus_read_holding_registers"
            | "modbus_read_input_registers"
            | "provider_list_models_cmd"
            | "resolve_host"
            | "resource_add_tag"
            | "resource_find_similar"
            | "resource_list_knowledge"
            | "resource_list_profiles"
            | "resource_list_tags"
            | "resource_remove_tag"
            | "resource_set_tags"
            | "search_everywhere"
            | "sftp_download"
            | "sftp_list"
            | "sftp_log_read_lines"
            | "sftp_log_tail_initial"
            | "skill_get_version_chain"
            | "skill_list"
            | "skill_list_applications"
            | "skill_list_db"
            | "skill_vectorize_all"
            | "sniffer_get_packets"
            | "sniffer_list_interfaces"
            | "ssh_list_config_hosts"
            | "ssh_pool_get_active_sessions"
            | "ssh_tmux_list_sessions"
            | "ssh_tmux_list_windows"
            | "ssh_tmux_tab_stats"
            | "tag_list_tree"
            | "tag_list_used_by"
            | "tag_query_resources"
            | "tag_suggest"
            | "task_events_list"
            | "task_list"
            | "terminal_history_load_session"
            | "third_party_account_list"
            | "todo_list_list"
            | "todo_task_list"
            | "workflow_executions"
            | "workflow_list"
    )
        || c.contains("_list")
        || c.starts_with("list_")
        || c.ends_with("_counts")
        || (c.contains("_history") && !c.contains("_add_") && !c.contains("_clear_"))
        || c.ends_with("_keys")
        || c.ends_with("_hosts")
        || c.ends_with("_sessions")
        || c.ends_with("_traces")
        || c.ends_with("_processes")
        || c.ends_with("_statuses")
        || c.ends_with("_entries")
        || c.ends_with("_packets")
        || c.ends_with("_services")
        || c.ends_with("_tags")
        || c.ends_with("_lines")
        || c.contains("_search")
        || c.contains("load_processes")
        || c.contains("get_statuses")
        || c.ends_with("_slowlog")
        || c.ends_with("tab_stats");

    if force_array {
        return serde_json::json!([]);
    }

    let looks_like_object = c.contains("_fetch_")
        || c.ends_with("_stats")
        || c.contains("_stats_")
        || c.ends_with("_load")
        || c.contains("_load_")
        || c.ends_with("_status")
        || c.contains("_get_")
        || c.starts_with("get_")
        || c.ends_with("_snapshot")
        || c.ends_with("_overview")
        || c.ends_with("_info")
        || c.ends_with("_config")
        || c.ends_with("_meta")
        || c.ends_with("_cache")
        || c.ends_with("_detail")
        || c.contains("probe_");

    if looks_like_object
        && (c.contains("sidebar_cache")
            || c.contains("schema_cache")
            || (c.ends_with("_cache") && c.contains("_load_")))
    {
        return serde_json::json!({ "connections": {} });
    }

    if looks_like_object {
        return serde_json::json!({});
    }

    let looks_like_void = c.starts_with("set_")
        || c.contains("_set_")
        || c.contains("_save")
        || c.contains("_delete")
        || c.contains("_clear")
        || c.contains("_cancel")
        || c.contains("_sync")
        || c.contains("_update")
        || c.contains("_push")
        || c.contains("_submit")
        || c.ends_with("_noop")
        || c.starts_with("bg_task_")
        || c.contains("_invalidate")
        || c.contains("_release")
        || c.contains("_unsubscribe");

    if looks_like_void {
        return serde_json::json!(null);
    }

    // 默认 {}：禁止再默认 []
    serde_json::json!({})
}
