//! 本机个人空间：启动时判断要不要首次导航，并记下空间名称。

use omnipanel_assistant::{
    SpaceLocation, TEAM_CONVERSATIONS_LATEST_LEAF, TEAM_MODULES_LATEST_LEAF, fetch_space_location,
    publish_space_location, pull_team_sync_json, purge_s3_repo, sync_oss_space, sync_s3_space,
    team_repo_has_index,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    LayoutInput, LocalSpaceRecord, LocalSpaceStatus, SYNC_KIND_CONVERSATIONS, SYNC_KIND_MODULES,
    SpaceClaimChoice, SpaceClaimStatus, SpaceConflict, SpaceRepoReport, SpaceStorageInput,
    SpaceStorageSettings, SpaceSyncReport, SpaceSyncRequest, active_team_scope, ai_providers_path,
    apply_database_files, attach_layouts, copy_team_dir_if_absent, database_connections_path,
    delete_space_conflict, desktop_plugin_dirs, get_or_create_sync_team_key,
    http_proxy_config_path, layout_files, legacy_conversation_files, legacy_module_files,
    list_space_conflicts, restore_plugin_packs, stage_plugin_packs, team_data_dir,
    web_search_config_path,
};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

use crate::commands::assistant::build_auth_context;
use crate::commands::auth::{
    auth_device_identity, auth_get_me, decode_sync_team_payload, resolve_sync_team,
};
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn local_space_status(state: State<'_, AppState>) -> Result<LocalSpaceStatus, OmniError> {
    let storage = state.storage.lock().await;
    storage.local_space_status()
}

#[tauri::command]
#[specta::specta]
pub async fn local_space_complete(
    state: State<'_, AppState>,
    name: String,
) -> Result<LocalSpaceRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.local_space_complete(&name)
}

/// 把当前库里的固定记录写成一路径一文件，并在本机打出内容索引。不上传。
#[tauri::command]
#[specta::specta]
pub async fn local_space_rebuild_repo(
    state: State<'_, AppState>,
) -> Result<SpaceRepoReport, OmniError> {
    let root = team_data_dir()?;
    let storage = state.storage.lock().await;
    storage.rebuild_space_repo(&root)
}

/// 按路径把本机检出和云端仓库合并。未登录只重建本机索引。
#[tauri::command]
#[specta::specta]
pub async fn local_space_sync(
    state: State<'_, AppState>,
    request: SpaceSyncRequest,
) -> Result<SpaceSyncReport, OmniError> {
    run_local_space_sync(&state, request).await
}

async fn run_local_space_sync(
    state: &State<'_, AppState>,
    request: SpaceSyncRequest,
) -> Result<SpaceSyncReport, OmniError> {
    // 主窗口和快速启动会各拉一次，自动同步也会撞上。同时改检出目录会读到已删的文件。
    static GATE: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _guard = GATE.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let root = team_data_dir()?;
    let (mut extra, managed) = layout_files(LayoutInput {
        ssh_sidebar_tree_json: request.ssh_sidebar_tree_json.as_deref(),
        folder_trees_json: request.folder_trees_json.as_deref(),
        custom_panels_json: request.custom_panels_json.as_deref(),
        workspaces_json: request.workspaces_json.as_deref(),
        conversations_json: request.conversations_json.as_deref(),
        settings_json: request.settings_json.as_deref(),
    })?;
    stage_global_files(&mut extra);
    for dir in desktop_plugin_dirs() {
        let _ = stage_plugin_packs(&dir, &mut extra);
    }
    let index_id = {
        let storage = state.storage.lock().await;
        let device_id = crate::commands::auth::current_device_id().unwrap_or_default();
        storage
            .rebuild_space_repo_for(&root, &extra, &device_id)?
            .index_id
    };
    if request.token.trim().is_empty() {
        let mut report = SpaceSyncReport::local_only(index_id);
        attach_layouts(&root, &mut report);
        return Ok(report);
    }

    let identity = auth_device_identity().await?;
    let state_for_me = state_static(state);
    let token_for_me = request.token.clone();
    let me = omnipanel_assistant::with_deadline(async move {
        auth_get_me(state_for_me, token_for_me).await
    })
    .await?;
    let team = resolve_sync_team(request.team_id, &me)?;
    let team_id = team.id;
    let auth = build_auth_context(state, &request.token, &identity.device_id).await?;
    let (key, _) = get_or_create_sync_team_key(team_id)?;
    adopt_remote_location(state, &auth, team_id, &key).await;
    let mut legacy = if team_repo_has_index(&auth, team_id).await.unwrap_or(false) {
        BTreeMap::new()
    } else {
        load_legacy_modules(&auth, &me, team).await
    };
    legacy.extend(load_legacy_conversations(&auth, &me, team).await);
    let mut report = sync_with_ready_storage(
        state,
        &auth,
        team_id,
        &root,
        &key,
        &identity.device_id,
        &legacy,
        &managed,
    )
    .await?;
    report.applied_connections = {
        let storage = state.storage.lock().await;
        storage.apply_space_checkout(&root)?
    };
    if let Ok(path) = database_connections_path() {
        let _ = apply_database_files(&root, &path);
    }
    for dir in desktop_plugin_dirs() {
        let _ = restore_plugin_packs(&root, &dir);
    }
    attach_layouts(&root, &mut report);
    Ok(report)
}

