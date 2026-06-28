use std::net::SocketAddr;

use anyhow::{anyhow, Result};
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use include_dir::{include_dir, Dir};
use serde_json::json;
use tokio::net::TcpListener;

use crate::app::{App, GroupsQuery, ProcessesQuery, SeriesQuery, SharedApp};

static PUBLIC_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/public");

pub(crate) async fn serve(shared: SharedApp) -> Result<()> {
    let (host, port) = {
        let app = shared.lock().map_err(|_| anyhow!("state lock poisoned"))?;
        (app.cfg.host.clone(), app.cfg.port)
    };
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let router = Router::new()
        .route("/", get(root))
        .route("/healthz", get(healthz))
        .route("/assets/*path", get(static_asset))
        .route("/api/status", get(api_status_handler))
        .route("/api/series", get(api_series_handler))
        .route("/api/groups", get(api_groups_handler))
        .route("/api/processes", get(api_processes_handler))
        .with_state(shared);
    let listener = TcpListener::bind(addr).await?;
    println!("[bms-watchdog] UI: http://{}", listener.local_addr()?);
    axum::serve(listener, router).await?;
    Ok(())
}

async fn root() -> impl IntoResponse {
    Html(PUBLIC_DIR.get_file("index.html").and_then(|f| f.contents_utf8()).unwrap_or("not found").to_string())
}

async fn healthz() -> impl IntoResponse { "ok\n" }

async fn static_asset(AxumPath(path): AxumPath<String>) -> Response {
    let Some(file) = PUBLIC_DIR.get_file(format!("assets/{path}")) else {
        return (StatusCode::NOT_FOUND, "not found\n").into_response();
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
    let mut resp = file.contents().to_vec().into_response();
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    resp
}

async fn api_status_handler(State(shared): State<SharedApp>) -> Response {
    with_app_json(shared, |app| app.api_status())
}
async fn api_series_handler(State(shared): State<SharedApp>, Query(q): Query<SeriesQuery>) -> Response {
    with_app_json(shared, |app| app.api_series(q))
}
async fn api_groups_handler(State(shared): State<SharedApp>, Query(q): Query<GroupsQuery>) -> Response {
    with_app_json(shared, |app| app.api_groups(q))
}
async fn api_processes_handler(State(shared): State<SharedApp>, Query(q): Query<ProcessesQuery>) -> Response {
    with_app_json(shared, |app| app.api_processes(q))
}

fn with_app_json(shared: SharedApp, f: impl FnOnce(&App) -> Result<serde_json::Value>) -> Response {
    match shared.lock() {
        Ok(app) => match f(&app) {
            Ok(v) => Json(v).into_response(),
            Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))).into_response(),
        },
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "state lock poisoned" }))).into_response(),
    }
}
