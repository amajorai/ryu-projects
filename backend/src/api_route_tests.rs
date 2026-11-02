//! Route-level tests for the project sub-resources (context, workers,
//! subscriptions), import, bootstrap/sidebar and the main-thread endpoint.
//! They drive the real router over an in-memory store; Core is the recording
//! stand-in from `api::tests`.

use axum::{body::Body, http::Request};
use tower::ServiceExt;

use super::tests::{app_with, mock_core, Calls};
use super::*;
use crate::store::{Store, LOCAL_TENANT_ID};

const OTHER_TENANT: &str = "org:intruder";

async fn send_as(
    app: &Router,
    tenant: &str,
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
        id: tenant.to_owned(),
    });
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn send(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    send_as(app, LOCAL_TENANT_ID, method, uri, body).await
}

fn capability_calls(calls: &Calls, cap: &str) -> usize {
    calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == cap)
        .count()
}

fn not_found_body() -> Value {
    json!({"error": "project resource not found"})
}

#[tokio::test]
async fn context_entries_persist_patch_and_stay_inside_their_tenant() {
    let (host, _) = mock_core(false).await;
    let (app, ctx, _) = app_with(host);

    let (status, created) = send(
        &app,
        "POST",
        "/projects/atlas/context",
        Some(json!({"kind": "decision", "title": "Stack", "content": "Use SQLite"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let context_id = created["id"].as_str().unwrap().to_owned();
    assert!(context_id.starts_with("context_"));
    assert_eq!(created["projectId"], "atlas");

    let (status, listed) = send(&app, "GET", "/projects/atlas/context", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed, json!({"context": [created.clone()]}));

    // A body without the required content is refused and nothing is saved.
    let (status, _) = send(
        &app,
        "POST",
        "/projects/atlas/context",
        Some(json!({"title": "No content"})),
    )
    .await;
    assert!(status.is_client_error(), "got {status}");
    assert_eq!(ctx.store.list_context("local", "atlas").unwrap().len(), 1);

    // Unknown project: 404, nothing written.
    let (status, body) = send(
        &app,
        "POST",
        "/projects/missing/context",
        Some(json!({"title": "x", "content": "y"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, not_found_body());

    // Another tenant can neither add to nor edit this project's context.
    let (status, _) = send_as(
        &app,
        OTHER_TENANT,
        "POST",
        "/projects/atlas/context",
        Some(json!({"title": "Planted", "content": "evil"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let uri = format!("/projects/atlas/context/{context_id}");
    let (status, _) = send_as(
        &app,
        OTHER_TENANT,
        "PATCH",
        &uri,
        Some(json!({"content": "overwritten"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The owner's patch changes only the given field and persists.
    let (status, patched) = send(&app, "PATCH", &uri, Some(json!({"title": "Storage"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["title"], "Storage");
    assert_eq!(patched["content"], "Use SQLite");
    let stored = ctx.store.list_context("local", "atlas").unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].title, "Storage");
    assert_eq!(stored[0].content, "Use SQLite");
    assert_eq!(stored[0].kind, "decision");

    let (status, _) = send(
        &app,
        "PATCH",
        "/projects/atlas/context/context_unknown",
        Some(json!({"title": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn subscriptions_persist_and_rescheduling_follows_enabled_and_schedule() {
    let (host, _) = mock_core(false).await;
    let (app, ctx, _) = app_with(host);

    let (status, created) = send(
        &app,
        "POST",
        "/projects/atlas/subscriptions",
        Some(json!({"kind": "schedule", "name": "Nightly", "schedule": "30m"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["enabled"], true, "enabled defaults on");
    let sub_id = created["id"].as_str().unwrap().to_owned();
    let updated_at = created["updatedAt"].as_i64().unwrap();
    assert_eq!(
        created["nextRunAt"].as_i64(),
        Some(updated_at + 1_800_000),
        "the schedule string sets the interval"
    );

    let (_, listed) = send(&app, "GET", "/projects/atlas/subscriptions", None).await;
    assert_eq!(listed, json!({"subscriptions": [created.clone()]}));

    let uri = format!("/projects/atlas/subscriptions/{sub_id}");
    // Renaming alone keeps the schedule.
    let (status, renamed) = send(&app, "PATCH", &uri, Some(json!({"name": "Hourly-ish"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["nextRunAt"], created["nextRunAt"]);

    // Disabling clears the next run, and that is what the scheduler reads.
    let (status, disabled) = send(&app, "PATCH", &uri, Some(json!({"enabled": false}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(disabled["enabled"], false);
    assert_eq!(disabled["nextRunAt"], Value::Null);
    let stored = ctx.store.list_subscriptions("local", "atlas").unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].name, "Hourly-ish");
    assert!(!stored[0].enabled);
    assert_eq!(stored[0].next_run_at, None);

    // Another tenant cannot see, create or change subscriptions here.
    let (status, _) = send_as(
        &app,
        OTHER_TENANT,
        "PATCH",
        &uri,
        Some(json!({"enabled": true})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!ctx.store.list_subscriptions("local", "atlas").unwrap()[0].enabled);
    let (status, _) = send_as(
        &app,
        OTHER_TENANT,
        "POST",
        "/projects/atlas/subscriptions",
        Some(json!({"kind": "webhook", "name": "Planted"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, other_list) = send_as(
        &app,
        OTHER_TENANT,
        "GET",
        "/projects/atlas/subscriptions",
        None,
    )
    .await;
    assert_eq!(other_list, json!({"subscriptions": []}));

    let (status, body) = send(
        &app,
        "POST",
        "/projects/missing/subscriptions",
        Some(json!({"kind": "webhook", "name": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, not_found_body());
    let (status, _) = send(
        &app,
        "PATCH",
        "/projects/atlas/subscriptions/sub_unknown",
        Some(json!({"name": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        ctx.store
            .list_subscriptions("local", "atlas")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn creating_a_worker_dispatches_through_core_and_records_it() {
    let (host, calls) = mock_core(false).await;
    let (app, ctx, _) = app_with(host);

    let (status, worker) = send(
        &app,
        "POST",
        "/projects/atlas/workers",
        Some(json!({"title": "Research", "task": "Find sources", "agentId": "writer"})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(worker["conversationId"], "conv-1");
    assert_eq!(worker["status"], "dispatched");
    assert_eq!(worker["agentId"], "writer");
    let (_, listed) = send(&app, "GET", "/projects/atlas/workers", None).await;
    assert_eq!(listed, json!({"workers": [worker]}));

    let before = calls.lock().unwrap().len();
    let (status, _) = send(
        &app,
        "POST",
        "/projects/missing/workers",
        Some(json!({"title": "x", "task": "y"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(calls.lock().unwrap().len(), before, "no dispatch for a 404");
    let (status, _) = send_as(
        &app,
        OTHER_TENANT,
        "POST",
        "/projects/atlas/workers",
        Some(json!({"title": "x", "task": "y"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(ctx.store.list_workers("local", "atlas").unwrap().len(), 1);
}

#[tokio::test]
async fn a_refused_worker_dispatch_records_nothing() {
    let (host, _) = mock_core(true).await;
    let (app, ctx, _) = app_with(host);
    let (status, _) = send(
        &app,
        "POST",
        "/projects/atlas/workers",
        Some(json!({"title": "Research", "task": "Find sources"})),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(ctx.store.list_workers("local", "atlas").unwrap().is_empty());
}

#[tokio::test]
async fn import_takes_newer_snapshots_and_never_crosses_tenants() {
    let (host, _) = mock_core(false).await;
    let (app, ctx, atlas) = app_with(host);

    let mut orion = serde_json::to_value(&atlas).unwrap();
    orion["id"] = json!("orion");
    orion["name"] = json!("Orion");
    orion["updatedAt"] = json!(1_000);
    let context = |id: &str, project: &str| json!({"id": id, "projectId": project, "kind": "note", "title": id, "content": "c", "updatedAt": 5});
    let (status, body) = send(
        &app,
        "POST",
        "/projects/import",
        Some(json!({
            "project": orion,
            "context": [context("ctx-own", "orion"), context("ctx-foreign", "atlas")],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["imported"], true);
    assert_eq!(body["project"]["name"], "Orion");
    let saved = ctx.store.list_context("local", "orion").unwrap();
    assert_eq!(saved.len(), 1, "context for other projects is dropped");
    assert_eq!(saved[0].id, "ctx-own");
    assert!(ctx.store.list_context("local", "atlas").unwrap().is_empty());

    // An older copy (bare project body form) does not overwrite the newer one.
    let mut stale = orion.clone();
    stale["name"] = json!("Stale Orion");
    stale["updatedAt"] = json!(10);
    let (status, body) = send(&app, "POST", "/projects/import", Some(stale)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["imported"], false);
    assert_eq!(body["project"]["name"], "Orion");

    let mut nameless = orion.clone();
    nameless["name"] = json!("  ");
    let (status, body) = send(&app, "POST", "/projects/import", Some(nameless)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error": "project id and name are required"}));

    // Another tenant importing an existing id cannot take the project over.
    let mut hijack = serde_json::to_value(&atlas).unwrap();
    hijack["name"] = json!("Hijacked");
    hijack["updatedAt"] = json!(i64::MAX);
    let (status, _) = send_as(&app, OTHER_TENANT, "POST", "/projects/import", Some(hijack)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let owned = ctx.store.get_project("local", "atlas").unwrap().unwrap();
    assert_eq!(owned.name, "Atlas");
    assert!(ctx
        .store
        .get_project(OTHER_TENANT, "atlas")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn bootstrap_and_sidebar_list_only_the_callers_projects() {
    let (host, _) = mock_core(false).await;
    let (app, ctx, atlas) = app_with(host);
    let mut quiet = atlas.clone();
    quiet.id = "quiet".to_owned();
    quiet.name = "Quiet".to_owned();
    quiet.description = "Solo notes".to_owned();
    quiet.members.clear();
    quiet.updated_at = atlas.updated_at - 1;
    ctx.store.save_project(&quiet).unwrap();
    let mut hidden = atlas.clone();
    hidden.id = "hidden".to_owned();
    hidden.tenant_id = OTHER_TENANT.to_owned();
    ctx.store.save_project(&hidden).unwrap();

    let (status, boot) = send(&app, "GET", "/bootstrap", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(boot["execution"], json!({"node": "active"}));
    let ids: Vec<&str> = boot["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&"atlas") && ids.contains(&"quiet"));

    let (status, sidebar) = send(&app, "GET", "/sidebar", None).await;
    assert_eq!(status, StatusCode::OK);
    let rows = sidebar["projects"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let row = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap().clone();
    // writer, reviewer and the design group count; the human does not.
    assert_eq!(row("atlas")["summary"], "3 bots");
    assert_eq!(row("atlas")["mainThreadId"], Value::Null);
    assert_eq!(row("atlas")["name"], "Atlas");
    assert_eq!(row("quiet")["summary"], "Solo notes", "a description wins");

    let (_, other) = send_as(&app, OTHER_TENANT, "GET", "/sidebar", None).await;
    let other_ids: Vec<&str> = other["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(other_ids, vec!["hidden"]);
}

#[tokio::test]
async fn the_main_thread_is_created_once_and_then_reused() {
    let (host, calls) = mock_core(false).await;
    let (app, ctx, _) = app_with(host);

    let (status, first) = send(&app, "POST", "/projects/atlas/main-thread", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["conversationId"], "conv-1");
    assert_eq!(first["project"]["coordinatorConversationId"], "conv-1");
    assert_eq!(
        ctx.store
            .get_project("local", "atlas")
            .unwrap()
            .unwrap()
            .coordinator_conversation_id
            .as_deref(),
        Some("conv-1")
    );
    assert_eq!(capability_calls(&calls, "threads.ensureMainThread"), 1);

    let (status, second) = send(&app, "POST", "/projects/atlas/main-thread", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["conversationId"], "conv-1");
    assert_eq!(
        capability_calls(&calls, "threads.ensureMainThread"),
        1,
        "an existing main thread is reused, not recreated"
    );
    assert_eq!(capability_calls(&calls, "threads.placeInProject"), 1);

    let (status, body) = send(&app, "POST", "/projects/missing/main-thread", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, not_found_body());
}

#[tokio::test]
async fn the_main_thread_needs_a_connected_core() {
    let store = Store::memory().unwrap();
    let (host, _) = mock_core(false).await;
    let (_, seeded, atlas) = app_with(host);
    drop(seeded);
    store.save_project(&atlas).unwrap();
    let app = routes(Arc::new(Ctx { host: None, store }));
    let (status, body) = send(&app, "POST", "/projects/atlas/main-thread", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body["error"],
        "Core is unavailable; open this project from a connected Ryu node"
    );
}
