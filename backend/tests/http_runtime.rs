//! Exercises the shipped process and SQLite store; no simulated agent host.
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

struct Runtime {
    child: Child,
    base: String,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn start(dir: &Scratch, token: Option<&str>) -> Runtime {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut command = Command::new(env!("CARGO_BIN_EXE_ryu-projects"));
    command
        .env("RYU_PROJECTS_PORT", port.to_string())
        .env("RYU_DIR", &dir.0)
        .env_remove("RYU_PLUGIN_DATA_DIR")
        .env("RYU_PROFILE", "dev")
        .env("RYU_KEYCHAIN", "off")
        .env_remove("RYU_CORE_URL")
        .env_remove("RYU_EXT_PLUGIN_ID")
        .env_remove("RYU_EXT_TOKEN")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(token) = token {
        command.env("RYU_EXT_TOKEN", token);
    }
    let mut runtime = Runtime {
        child: command.spawn().unwrap(),
        base: format!("http://127.0.0.1:{port}"),
    };
    let client = Client::new();
    for _ in 0..100 {
        if client
            .get(format!("{}/health", runtime.base))
            .send()
            .await
            .is_ok_and(|r| r.status() == StatusCode::OK)
        {
            return runtime;
        }
        assert!(
            runtime.child.try_wait().unwrap().is_none(),
            "sidecar exited before health"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("sidecar failed to become healthy");
}

async fn request(
    runtime: &Runtime,
    method: Method,
    path: &str,
    tenant: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Client::new()
        .request(method, format!("{}/api/projects{path}", runtime.base))
        .bearer_auth("runtime-test-token")
        .header("x-ryu-caller-org-id", tenant);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap())
}

#[tokio::test]
async fn shipped_process_preserves_exact_state_and_isolates_tenants_after_restart() {
    let dir =
        Scratch(std::env::temp_dir().join(format!("ryu-projects-http-{}", uuid::Uuid::new_v4())));
    let runtime = start(&dir, Some("runtime-test-token")).await;
    for auth in [None, Some("Bearer wrong")] {
        let mut req = Client::new().get(format!("{}/api/projects/projects", runtime.base));
        if let Some(auth) = auth {
            req = req.header("authorization", auth);
        }
        assert_eq!(req.send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
    let (status, error) = request(
        &runtime,
        Method::POST,
        "/projects",
        "one",
        Some(json!({"name":"  "})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error, json!({"error":"project name is required"}));
    let (status, project) = request(
        &runtime,
        Method::POST,
        "/projects",
        "one",
        Some(json!({"name":"HTTP durable project","owner":"Ada","description":"Exact fixture"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(project["name"], "HTTP durable project");
    assert_eq!(project["owner"], "Ada");
    assert!(project.get("tenantId").is_none());
    let id = project["id"].as_str().unwrap();
    let path = format!("/projects/{id}");
    let context_path = format!("{path}/context");
    let (status, context) = request(
        &runtime,
        Method::POST,
        &context_path,
        "one",
        Some(json!({"kind":"decision","title":"Approval","content":"Use local fixtures"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(context["content"], "Use local fixtures");
    let (status, _) = request(
        &runtime,
        Method::PATCH,
        &path,
        "two",
        Some(json!({"name":"Unauthorized overwrite"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(&runtime, Method::DELETE, &path, "two", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, others) = request(&runtime, Method::GET, "/projects", "two", None).await;
    assert_eq!(others, json!({"projects":[]}));
    let (status, failure) = request(
        &runtime,
        Method::POST,
        &format!("{path}/run"),
        "one",
        Some(json!({"prompt":"Do not dispatch"})),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        failure,
        json!({"error":"projects service could not complete the request"})
    );
    // Retrying the unavailable host must not fabricate workers or mutate the project.
    assert_eq!(
        request(
            &runtime,
            Method::POST,
            &format!("{path}/run"),
            "one",
            Some(json!({"prompt":"Do not dispatch"}))
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let (_, before) = request(&runtime, Method::GET, &path, "one", None).await;
    assert_eq!(before["project"], project);
    assert_eq!(before["context"], json!([context]));
    assert_eq!(before["workers"], json!([]));
    drop(runtime);
    let runtime = start(&dir, Some("runtime-test-token")).await;
    let (status, after) = request(&runtime, Method::GET, &path, "one", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after, before);
    let (status, deleted) = request(&runtime, Method::DELETE, &path, "one", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted, json!({"deleted":true}));
    assert_eq!(
        request(&runtime, Method::GET, &path, "one", None).await.0,
        StatusCode::NOT_FOUND
    );
    drop(runtime);
    let runtime = start(&dir, Some("runtime-test-token")).await;
    assert_eq!(
        request(&runtime, Method::GET, "/projects", "one", None)
            .await
            .1,
        json!({"projects":[]})
    );
}

#[tokio::test]
async fn missing_process_token_leaves_only_health_open() {
    let dir =
        Scratch(std::env::temp_dir().join(format!("ryu-projects-closed-{}", uuid::Uuid::new_v4())));
    let runtime = start(&dir, None).await;
    let health: Value = Client::new()
        .get(format!("{}/health", runtime.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // A standalone run seals under its generated root (no RYU_PLUGIN_DATA_DIR).
    assert_eq!(
        health,
        json!({
            "ok": true,
            "service": "ryu-projects",
            "sealing": { "state": "ok", "unreadable_rows": 0 },
        })
    );
    let denied = Client::new()
        .get(format!("{}/api/projects/projects", runtime.base))
        .bearer_auth("runtime-test-token")
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
}