/// 应用状态跟进程一样长，同步不会比进程更久。
fn state_static(state: &State<'_, AppState>) -> State<'static, AppState> {
    unsafe { std::mem::transmute(state.clone()) }
}

fn stage_global_files(files: &mut BTreeMap<String, Vec<u8>>) {
    stage_file(files, "ai/providers.json", ai_providers_path().ok());
    stage_file(files, "ai/web-search.json", web_search_config_path().ok());
    stage_file(files, "ai/http-proxy.json", http_proxy_config_path().ok());
}

fn stage_file(files: &mut BTreeMap<String, Vec<u8>>, key: &str, path: Option<std::path::PathBuf>) {
    let Some(path) = path else { return };
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    if !bytes.is_empty() {
        files.insert(key.to_string(), bytes);
    }
}

async fn adopt_remote_location(
    state: &State<'_, AppState>,
    auth: &omnipanel_assistant::AuthContext,
    team_id: i64,
    key: &[u8; 32],
) {
    let Ok(Some((location, creds))) = fetch_space_location(auth, team_id, key).await else {
        return;
    };
    if location.kind != "s3" || !location.ready {
        return;
    }
    let Some((access_key_id, secret)) = creds else {
        return;
    };
    let storage = state.storage.lock().await;
    let _ = storage.space_storage_adopt(
        team_id,
        &location.kind,
        &location.endpoint,
        &location.bucket,
        &location.region,
        &access_key_id,
        &secret,
    );
}

async fn sync_with_ready_storage(
    state: &State<'_, AppState>,
    auth: &omnipanel_assistant::AuthContext,
    team_id: i64,
    root: &std::path::Path,
    key: &[u8; 32],
    device_id: &str,
    legacy: &BTreeMap<String, Vec<u8>>,
    managed: &std::collections::BTreeSet<String>,
) -> Result<SpaceSyncReport, OmniError> {
    let settings = {
        let storage = state.storage.lock().await;
        storage.space_storage_get(team_id)?
    };
    if settings.kind == "s3" && settings.ready {
        let (access_key_id, secret) = {
            let storage = state.storage.lock().await;
            storage.space_s3_credentials(team_id)?
        };
        return sync_s3_space(
            &settings.endpoint,
            &settings.bucket,
            &settings.region,
            &access_key_id,
            &secret,
            root,
            key,
            device_id,
            legacy,
            managed,
        )
        .await;
    }
    sync_oss_space(auth, team_id, root, key, device_id, legacy, managed).await
}

async fn load_legacy_modules(
    auth: &omnipanel_assistant::AuthContext,
    me: &crate::commands::auth::AuthUserProfile,
    team: &crate::commands::auth::AuthTeamMembership,
) -> BTreeMap<String, Vec<u8>> {
    let Ok(Some((_, bytes))) = pull_team_sync_json(auth, team.id, TEAM_MODULES_LATEST_LEAF).await
    else {
        return BTreeMap::new();
    };
    let Ok(plain) = decode_sync_team_payload(me, team, SYNC_KIND_MODULES, &bytes) else {
        return BTreeMap::new();
    };
    serde_json::from_slice::<Value>(&plain)
        .map(|value| legacy_module_files(&value))
        .unwrap_or_default()
}

async fn load_legacy_conversations(
    auth: &omnipanel_assistant::AuthContext,
    me: &crate::commands::auth::AuthUserProfile,
    team: &crate::commands::auth::AuthTeamMembership,
) -> BTreeMap<String, Vec<u8>> {
    let Ok(Some((_, bytes))) =
        pull_team_sync_json(auth, team.id, TEAM_CONVERSATIONS_LATEST_LEAF).await
    else {
        return BTreeMap::new();
    };
    let Ok(plain) = decode_sync_team_payload(me, team, SYNC_KIND_CONVERSATIONS, &bytes) else {
        return BTreeMap::new();
    };
    serde_json::from_slice::<Value>(&plain)
        .map(|value| legacy_conversation_files(&value))
        .unwrap_or_default()
}

fn claim_decision(raw: &str) -> Result<&'static str, OmniError> {
    match raw.trim() {
        "merge" => Ok("merge"),
        "local_only" => Ok("local_only"),
        "new_space" => Ok("new_space"),
        _ => Err(OmniError::new(ErrorCode::InvalidInput, "未知的认领选择")),
    }
}

