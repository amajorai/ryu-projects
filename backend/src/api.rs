use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, patch, post},
    Extension, Json, Router,
};

#[derive(Debug, Clone)]
pub struct TenantContext {
    pub id: String,
}

/// Core stamps these headers after verifying the caller's JWT. A missing
/// context is the node-local tenant used by standalone/local development.
pub fn tenant_from_headers(headers: &HeaderMap) -> TenantContext {
    let org = headers
        .get("x-ryu-caller-org-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let user = headers
        .get("x-ryu-caller-user-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let id = org
        .map(|value| format!("org:{value}"))
        .or_else(|| user.map(|value| format!("user:{value}")))
        .unwrap_or_else(|| crate::store::LOCAL_TENANT_ID.to_owned());
    TenantContext { id }
}
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    dispatch::{
        add_member, clear_member_goal, clear_project_guidance, ensure_project_main_thread,
        run_project, run_subscription_with_reason, run_worker, set_defaults, set_guidance,
        set_member_goal, sync_instructions, Ctx, GuidanceWrite, MAX_INSTRUCTIONS_CHARS,
    },
    store::{
        new_context, new_project, new_subscription, next_run_at, ContextItem, NewContextItem,
        NewProject, NewSubscription, Project, ProjectDefaults, ProjectPatch,
    },
};

pub fn routes(ctx: Arc<Ctx>) -> Router {
    Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/import", post(import_project))
        .route("/tools/run", post(run_tool))
        .route(
            "/projects/:id",
            get(get_project)
                .patch(update_project)
                .delete(delete_project),
        )
        .route("/projects/:id/run", post(run_project_handler))
        .route("/projects/:id/main-thread", post(main_thread_handler))
        .route("/projects/:id/members", post(add_member_handler))
        .route(
            "/projects/:id/members/:kind/:member_id",
            axum::routing::delete(remove_member_handler),
        )
        .route(
            "/projects/:id/members/agent/:member_id/goal",
            axum::routing::put(set_member_goal_handler),
        )
        .route(
            "/projects/:id/guidance",
            axum::routing::put(set_guidance_handler),
        )
        .route(
            "/projects/:id/defaults",
            axum::routing::put(set_defaults_handler),
        )
        .route("/sidebar", get(sidebar))
        .route(
            "/projects/:id/context",
            get(list_context).post(create_context),
        )
        .route(
            "/projects/:id/context/:context_id",
            patch(update_context).delete(delete_context),
        )
        .route(
            "/projects/:id/workers",
            get(list_workers).post(create_worker),
        )
        .route(
            "/projects/:id/subscriptions",
            get(list_subscriptions).post(create_subscription),
        )
        .route(
            "/projects/:id/subscriptions/:subscription_id",
            patch(update_subscription).delete(delete_subscription),
        )
        .route("/events/:source", post(event))
        .with_state(ctx)
}

async fn bootstrap(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
) -> impl IntoResponse {
    match ctx.store.list_projects(&tenant.id) {
        Ok(projects) => {
            Json(json!({ "projects": projects, "execution": { "node": "active" } })).into_response()
        }
        Err(error) => error_response(error),
    }
}

async fn list_projects(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
) -> impl IntoResponse {
    match ctx.store.list_projects(&tenant.id) {
        Ok(projects) => Json(json!({ "projects": projects })).into_response(),
        Err(error) => error_response(error),
    }
}

async fn create_project(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Json(input): Json<NewProject>,
) -> impl IntoResponse {
    if input.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"project name is required"})),
        )
            .into_response();
    }
    if input.id.as_deref().is_some_and(|id| !id.trim().is_empty()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"project id is server-assigned; use /projects/import for an existing id"})),
        )
            .into_response();
    }
    if instructions_too_long(&input.instructions) {
        return instructions_too_long_response();
    }
    let defaults = input.defaults.clone();
    let goal = input.goal.trim().to_owned();
    let instructions = input.instructions.trim().to_owned();
    let project = new_project(input, &tenant.id);
    if let Err(error) = ctx.store.save_project(&project) {
        return error_response(error);
    }
    // Give the project its coordinator main thread right away (so the sidebar
    // and onboarding can open it) and write its defaults through to Core. Both
    // are best-effort: without a Core callback the project still exists and the
    // thread is created on its first run.
    let mut project = project;
    if let Some(host) = ctx.host.as_ref() {
        match ensure_project_main_thread(&ctx.store, host, &project).await {
            Ok((updated, _)) => project = updated,
            Err(error) => tracing::warn!(error = %error, "could not create project main thread"),
        }
        if let Some(agent) = project.coordinator_agent.clone() {
            match add_member(&ctx.store, Some(host), &project, "agent", &agent, "").await {
                Ok(updated) => project = updated,
                Err(error) => tracing::warn!(error = %error, "could not add coordinator member"),
            }
        }
    }
    if !defaults.is_empty() {
        match set_defaults(&ctx.store, ctx.host.as_ref(), &project, defaults).await {
            Ok(updated) => project = updated,
            Err(error) => tracing::warn!(error = %error, "could not save project defaults"),
        }
    }
    if !(goal.is_empty() && instructions.is_empty()) {
        // A brand-new project has no threads with a warm cache, so writing its
        // goal and instructions through costs nothing.
        let goal = (!goal.is_empty()).then_some(goal);
        let instructions = (!instructions.is_empty()).then_some(instructions);
        match set_guidance(
            &ctx.store,
            ctx.host.as_ref(),
            &project,
            goal,
            instructions,
            None,
        )
        .await
        {
            Ok((updated, _)) => project = updated,
            Err(error) => tracing::warn!(error = %error, "could not save project guidance"),
        }
    }
    (StatusCode::CREATED, Json(project)).into_response()
}

