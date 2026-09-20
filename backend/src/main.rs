use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use ryu_projects::{
    api,
    dispatch::{spawn, Ctx, HostCall},
    store::{data_dir, Store},
};

const DEFAULT_PORT: u16 = 8022;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let port = std::env::var("RYU_PROJECTS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let store = Store::open(data_dir())?;
    let ctx = Arc::new(Ctx {
        host: HostCall::from_env(),
        store,
    });
    spawn(Arc::clone(&ctx));
    let protected_token = token.clone();
    let protected = Router::new()
        .nest("/api/projects", api::routes(ctx))
        .layer(from_fn(move |request: Request, next: Next| {
            let expected = protected_token.clone();
            async move { bearer_gate(expected.as_deref(), request, next).await }
        }));
    let app = Router::new().route("/health", get(health)).merge(protected);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    tracing::info!(%addr, "ryu-projects listening");
    axum::serve(tokio::net::TcpListener::bind(addr).await?, app).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"ok":true,"service":"ryu-projects"}))
}

async fn bearer_gate(expected: Option<&str>, request: Request, next: Next) -> Response {
    let provided = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if expected.is_some_and(|value| provided == Some(value)) {
        let mut request = request;
        let tenant = api::tenant_from_headers(request.headers());
        request.extensions_mut().insert(tenant);
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}
