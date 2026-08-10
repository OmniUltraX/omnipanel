from pathlib import Path

p = Path(r"c:/Users/chaoj/dev/omnipanel/crates/omnipanel-server/src/ipc.rs")
t = p.read_text(encoding="utf-8")
marker = "        other => InvokeResponse::ok(crate::soft_degrade::soft_degrade_value(other)),"
block = r'''
        /* ---------------- P5 provider / web_search / builtin / backends ---------------- */
        "ai_list_backends" => respond(crate::ai::ai_list_backends().await),
        "provider_list_models_cmd" => {
            let provider_id = get_str(&args, "providerId").unwrap_or_default();
            respond(crate::skills_cmds::provider_list_models(&provider_id))
        }
        "cli_provider_list_cmd" => respond(crate::skills_cmds::cli_provider_list()),
        "cli_provider_patch_cmd" => {
            let input = match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
            };
            respond(crate::skills_cmds::cli_provider_patch(input))
        }
        "cli_provider_upsert_cmd" => {
            let input = match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
            };
            respond(crate::skills_cmds::cli_provider_upsert(input))
        }
        "cli_provider_remove_cmd" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::cli_provider_remove(&id))
        }
        "embedding_provider_get" => respond_omni(crate::embedding_cmds::embedding_provider_get().await),
        "embedding_provider_sync" => {
            let provider = match serde_json::from_value(args.get("provider").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid provider: {e}")),
            };
            respond_omni(crate::embedding_cmds::embedding_provider_sync(provider).await)
        }
        "web_search_get_config" => respond_omni(crate::web_search_cmds::web_search_get_config().await),
        "web_search_set_config" => {
            let config = match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid config: {e}")),
            };
            respond_omni(crate::web_search_cmds::web_search_set_config(config).await)
        }
        "web_search_set_exa_key" => {
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_exa_key(api_key).await)
        }
        "web_search_exa_key_configured" => respond_omni(crate::web_search_cmds::web_search_exa_key_configured().await),
        "web_search_set_jina_key" => {
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_jina_key(api_key).await)
        }
        "web_search_jina_key_configured" => respond_omni(crate::web_search_cmds::web_search_jina_key_configured().await),
        "web_search_set_zhihu_secret" => {
            let secret = get_str(&args, "secret").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_zhihu_secret(secret).await)
        }
        "web_search_zhihu_secret_configured" => respond_omni(crate::web_search_cmds::web_search_zhihu_secret_configured().await),
        "web_search_test_backend" => {
            let backend = get_str(&args, "backend").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_test_backend(backend).await)
        }
        "web_search_test_fetch" => {
            let url = get_str(&args, "url").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_test_fetch(url).await)
        }
        "builtin_tool_audit_list" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::store_bridge::builtin_tool_audit_list(state, limit).await)
        }
        "builtin_tool_set_enabled" => {
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            respond_omni(crate::store_bridge::builtin_tool_set_enabled(state, tool_name, enabled).await)
        }

'''
if '"ai_list_backends"' in t:
    print("already registered")
elif marker not in t:
    raise SystemExit("marker missing")
else:
    p.write_text(t.replace(marker, block + marker, 1), encoding="utf-8")
    print("inserted p5 arms")