/// Rows for the desktop's contributed **Projects** sidebar section: one per
/// project, newest first, carrying the coordinator main thread to open.
async fn sidebar(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
) -> impl IntoResponse {
    match ctx.store.list_projects(&tenant.id) {
        Ok(projects) => {
            let rows: Vec<Value> = projects
                .into_iter()
                .map(|project| {
                    let bots = project.members.iter().filter(|m| m.kind != "user").count();
                    let summary = match bots {
                        0 => "No bots yet".to_owned(),
                        1 => "1 bot".to_owned(),
                        n => format!("{n} bots"),
                    };
                    json!({
                        "id": project.id,
                        "name": project.name,
                        "icon": project.icon,
                        "summary": if project.description.trim().is_empty() { summary } else { project.description.clone() },
                        "mainThreadId": project.coordinator_conversation_id,
                        "updatedAt": project.updated_at,
                        "status": project.status,
                    })
                })
                .collect();
            Json(json!({ "projects": rows })).into_response()
        }
        Err(error) => error_response(error),
    }
}

async fn load_project(
    ctx: &Ctx,
    tenant: &TenantContext,
    id: &str,
) -> Result<Project, axum::response::Response> {
    match ctx.store.get_project(&tenant.id, id) {
        Ok(Some(project)) => Ok(project),
        Ok(None) => Err(not_found()),
        Err(error) => Err(error_response(error)),
    }
}

fn unavailable() -> axum::response::Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Core is unavailable; open this project from a connected Ryu node"})),
    )
        .into_response()
}

async fn main_thread_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let project = match load_project(&ctx, &tenant, &id).await {
        Ok(project) => project,
        Err(response) => return response,
    };
    let Some(host) = ctx.host.as_ref() else {
        return unavailable();
    };
    match ensure_project_main_thread(&ctx.store, host, &project).await {
        Ok((project, thread)) => {
            Json(json!({"conversationId": thread, "project": project})).into_response()
        }
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberBody {
    kind: String,
    id: String,
    #[serde(default)]
    name: String,
}

async fn add_member_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(body): Json<MemberBody>,
) -> impl IntoResponse {
    let project = match load_project(&ctx, &tenant, &id).await {
        Ok(project) => project,
        Err(response) => return response,
    };
    if !crate::store::MEMBER_KINDS.contains(&body.kind.as_str()) || body.id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"member kind must be agent, group, or user, with an id"})),
        )
            .into_response();
    }
    match add_member(
        &ctx.store,
        ctx.host.as_ref(),
        &project,
        &body.kind,
        &body.id,
        &body.name,
    )
    .await
    {
        Ok(project) => Json(project).into_response(),
        Err(error) => error_response(error),
    }
}