/// 登录前看本机有没有自己的记录、云端有没有仓库、这个团队是否已经选过。
#[tauri::command]
#[specta::specta]
pub async fn local_space_claim_status(
    state: State<'_, AppState>,
    token: String,
    team_id: Option<i64>,
) -> Result<SpaceClaimStatus, OmniError> {
    let (local_count, decision_team) = {
        let storage = state.storage.lock().await;
        let count = storage.local_space_user_count()?;
        let team = team_id.unwrap_or(0);
        let decision = if team > 0 {
            storage.space_claim_decision(team)?
        } else {
            None
        };
        (count, decision)
    };
    if token.trim().is_empty() {
        return Ok(SpaceClaimStatus {
            team_id: team_id.unwrap_or(0),
            local_count,
            remote_has_repo: false,
            decision: decision_team,
        });
    }
    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), token.clone()).await?;
    let team = resolve_sync_team(team_id, &me)?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let remote_has_repo = team_repo_has_index(&auth, team.id).await.unwrap_or(false);
    let decision = {
        let storage = state.storage.lock().await;
        storage.space_claim_decision(team.id)?
    };
    Ok(SpaceClaimStatus {
        team_id: team.id,
        local_count,
        remote_has_repo,
        decision,
    })
}

/// 记下这一次选择。只留本机的记录不再上传；另建空间时先复制当前目录。
#[tauri::command]
#[specta::specta]
pub async fn local_space_claim_choose(
    state: State<'_, AppState>,
    choice: SpaceClaimChoice,
) -> Result<(), OmniError> {
    let decision = claim_decision(&choice.decision)?;
    let root = team_data_dir()?;
    if decision == "new_space" {
        let publish = choice
            .publish_team_id
            .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "另建空间需要新的团队"))?;
        {
            let storage = state.storage.lock().await;
            storage.checkpoint_wal()?;
        }
        copy_team_dir_if_absent(&active_team_scope(), &publish.to_string())?;
    }
    let storage = state.storage.lock().await;
    storage.space_claim_put(choice.team_id, decision)?;
    if decision == "local_only" || decision == "new_space" {
        storage.mark_space_local_only(&root)?;
    }
    Ok(())
}

/// 这个团队的仓库放在我们的桶，还是自己的 S3。密钥只从钥匙串读出是否已保存。
#[tauri::command]
#[specta::specta]
pub async fn local_space_storage_get(
    state: State<'_, AppState>,
    team_id: i64,
) -> Result<SpaceStorageSettings, OmniError> {
    let storage = state.storage.lock().await;
    storage.space_storage_get(team_id)
}

