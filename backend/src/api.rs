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
    dispatch::{run_project, run_subscription_with_reason, run_worker, Ctx},
    store::{
        new_context, new_project, new_subscription, next_run_at, ContextItem, NewContextItem,
        NewProject, NewSubscription, Project, ProjectPatch,
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
    let project = new_project(input, &tenant.id);
    match ctx.store.save_project(&project) {
        Ok(()) => (StatusCode::CREATED, Json(project)).into_response(),
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
    project.updated_at = crate::store::now_ms();
    match ctx.store.save_project(&project) {
        Ok(()) => Json(project).into_response(),
        Err(error) => error_response(error),
    }
}

async fn delete_project(
    State(ctx): State<Arc<Ctx>>,
    Extension(tenant): Extension<TenantContext>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match ctx.store.delete_project(&tenant.id, &id) {
        Ok(true) => Json(json!({"deleted":true})).into_response(),
        Ok(false) => not_found(),
        Err(error) => error_response(error),
    }
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