async fn remove_member_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path((id, kind, member_id)): Path<(String, String, String)>,
) -> impl IntoResponse {
    let mut project = match load_project(&ctx, &tenant, &id).await {
        Ok(project) => project,
        Err(response) => return response,
    };
    let before = project.members.len();
    // A departing bot's per-project goal stops applying (best-effort).
    if kind == "agent" {
        if let Some(host) = ctx.host.as_ref() {
            clear_member_goal(host, &project.id, &member_id).await;
        }
    }
    // The member's main thread stays in the project as history; only the
    // membership ends.
    project
        .members
        .retain(|m| !(m.kind == kind && m.id == member_id));
    if project.members.len() == before {
        return not_found();
    }
    project.updated_at = crate::store::now_ms();
    match ctx.store.save_project(&project) {
        Ok(()) => Json(project).into_response(),
        Err(error) => error_response(error),
    }
}

async fn set_defaults_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(body): Json<ProjectDefaults>,
) -> impl IntoResponse {
    let project = match load_project(&ctx, &tenant, &id).await {
        Ok(project) => project,
        Err(response) => return response,
    };
    match set_defaults(&ctx.store, ctx.host.as_ref(), &project, body).await {
        Ok(project) => Json(project).into_response(),
        Err(error) => error_response(error),
    }
}

/// `{ goal?, instructions?, briefReplies? }`. Omitted fields keep their value;
/// `briefReplies: null` resets the toggle to inherited.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuidanceBody {
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default, deserialize_with = "explicit_null")]
    brief_replies: Option<Option<bool>>,
}

fn explicit_null<'de, D>(deserializer: D) -> Result<Option<Option<bool>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<bool>::deserialize(deserializer).map(Some)
}

fn goal_too_long(goal: &str) -> bool {
    goal.trim().chars().count() > MAX_GOAL_CHARS
}

/// Mirrors Core's `MAX_GOAL_CHARS`; Core enforces it too.
const MAX_GOAL_CHARS: usize = 2_000;

fn instructions_too_long(instructions: &str) -> bool {
    instructions.trim().chars().count() > MAX_INSTRUCTIONS_CHARS
}

fn instructions_too_long_response() -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": format!("instructions are limited to {MAX_INSTRUCTIONS_CHARS} characters")
        })),
    )
        .into_response()
}

/// Responses carry `promptChanged` so the UI can say whether the member
/// threads' next turns re-send their prompt uncached.
async fn set_guidance_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(body): Json<GuidanceBody>,
) -> impl IntoResponse {
    let project = match load_project(&ctx, &tenant, &id).await {
        Ok(project) => project,
        Err(response) => return response,
    };
    if body.goal.as_deref().is_some_and(goal_too_long) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("goals are limited to {MAX_GOAL_CHARS} characters")})),
        )
            .into_response();
    }
    if body
        .instructions
        .as_deref()
        .is_some_and(instructions_too_long)
    {
        return instructions_too_long_response();
    }
    match set_guidance(
        &ctx.store,
        ctx.host.as_ref(),
        &project,
        body.goal,
        body.instructions,
        body.brief_replies,
    )
    .await
    {
        Ok((project, changed)) => {
            Json(json!({"project": project, "promptChanged": changed})).into_response()
        }
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
struct MemberGoalBody {
    #[serde(default)]
    goal: String,
}

async fn set_member_goal_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path((id, member_id)): Path<(String, String)>,
    Json(body): Json<MemberGoalBody>,
) -> impl IntoResponse {
    let project = match load_project(&ctx, &tenant, &id).await {
        Ok(project) => project,
        Err(response) => return response,
    };
    if goal_too_long(&body.goal) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("goals are limited to {MAX_GOAL_CHARS} characters")})),
        )
            .into_response();
    }
    if project.member("agent", &member_id).is_none() {
        return not_found();
    }
    match set_member_goal(
        &ctx.store,
        ctx.host.as_ref(),
        &project,
        &member_id,
        &body.goal,
    )
    .await
    {
        Ok((project, changed)) => {
            Json(json!({"project": project, "promptChanged": changed})).into_response()
        }
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ProjectImportBody {
    Snapshot {
        project: Project,
        #[serde(default)]
        context: Vec<ContextItem>,
    },
    Project(Project),
}

async fn import_project(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Json(body): Json<ProjectImportBody>,
) -> impl IntoResponse {
    let (project, context) = match body {
        ProjectImportBody::Snapshot { project, context } => (project, context),
        ProjectImportBody::Project(project) => (project, Vec::new()),
    };
    if project.id.trim().is_empty() || project.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"project id and name are required"})),
        )
            .into_response();
    }
    let mut project = project;
    project.tenant_id = tenant.id.clone();
    let imported = match ctx.store.import_project_if_newer(&project) {
        Ok(imported) => imported,
        Err(error) => return error_response(error),
    };
    for item in context {
        if item.project_id == project.id {
            if let Err(error) = ctx.store.import_context_if_newer(&tenant.id, &item) {
                return error_response(error);
            }
        }
    }
    match ctx.store.get_project(&tenant.id, &project.id) {
        Ok(Some(current)) => {
            // An imported project's instructions reach its member threads only
            // once Core holds them. Best-effort: coordinator runs sync again.
            if imported {
                if let Some(host) = ctx.host.as_ref() {
                    sync_instructions(host, &current).await;
                }
            }
            Json(json!({"imported": imported, "project": current})).into_response()
        }
        Ok(None) => not_found(),
        Err(error) => error_response(error),
    }
}