/// 保存团队存储位置。密钥写入本机钥匙串，不进仓库。
#[tauri::command]
#[specta::specta]
pub async fn local_space_storage_put(
    state: State<'_, AppState>,
    input: SpaceStorageInput,
) -> Result<SpaceStorageSettings, OmniError> {
    let storage = state.storage.lock().await;
    storage.space_storage_put(&input)
}

/// 本机冲突记录。不上传。
#[tauri::command]
#[specta::specta]
pub async fn local_space_list_conflicts() -> Result<Vec<SpaceConflict>, OmniError> {
    list_space_conflicts(&team_data_dir()?)
}

/// 丢掉一份冲突记录。当前资源不动。
#[tauri::command]
#[specta::specta]
pub async fn local_space_delete_conflict(id: String) -> Result<(), OmniError> {
    delete_space_conflict(&team_data_dir()?, &id)
}

/// 先把现有仓库抄进自己的桶，确认 `refs/latest` 写上之后才改账号上的存储位置。
#[tauri::command]
#[specta::specta]
pub async fn local_space_storage_copy(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<SpaceStorageSettings, OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "需要先登录"));
    }
    let settings = {
        let storage = state.storage.lock().await;
        storage.space_storage_get(team_id)?
    };
    if settings.kind != "s3" {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "当前不是自己的存储桶",
        ));
    }
    let (access_key_id, secret) = {
        let storage = state.storage.lock().await;
        storage.space_s3_credentials(team_id)?
    };
    if access_key_id.is_empty() || secret.is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "请先保存 Access Key",
        ));
    }
    let root = team_data_dir()?;
    {
        let storage = state.storage.lock().await;
        let device_id = crate::commands::auth::current_device_id().unwrap_or_default();
        storage.rebuild_space_repo_for(&root, &BTreeMap::new(), &device_id)?;
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let (key, _) = get_or_create_sync_team_key(team_id)?;
    sync_s3_space(
        &settings.endpoint,
        &settings.bucket,
        &settings.region,
        &access_key_id,
        &secret,
        &root,
        &key,
        &identity.device_id,
        &BTreeMap::new(),
        &std::collections::BTreeSet::new(),
    )
    .await?;
    publish_space_location(
        &auth,
        team_id,
        &SpaceLocation {
            kind: "s3".into(),
            endpoint: settings.endpoint.clone(),
            bucket: settings.bucket.clone(),
            region: settings.region.clone(),
            ready: true,
        },
        &access_key_id,
        &secret,
        &key,
    )
    .await?;
    let storage = state.storage.lock().await;
    storage.space_storage_mark_ready(team_id)?;
    storage.space_storage_get(team_id)
}

/// 确认后删除自己桶里的空间对象。官方桶没有删除接口。
#[tauri::command]
#[specta::specta]
pub async fn local_space_storage_purge(
    state: State<'_, AppState>,
    team_id: i64,
) -> Result<u32, OmniError> {
    let settings = {
        let storage = state.storage.lock().await;
        storage.space_storage_get(team_id)?
    };
    if settings.kind != "s3" {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "官方凭证不能删除已上传的加密块",
        ));
    }
    let (access_key_id, secret) = {
        let storage = state.storage.lock().await;
        storage.space_s3_credentials(team_id)?
    };
    purge_s3_repo(
        &settings.endpoint,
        &settings.bucket,
        &settings.region,
        &access_key_id,
        &secret,
    )
    .await
}

/// 本机是否装了 Navicat。只看常见安装目录，不读连接库。
#[tauri::command]
#[specta::specta]
pub fn local_space_navicat_present() -> bool {
    navicat_dirs().iter().any(|path| path.is_dir())
}

fn navicat_dirs() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for key in [
            "ProgramFiles",
            "ProgramFiles(x86)",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Some(base) = std::env::var_os(key) {
                out.push(std::path::PathBuf::from(base).join("PremiumSoft"));
            }
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            out.push(
                std::path::PathBuf::from(home)
                    .join("Documents")
                    .join("Navicat"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = std::path::PathBuf::from(home);
            out.push(
                home.join("Library")
                    .join("Application Support")
                    .join("PremiumSoft"),
            );
            out.push(std::path::PathBuf::from("/Applications").join("Navicat Premium.app"));
        }
    }
    out
}
