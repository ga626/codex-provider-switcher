//! Thin Tauri command adapters.
//!
//! Business functions stay callable from the desktop app, the local parity
//! backend, and focused tests. Network-bound desktop commands live here so
//! `lib.rs` remains the composition root instead of another growing UI/API
//! boundary.

use super::{
    check_for_update_core, preview_models_core, refresh_models_core,
    run_blocking_command_with_events, run_response_probe_for_model_core, verify_profile_core,
    AppState, EditableProfile, ModelCatalog, OperationEventV1, SwitcherError, UpdateInfo,
};
use tauri::ipc::Channel;

#[tauri::command]
pub(crate) async fn check_for_update() -> Result<UpdateInfo, SwitcherError> {
    super::run_blocking_command(check_for_update_core).await
}

#[tauri::command]
pub(crate) async fn verify_profile(
    profile_id: String,
    on_event: Channel<OperationEventV1>,
) -> Result<AppState, SwitcherError> {
    run_blocking_command_with_events("verify-profile", "provider", Some(on_event), move || {
        verify_profile_core(profile_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn run_response_probe(
    profile_id: String,
    benchmark_model: String,
    on_event: Channel<OperationEventV1>,
) -> Result<AppState, SwitcherError> {
    run_blocking_command_with_events("run-cost-probe", "lab", Some(on_event), move || {
        run_response_probe_for_model_core(profile_id, benchmark_model)
    })
    .await
}

#[tauri::command]
pub(crate) async fn refresh_models(
    profile_id: String,
    on_event: Channel<OperationEventV1>,
) -> Result<AppState, SwitcherError> {
    run_blocking_command_with_events("refresh-models", "provider", Some(on_event), move || {
        refresh_models_core(profile_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_models(
    profile: EditableProfile,
    on_event: Channel<OperationEventV1>,
) -> Result<ModelCatalog, SwitcherError> {
    run_blocking_command_with_events("preview-models", "provider", Some(on_event), move || {
        preview_models_core(profile)
    })
    .await
}