async fn get_project(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match ctx.store.snapshot(&tenant.id, &id) {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => not_found(),
        Err(error) => error_response(error),
    }
}

async fn update_project(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(patch): Json<ProjectPatch>,
) -> impl IntoResponse {
    let current = match ctx.store.get_project(&tenant.id, &id) {
        Ok(Some(project)) => project,
        Ok(None) => return not_found(),
        Err(error) => return error_response(error),
    };
    if patch
        .instructions
        .as_deref()
        .is_some_and(instructions_too_long)
    {
        return instructions_too_long_response();
    }
    let mut project = current;
    if let Some(value) = patch.client {
        project.client = value;
    }
    if let Some(value) = patch.coordinator_agent {
        project.coordinator_agent = Some(value);
    }
    if let Some(value) = patch.cwd {
        project.cwd = Some(value);
    }
    if let Some(value) = patch.description {
        project.description = value;
    }
    if let Some(value) = patch.due_date {
        project.due_date = value;
    }
    if let Some(value) = patch.execution_mode {
        project.execution_mode = value;
    }
    if let Some(value) = patch.name {
        project.name = value;
    }
    if let Some(value) = patch.status {
        project.status = value;
    }
    if let Some(value) = patch.tasks {
        project.tasks = value;
    }
    let icon_changed = patch.icon.is_some();
    if let Some(value) = patch.icon {
        project.icon = value.filter(|icon| !icon.is_null());
    }
    let instructions_changed = patch
        .instructions
        .as_deref()
        .is_some_and(|value| value.trim() != project.instructions.trim());
    if let Some(value) = patch.instructions {
        project.instructions = value.trim().to_owned();
    }
    // Instructions ride in every member thread's system prompt through Core's
    // scope guidance; write them there first so a refused write leaves the
    // project unchanged. The Projects UI saves them through `/guidance`; this
    // path keeps API and tool callers in sync and, like `/guidance`, reports
    // `promptChanged` so they can tell the member threads' next turns re-send
    // their prompt uncached.
    let mut prompt_changed = false;
    if instructions_changed {
        if let Some(host) = ctx.host.as_ref() {
            match host
                .set_scope_guidance(
                    &crate::dispatch::project_scope(&project.id),
                    GuidanceWrite {
                        instructions: Some(&project.instructions),
                        ..GuidanceWrite::default()
                    },
                )
                .await
            {
                Ok(changed) => prompt_changed = changed,
                Err(error) => return error_response(error),
            }
        }
    }
    project.updated_at = crate::store::now_ms();
    if let Err(error) = ctx.store.save_project(&project) {
        return error_response(error);
    }
    if icon_changed {
        if let Some(host) = ctx.host.as_ref() {
            if let Err(error) = crate::dispatch::sync_main_thread_icon(host, &project).await {
                tracing::warn!(error = %error, "could not update the project main thread icon");
            }
        }
    }
    project_response(&project, prompt_changed)
}

/// The project as the PATCH response has always returned it, plus
/// `promptChanged` (added; existing readers ignore it).
fn project_response(project: &Project, prompt_changed: bool) -> axum::response::Response {
    let mut body = match serde_json::to_value(project) {
        Ok(body) => body,
        Err(error) => return error_response(error.into()),
    };
    if let Some(fields) = body.as_object_mut() {
        fields.insert("promptChanged".to_owned(), json!(prompt_changed));
    }
    Json(body).into_response()
}

async fn delete_project(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let project = match ctx.store.get_project(&tenant.id, &id) {
        Ok(Some(project)) => project,
        Ok(None) => return not_found(),
        Err(error) => return error_response(error),
    };
    match ctx.store.delete_project(&tenant.id, &id) {
        Ok(true) => {}
        Ok(false) => return not_found(),
        Err(error) => return error_response(error),
    }
    // The project's goal, instructions and brief toggle, and its bots'
    // per-project goals, live in Core's scope guidance; drop them with the
    // project. Best-effort: a Core failure is logged and the delete stands.
    if let Some(host) = ctx.host.as_ref() {
        clear_project_guidance(host, &project).await;
    }
    Json(json!({"deleted":true})).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunBody {
    prompt: String,
}

async fn run_project_handler(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(body): Json<RunBody>,
) -> impl IntoResponse {
    let Some(project) = (match ctx.store.get_project(&tenant.id, &id) {
        Ok(project) => project,
        Err(error) => return error_response(error),
    }) else {
        return not_found();
    };
    match run_project(&ctx.store, ctx.host.as_ref(), &project, &body.prompt).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolRunBody {
    project_id: String,
    prompt: String,
}

async fn run_tool(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Json(body): Json<ToolRunBody>,
) -> impl IntoResponse {
    let Some(project) = (match ctx.store.get_project(&tenant.id, &body.project_id) {
        Ok(project) => project,
        Err(error) => return error_response(error),
    }) else {
        return not_found();
    };
    match run_project(&ctx.store, ctx.host.as_ref(), &project, &body.prompt).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(error),
    }
}

async fn list_context(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match ctx.store.list_context(&tenant.id, &id) {
        Ok(context) => Json(json!({"context":context})).into_response(),
        Err(error) => error_response(error),
    }
}

async fn create_context(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(input): Json<NewContextItem>,
) -> impl IntoResponse {
    let project_exists = match ctx.store.get_project(&tenant.id, &id) {
        Ok(project) => project.is_some(),
        Err(error) => return error_response(error),
    };
    if !project_exists {
        return not_found();
    }
    let item = new_context(&id, input);
    match ctx.store.save_context(&tenant.id, &item) {
        Ok(()) => (StatusCode::CREATED, Json(item)).into_response(),
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextPatch {
    content: Option<String>,
    kind: Option<String>,
    title: Option<String>,
}

async fn update_context(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path((id, context_id)): Path<(String, String)>,
    Json(patch): Json<ContextPatch>,
) -> impl IntoResponse {
    let item = match ctx.store.list_context(&tenant.id, &id) {
        Ok(items) => items.into_iter().find(|item| item.id == context_id),
        Err(error) => return error_response(error),
    };
    let Some(mut item) = item else {
        return not_found();
    };
    if let Some(value) = patch.content {
        item.content = value;
    }
    if let Some(value) = patch.kind {
        item.kind = value;
    }
    if let Some(value) = patch.title {
        item.title = value;
    }
    item.updated_at = crate::store::now_ms();
    match ctx.store.save_context(&tenant.id, &item) {
        Ok(()) => Json(item).into_response(),
        Err(error) => error_response(error),
    }
}

async fn delete_context(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path((id, context_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match ctx.store.delete_context(&tenant.id, &id, &context_id) {
        Ok(true) => Json(json!({"deleted":true})).into_response(),
        Ok(false) => not_found(),
        Err(error) => error_response(error),
    }
}

async fn list_workers(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match ctx.store.list_workers(&tenant.id, &id) {
        Ok(workers) => Json(json!({"workers":workers})).into_response(),
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBody {
    agent_id: Option<String>,
    task: String,
    title: String,
}

async fn create_worker(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(body): Json<WorkerBody>,
) -> impl IntoResponse {
    let Some(project) = (match ctx.store.get_project(&tenant.id, &id) {
        Ok(project) => project,
        Err(error) => return error_response(error),
    }) else {
        return not_found();
    };
    match run_worker(
        &ctx.store,
        ctx.host.as_ref(),
        &project,
        &body.title,
        &body.task,
        body.agent_id.as_deref(),
    )
    .await
    {
        Ok((conversation_id, response)) => {
            let now = crate::store::now_ms();
            let worker = crate::store::Worker {
                agent_id: body.agent_id,
                conversation_id: (!conversation_id.is_empty()).then_some(conversation_id),
                created_at: now,
                id: format!("worker_{}", uuid::Uuid::new_v4().simple()),
                project_id: id,
                status: response
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("dispatched")
                    .to_owned(),
                task: body.task,
                title: body.title,
                updated_at: now,
            };
            match ctx.store.save_worker(&tenant.id, &worker) {
                Ok(()) => (StatusCode::ACCEPTED, Json(worker)).into_response(),
                Err(error) => error_response(error),
            }
        }
        Err(error) => error_response(error),
    }
}

async fn list_subscriptions(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match ctx.store.list_subscriptions(&tenant.id, &id) {
        Ok(subscriptions) => Json(json!({"subscriptions":subscriptions})).into_response(),
        Err(error) => error_response(error),
    }
}

async fn create_subscription(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
    Json(input): Json<NewSubscription>,
) -> impl IntoResponse {
    let project_exists = match ctx.store.get_project(&tenant.id, &id) {
        Ok(project) => project.is_some(),
        Err(error) => return error_response(error),
    };
    if !project_exists {
        return not_found();
    }
    let subscription = new_subscription(&id, &tenant.id, input);
    match ctx.store.save_subscription(&subscription) {
        Ok(()) => (StatusCode::CREATED, Json(subscription)).into_response(),
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionPatch {
    enabled: Option<bool>,
    name: Option<String>,
    schedule: Option<Option<String>>,
}

async fn update_subscription(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path((id, subscription_id)): Path<(String, String)>,
    Json(patch): Json<SubscriptionPatch>,
) -> impl IntoResponse {
    let subscription = match ctx.store.list_subscriptions(&tenant.id, &id) {
        Ok(items) => items.into_iter().find(|item| item.id == subscription_id),
        Err(error) => return error_response(error),
    };
    let Some(mut subscription) = subscription else {
        return not_found();
    };
    let scheduling_changed = patch.enabled.is_some() || patch.schedule.is_some();
    if let Some(value) = patch.enabled {
        subscription.enabled = value;
    }
    if let Some(value) = patch.name {
        subscription.name = value;
    }
    if let Some(value) = patch.schedule {
        subscription.schedule = value;
    }
    if scheduling_changed {
        subscription.next_run_at = next_run_at(
            subscription.enabled,
            &subscription.kind,
            subscription.schedule.as_deref(),
            crate::store::now_ms(),
        );
    }
    subscription.updated_at = crate::store::now_ms();
    match ctx.store.save_subscription(&subscription) {
        Ok(()) => Json(subscription).into_response(),
        Err(error) => error_response(error),
    }
}

async fn delete_subscription(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path((id, subscription_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match ctx
        .store
        .delete_subscription(&tenant.id, &id, &subscription_id)
    {
        Ok(true) => Json(json!({"deleted":true})).into_response(),
        Ok(false) => not_found(),
        Err(error) => error_response(error),
    }
}

#[derive(Debug, Deserialize)]
struct EventBody {
    payload: Option<Value>,
}

async fn event(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(source): Path<String>,
    Json(body): Json<EventBody>,
) -> impl IntoResponse {
    let payload = body.payload.unwrap_or_else(|| json!({}));
    let projects = match ctx.store.list_projects(&tenant.id) {
        Ok(projects) => projects,
        Err(error) => return error_response(error),
    };
    let mut fired = 0usize;
    for project in projects {
        let subscriptions = match ctx.store.list_subscriptions(&tenant.id, &project.id) {
            Ok(value) => value,
            Err(error) => return error_response(error),
        };
        for subscription in subscriptions
            .into_iter()
            .filter(|sub| sub.enabled && (sub.kind == source || sub.kind == "webhook"))
        {
            let request = format!(
                "External {} event received for subscription '{}'. Payload: {}",
                source, subscription.name, payload
            );
            if let Some(host) = ctx.host.as_ref() {
                if run_subscription_with_reason(&ctx.store, host, &subscription, &request)
                    .await
                    .is_ok()
                {
                    fired += 1;
                }
            }
        }
    }
    Json(json!({"accepted":true,"fired":fired})).into_response()
}

fn not_found() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"project resource not found"})),
    )
        .into_response()
}
fn error_response(error: anyhow::Error) -> axum::response::Response {
    tracing::warn!(error = %error, "ryu-projects request failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"projects service could not complete the request"})),
    )
        .into_response()
}

#[cfg(test)]
#[path = "api_route_tests.rs"]
mod route_tests;

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::*;
    use crate::{
        dispatch::HostCall,
        store::{ProjectMember, Store},
    };

    pub(super) type Calls = Arc<Mutex<Vec<(String, Value)>>>;

    /// A stand-in Core that records each capability call and answers like
    /// the real broker, or refuses every call when `fail` is set.
    pub(super) async fn mock_core(fail: bool) -> (HostCall, Calls) {
        let calls: Calls = Arc::default();
        let recorded = Arc::clone(&calls);
        let app = Router::new().route(
            "/api/host/capability/:cap",
            post(move |Path(cap): Path<String>, Json(body): Json<Value>| {
                let recorded = Arc::clone(&recorded);
                async move {
                    recorded.lock().unwrap().push((cap, body));
                    if fail {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({"error": "Core is unavailable"})),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(
                            json!({"ok": true, "promptChanged": true, "conversation_id": "conv-1"}),
                        ),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (HostCall::for_tests(base), calls)
    }

    fn member(kind: &str, id: &str) -> ProjectMember {
        ProjectMember {
            kind: kind.to_owned(),
            id: id.to_owned(),
            name: id.to_owned(),
            main_thread_id: None,
            joined_at: 0,
            goal: String::new(),
        }
    }

    pub(super) fn app_with(host: HostCall) -> (Router, Arc<Ctx>, Project) {
        let store = Store::memory().unwrap();
        let mut project = new_project(
            NewProject {
                client: String::new(),
                coordinator_agent: None,
                cwd: None,
                description: String::new(),
                due_date: String::new(),
                execution_mode: "auto".to_owned(),
                id: Some("atlas".to_owned()),
                name: "Atlas".to_owned(),
                owner: String::new(),
                icon: None,
                instructions: "Cite sources.".to_owned(),
                defaults: ProjectDefaults::default(),
                goal: "Launch".to_owned(),
            },
            crate::store::LOCAL_TENANT_ID,
        );
        project.members = vec![
            member("agent", "writer"),
            member("agent", "reviewer"),
            member("group", "design"),
            member("user", "ada"),
        ];
        store.save_project(&project).unwrap();
        let ctx = Arc::new(Ctx {
            host: Some(host),
            store,
        });
        (routes(Arc::clone(&ctx)), ctx, project)
    }

    async fn send(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        request.extensions_mut().insert(TenantContext {
            id: crate::store::LOCAL_TENANT_ID.to_owned(),
        });
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn guidance_calls(calls: &Calls) -> Vec<Value> {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(cap, _)| cap == "scopeGuidance.set")
            .map(|(_, body)| body.clone())
            .collect()
    }

    fn cleared(scope: &str) -> Value {
        json!({"scope": scope, "goal": "", "instructions": "", "briefReplies": null})
    }

    /// Core's ext-proxy refuses any sub-path the manifest does not declare, so
    /// every route the UI calls must be listed there or its saves 404.
    #[test]
    fn the_manifest_declares_every_route_the_ui_calls() {
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let declared: Vec<(String, String)> = manifest["sidecars"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|sidecar| {
                sidecar["http"]["routes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .map(|route| {
                (
                    route["method"].as_str().unwrap_or_default().to_owned(),
                    route["path"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        for (method, path) in [
            ("PATCH", "/projects/:id"),
            ("DELETE", "/projects/:id"),
            ("DELETE", "/projects/:id/members/:kind/:member_id"),
            ("PUT", "/projects/:id/defaults"),
            ("PUT", "/projects/:id/guidance"),
            ("PUT", "/projects/:id/members/agent/:member_id/goal"),
        ] {
            assert!(
                declared.iter().any(|(m, p)| m == method && p == path),
                "manifest is missing {method} {path}"
            );
        }
    }

    #[tokio::test]
    async fn deleting_a_project_clears_its_guidance_and_its_bots_goals_in_core() {
        let (host, calls) = mock_core(false).await;
        let (app, ctx, project) = app_with(host);
        let (status, body) = send(app, "DELETE", "/projects/atlas", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));
        assert!(ctx
            .store
            .get_project("local", &project.id)
            .unwrap()
            .is_none());
        assert_eq!(
            guidance_calls(&calls),
            vec![
                cleared("project:atlas"),
                cleared("project:atlas/agent:writer"),
                cleared("project:atlas/agent:reviewer"),
            ],
            "groups and humans carry no per-project prompt row"
        );
    }

    #[tokio::test]
    async fn a_core_failure_does_not_block_deleting_a_project() {
        let (host, calls) = mock_core(true).await;
        let (app, ctx, project) = app_with(host);
        let (status, body) = send(app, "DELETE", "/projects/atlas", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));
        assert!(ctx
            .store
            .get_project("local", &project.id)
            .unwrap()
            .is_none());
        assert_eq!(
            guidance_calls(&calls).len(),
            3,
            "every row is still attempted"
        );
    }

    #[tokio::test]
    async fn deleting_a_missing_project_writes_nothing_to_core() {
        let (host, calls) = mock_core(false).await;
        let (app, _, _) = app_with(host);
        let (status, _) = send(app, "DELETE", "/projects/missing", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn removing_a_bot_clears_only_its_project_goal() {
        let (host, calls) = mock_core(false).await;
        let (app, _, _) = app_with(host);
        let (status, body) =
            send(app, "DELETE", "/projects/atlas/members/agent/writer", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["members"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["id"] != "writer"));
        assert_eq!(
            guidance_calls(&calls),
            vec![json!({"scope": "project:atlas/agent:writer", "goal": ""})]
        );
    }

    #[tokio::test]
    async fn patching_instructions_reports_the_prompt_change() {
        let (host, calls) = mock_core(false).await;
        let (app, ctx, _) = app_with(host);
        let (status, body) = send(
            app,
            "PATCH",
            "/projects/atlas",
            Some(json!({"instructions": "  Cite primary sources.  "})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["promptChanged"], json!(true));
        assert_eq!(body["id"], "atlas", "the project stays at the top level");
        assert_eq!(body["instructions"], "Cite primary sources.");
        assert_eq!(
            guidance_calls(&calls),
            vec![json!({"scope": "project:atlas", "instructions": "Cite primary sources."})]
        );
        let stored = ctx.store.get_project("local", "atlas").unwrap().unwrap();
        assert_eq!(stored.instructions, "Cite primary sources.");
    }

    #[tokio::test]
    async fn patching_other_fields_reports_no_prompt_change() {
        let (host, calls) = mock_core(false).await;
        let (app, _, _) = app_with(host);
        let (status, body) = send(
            app,
            "PATCH",
            "/projects/atlas",
            Some(json!({"name": "Atlas 2", "instructions": "Cite sources."})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["promptChanged"], json!(false));
        assert_eq!(body["name"], "Atlas 2");
        assert!(
            guidance_calls(&calls).is_empty(),
            "unchanged instructions skip Core"
        );
    }

    #[tokio::test]
    async fn a_refused_instructions_write_leaves_the_project_unchanged() {
        let (host, _) = mock_core(true).await;
        let (app, ctx, _) = app_with(host);
        let (status, _) = send(
            app,
            "PATCH",
            "/projects/atlas",
            Some(json!({"instructions": "Something else."})),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let stored = ctx.store.get_project("local", "atlas").unwrap().unwrap();
        assert_eq!(stored.instructions, "Cite sources.");
    }
}
