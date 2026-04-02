mod agent;
mod auth;

use axum::{
    extract::{Json, Query, Request, State},
    http::{header, HeaderMap, HeaderName, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Router,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use tokio::sync::broadcast;
use chrono::Local;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use axum::http::HeaderValue;
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, Any, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

use subtle::ConstantTimeEq;

fn log_to_file(msg: &str) {
    let _ = (|| {
        let cwd = std::env::current_dir().ok()?;
        let log_dir = cwd.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("mt5_panel.log");
        let mut f = OpenOptions::new().create(true).append(true).open(log_path).ok()?;
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S");
        writeln!(f, "[{}] {}", ts, msg).ok()
    })();
}

/// Diagnostic: log with millisecond precision for timing root-cause checks.
fn log_timing(msg: &str) {
    let _ = (|| {
        let cwd = std::env::current_dir().ok()?;
        let log_dir = cwd.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("mt5_panel.log");
        let mut f = OpenOptions::new().create(true).append(true).open(log_path).ok()?;
        let now = Local::now();
        let ms = now.timestamp_subsec_millis();
        writeln!(f, "[TIMING] {}.{:03} {}", now.format("%Y-%m-%d %H:%M:%S"), ms, msg).ok()
    })();
}

/// HTTP API listen port (default 3001). Set `PORT` to override.
fn listen_port() -> String {
    std::env::var("PORT").unwrap_or_else(|_| "3001".to_string())
}

fn api_local_base() -> String {
    format!("http://127.0.0.1:{}", listen_port())
}

/// If `CORS_ALLOWED_ORIGINS` is empty or unset, allow any origin (dev). Otherwise comma‑separated list, e.g. `http://localhost:5173,https://panel.example.com`.
fn build_cors_layer() -> CorsLayer {
    let raw = std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_default();
    let origins: Vec<HeaderValue> = raw
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect();

    // With `allow_credentials(true)`, tower-http rejects `Any` for methods or headers — use explicit lists.
    let credentialed_methods = AllowMethods::list([
        Method::GET,
        Method::POST,
        Method::PATCH,
        Method::PUT,
        Method::DELETE,
        Method::OPTIONS,
    ]);
    let credentialed_headers = AllowHeaders::list([
        header::ACCEPT,
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        HeaderName::from_static("x-panel-api-key"),
    ]);

    if origins.is_empty() {
        CorsLayer::new()
            .allow_methods(Any)
            .allow_headers(Any)
            .allow_origin(Any)
    } else {
        CorsLayer::new()
            .allow_methods(credentialed_methods)
            .allow_headers(credentialed_headers)
            .allow_origin(AllowOrigin::list(origins))
            .allow_credentials(true)
    }
}

/// When set, all `/api/*` and `/ws/*` require this key except health, CORS preflight, and agent device endpoints.
/// HTTP: header `X-Panel-Api-Key` or `Authorization: Bearer <key>`. WebSocket: query `panel_key=<key>` (browsers cannot set WS headers).
fn panel_api_key_from_env() -> Option<String> {
    std::env::var("PANEL_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn constant_time_str_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

fn extract_presented_panel_key(headers: &axum::http::HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(v) = headers.get("x-panel-api-key").and_then(|v| v.to_str().ok()) {
        return Some(v.to_string());
    }
    if let Some(v) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
    {
        return Some(v.to_string());
    }
    let q = query?;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k != "panel_key" {
            continue;
        }
        return Some(
            urlencoding::decode(v)
                .unwrap_or_else(|_| std::borrow::Cow::Borrowed(v))
                .into_owned(),
        );
    }
    None
}

/// Panel API key and/or operator JWT (see `auth` module). Viewer role: GET only (except `/api/auth/*`).
async fn access_control_middleware(
    State(app_state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if *request.method() == Method::OPTIONS {
        return next.run(request).await;
    }
    let path = request.uri().path();
    if path == "/api/health"
        || path == "/api/auth/login"
        || path == "/api/auth/me"
        || path == "/api/auth/logout"
    {
        return next.run(request).await;
    }
    // Remote agent inventory WebSocket: device authenticates with Bearer + X-Device-Id on upgrade.
    if path == "/ws/agent/device" {
        return next.run(request).await;
    }
    if path == "/api/agent/panel-base-url" {
        return next.run(request).await;
    }
    const AGENT_PUBLIC: &[&str] = &[
        "/api/agent/register",
        "/api/agent/heartbeat",
        "/api/agent/commands/next",
        "/api/agent/commands/complete",
    ];
    if AGENT_PUBLIC.iter().any(|p| *p == path) {
        return next.run(request).await;
    }

    let headers = request.headers();
    let panel_expected = panel_api_key_from_env();
    let panel_ok = panel_expected
        .as_ref()
        .map(|exp| {
            extract_presented_panel_key(headers, request.uri().query())
                .map(|p| constant_time_str_eq(&p, exp))
                .unwrap_or(false)
        })
        .unwrap_or(true);

    let op_active = auth::operator_auth_active(&app_state.operators);
    let claims = auth::extract_jwt_claims(headers);
    let jwt_ok = claims.is_some();

    let authorized = if op_active {
        panel_ok || jwt_ok
    } else if panel_expected.is_some() {
        panel_ok
    } else {
        true
    };

    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    if let Some(ref c) = claims {
        if c.role == "viewer"
            && *request.method() != Method::GET
            && !path.starts_with("/api/auth/")
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    next.run(request).await
}

/// Log once at startup when dangerous defaults are in effect (`agent_admin_key` is the effective key after file/env).
fn warn_insecure_deployment_defaults(agent_admin_key: &str) {
    if agent_admin_key == "dev-admin-change-me" {
        eprintln!(
            "mt5-panel-api: WARNING — agent admin key is still the dev default; set a strong secret (UI: Remote devices → Server admin key, or AGENT_ADMIN_KEY / backend/data/agent_admin_key.txt)."
        );
    }
    if panel_api_key_from_env().is_none() {
        eprintln!(
            "mt5-panel-api: NOTE — PANEL_API_KEY is unset; the HTTP/WebSocket API is not gated by a shared panel secret (see .env.example)."
        );
    }
}

/// Fixed accounts (Broker B and Exness). Only these two are used after exness copy-count hedge change.
const FIXED_ACCOUNTS: &[(&str, &str)] = &[
    ("default", "MT5 (Default)"),
    ("exness", "MT5 - EXNESS"),
];

const ACCOUNT_LIST: &[(&str, &str)] = FIXED_ACCOUNTS;

fn get_terminal_path_static(account_id: &str) -> Option<&'static str> {
    match account_id {
        "default" => Some(r"C:\Program Files\MetaTrader 5\terminal64.exe"),
        "exness" => Some(r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"),
        _ => None,
    }
}

/// `clone:<folder_name>` → `%USERPROFILE%\MT5_EXNESS_clones\<folder>\terminal64.exe` if it exists.
fn path_for_clone_account_id(account_id: &str) -> Option<String> {
    const PREFIX: &str = "clone:";
    let rest = account_id.strip_prefix(PREFIX)?;
    if rest.is_empty() || rest.contains(['/', '\\']) || rest.contains("..") {
        return None;
    }
    let exe = default_exness_clone_parent_dir().join(rest).join("terminal64.exe");
    if exe.is_file() {
        Some(exe.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Each entry: (account_id, label) for clone folders that contain `terminal64.exe`.
fn collect_clone_accounts() -> Vec<(String, String)> {
    let parent = default_exness_clone_parent_dir();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&parent) {
        let mut rows: Vec<_> = rd.flatten().collect();
        rows.sort_by_key(|e| e.path());
        for e in rows {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let exe = p.join("terminal64.exe");
            if !exe.is_file() {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let id = format!("clone:{}", name);
            let label = format!("{} (clone)", name);
            out.push((id, label));
        }
    }
    out.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    out
}

/// Exness copy hedge: N = number of Exness (copy) accounts. Broker B opens full volume V, Exness opens V/N.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ExnessConfig {
    #[serde(default = "default_exness_copy_count")]
    exness_copy_count: u32,
}

fn default_exness_copy_count() -> u32 {
    1
}

fn load_exness_config(path: &std::path::Path) -> ExnessConfig {
    let Ok(data) = std::fs::read_to_string(path) else {
        return ExnessConfig { exness_copy_count: 1 };
    };
    serde_json::from_str(&data).unwrap_or(ExnessConfig { exness_copy_count: 1 })
}

fn save_exness_config(path: &std::path::Path, config: &ExnessConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(config).unwrap_or_else(|_| r#"{"exness_copy_count":1}"#.to_string());
    std::fs::write(path, json)
}

fn get_path_for_account(_state: &AppState, account_id: &str) -> Option<String> {
    get_terminal_path_static(account_id)
        .map(String::from)
        .or_else(|| path_for_clone_account_id(account_id))
}

fn get_watcher_close_url(_state: &AppState, account_id: &str) -> String {
    match account_id {
        "default" => "http://127.0.0.1:3100/close".to_string(),
        "exness" => "http://127.0.0.1:3101/close".to_string(),
        _ => String::new(),
    }
}

#[derive(Deserialize)]
struct AccountQuery {
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SlTpPips {
    sl_pips: f64,
    tp_pips: f64,
}

#[derive(Deserialize, Serialize)]
struct CreatePositionRequest {
    symbol: String,
    order_type: String, // "buy" | "sell"
    volume: f64,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    stop_loss: Option<f64>,
    #[serde(default)]
    take_profit: Option<f64>,
    #[serde(default)]
    sl_pips: Option<f64>,
    #[serde(default)]
    tp_pips: Option<f64>,
    #[serde(default)]
    sl_tp_pips: Option<std::collections::HashMap<String, SlTpPips>>,
    /// When true, first account gets Buy and second gets Sell; when false, first gets Sell and second gets Buy. If None, random 50/50.
    #[serde(default)]
    first_account_buy: Option<bool>,
    #[serde(default)]
    comment: Option<String>,
}

#[derive(Serialize)]
struct CreatePositionResponse {
    ok: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_ticket: Option<u64>,
}

#[derive(Serialize)]
struct SymbolInfo {
    symbol: String,
    bid: f64,
    ask: f64,
    digits: u32,
}

#[derive(Serialize)]
struct PositionsResponse {
    ok: bool,
    positions: Vec<PositionDto>,
}

#[derive(Serialize)]
struct PositionDto {
    ticket: u64,
    symbol: String,
    r#type: String,
    volume: f64,
    price_open: f64,
    sl: f64,
    tp: f64,
    profit: f64,
    comment: String,
}

/// Stored when "place on both" succeeds. When one leg closes (SL/TP/manual), we close the other.
/// Optional panel_sl_tp fields: when set, the panel monitors price and closes both when hit (not set in MT5).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PositionPair {
    ticket_0: u64,
    account_0: String,
    ticket_1: u64,
    account_1: String,
    symbol: String,
    created_at: String,
    #[serde(default)]
    pub type_0: Option<String>,
    #[serde(default)]
    pub type_1: Option<String>,
    #[serde(default)]
    pub sl_pips_0: Option<f64>,
    #[serde(default)]
    pub tp_pips_0: Option<f64>,
    #[serde(default)]
    pub sl_pips_1: Option<f64>,
    #[serde(default)]
    pub tp_pips_1: Option<f64>,
}

/// Worker config and run state (persisted to worker_config.json).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct WorkerConfig {
    enabled: bool,
    fixed_interval: bool,
    interval_minutes: f64,
    min_minutes: f64,
    max_minutes: f64,
    symbols: Vec<String>,
    min_volume: f64,
    max_volume: f64,
    place_mode: String, // "both" | "master_slave_hedge"
    #[serde(default)]
    next_run_at: Option<String>, // ISO 8601
    #[serde(default)]
    last_symbol: Option<String>,
    #[serde(default)]
    run_count: u64,
    #[serde(default)]
    last_run_at: Option<String>,
    #[serde(default)]
    failed_positions: Vec<WorkerFailedRecord>,
    #[serde(default)]
    worker_balance: WorkerBalance,
    #[serde(default)]
    use_sl_tp: bool,
    #[serde(default)]
    sl_tp_pips: std::collections::HashMap<String, SlTpPips>,
    /// Max open positions across both accounts; 0 = no limit. Worker skips run when at or above this.
    #[serde(default)]
    max_open_positions: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkerFailedRecord {
    time: String,
    symbol: String,
    volume: f64,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WorkerBalance {
    #[serde(default)]
    account1_buy: u32,
    #[serde(default)]
    account1_sell: u32,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        WorkerConfig {
            enabled: false,
            fixed_interval: false,
            interval_minutes: 15.0,
            min_minutes: 1.0,
            max_minutes: 5.0,
            symbols: Vec::new(),
            min_volume: 0.0001,
            max_volume: 0.01,
            place_mode: "both".to_string(),
            next_run_at: None,
            last_symbol: None,
            run_count: 0,
            last_run_at: None,
            failed_positions: Vec::new(),
            worker_balance: WorkerBalance::default(),
            use_sl_tp: true,
            sl_tp_pips: std::collections::HashMap::new(),
            max_open_positions: 0,
        }
    }
}

fn load_worker_config(path: &std::path::Path) -> WorkerConfig {
    let Ok(data) = std::fs::read_to_string(path) else {
        return WorkerConfig::default();
    };
    serde_json::from_str(&data).unwrap_or_else(|_| WorkerConfig::default())
}

fn save_worker_config(path: &std::path::Path, config: &WorkerConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(config).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, json)
}

fn load_agent_admin_key_file(path: &std::path::Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    let line = s.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn account_id_field_present(row: &serde_json::Value) -> bool {
    match row.get("account_id") {
        Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
        Some(serde_json::Value::Number(_)) => true,
        _ => false,
    }
}

/// Merged snapshots from desktop agents (`positions_snapshot` on `/ws/agent/device`). Browsers use `/ws/remote-positions`.
struct RemotePositionsHub {
    cache: Mutex<HashMap<String, serde_json::Value>>,
    tx: broadcast::Sender<String>,
}

impl RemotePositionsHub {
    fn new() -> Arc<Self> {
        // Bursty agent snapshots; subscribers must tolerate RecvError::Lagged (see handle_remote_positions_socket).
        let (tx, _) = broadcast::channel::<String>(256);
        Arc::new(Self {
            cache: Mutex::new(HashMap::new()),
            tx,
        })
    }

    fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    fn snapshot_json(&self, agent: &Mutex<agent::AgentStore>) -> String {
        let cache = self.cache.lock().unwrap();
        let store = agent.lock().unwrap();
        let devices = store.list_devices();
        drop(store);
        let mut flat: Vec<serde_json::Value> = Vec::new();
        for (dev_id, results_val) in cache.iter() {
            let dev_label = devices
                .iter()
                .find_map(|d| {
                    if d.get("device_id").and_then(|x| x.as_str()) == Some(dev_id.as_str()) {
                        d.get("label")
                            .and_then(|x| x.as_str())
                            .map(std::string::ToString::to_string)
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| dev_id.clone());
            if let Some(arr) = results_val.as_array() {
                for row in arr {
                    let Some(mut o) = row.as_object().cloned() else {
                        continue;
                    };
                    o.insert("device_id".to_string(), serde_json::json!(dev_id));
                    o.insert("device_label".to_string(), serde_json::json!(dev_label));
                    flat.push(serde_json::Value::Object(o));
                }
            }
        }
        serde_json::json!({ "ok": true, "source": "remote", "results": flat }).to_string()
    }

    fn validate_snapshot_rows(arr: &[serde_json::Value]) -> Result<(), String> {
        if arr.len() > agent::MAX_REMOTE_DEVICE_TERMINALS {
            return Err(format!(
                "too many accounts in snapshot (max {})",
                agent::MAX_REMOTE_DEVICE_TERMINALS
            ));
        }
        for v in arr {
            let positions: Vec<serde_json::Value> = match v.get("positions") {
                None | Some(serde_json::Value::Null) => Vec::new(),
                Some(serde_json::Value::Array(a)) => a.clone(),
                Some(_) => {
                    return Err("each row positions must be an array or omitted".to_string());
                }
            };
            if positions.len() > 2000 {
                return Err("too many positions in one account".to_string());
            }
            if !account_id_field_present(v) {
                return Err("each row needs account_id".to_string());
            }
        }
        Ok(())
    }

    fn account_row_merge_key(row: &serde_json::Value) -> Result<String, String> {
        match row.get("account_id") {
            Some(serde_json::Value::String(s)) => {
                let t = s.trim();
                if t.is_empty() {
                    return Err("empty account_id".to_string());
                }
                Ok(t.to_string())
            }
            Some(serde_json::Value::Number(n)) => Ok(n.to_string()),
            _ => Err("each row needs account_id".to_string()),
        }
    }

    fn set_device_results(
        &self,
        agent: &Mutex<agent::AgentStore>,
        device_id: &str,
        results: serde_json::Value,
    ) -> Result<(), String> {
        let arr = results
            .as_array()
            .ok_or_else(|| "results must be an array".to_string())?;
        Self::validate_snapshot_rows(arr)?;
        self.cache
            .lock()
            .unwrap()
            .insert(device_id.to_string(), results);
        let s = self.snapshot_json(agent);
        let _ = self.tx.send(s);
        Ok(())
    }

    /// Upsert rows by `account_id` into this device’s cached snapshot, then broadcast (for incremental agent scans).
    fn merge_device_results(
        &self,
        agent: &Mutex<agent::AgentStore>,
        device_id: &str,
        results: serde_json::Value,
    ) -> Result<(), String> {
        let partial = results
            .as_array()
            .ok_or_else(|| "results must be an array".to_string())?;
        Self::validate_snapshot_rows(partial)?;
        let mut merged_map: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        {
            let cache = self.cache.lock().unwrap();
            if let Some(serde_json::Value::Array(existing)) = cache.get(device_id) {
                for row in existing {
                    let k = Self::account_row_merge_key(row)?;
                    merged_map.insert(k, row.clone());
                }
            }
        }
        for row in partial {
            let k = Self::account_row_merge_key(row)?;
            merged_map.insert(k, row.clone());
        }
        if merged_map.len() > agent::MAX_REMOTE_DEVICE_TERMINALS {
            return Err(format!(
                "too many accounts after merge (max {})",
                agent::MAX_REMOTE_DEVICE_TERMINALS
            ));
        }
        let mut merged_vec: Vec<serde_json::Value> = merged_map.into_values().collect();
        merged_vec.sort_by(|a, b| {
            let ka = Self::account_row_merge_key(a).unwrap_or_default();
            let kb = Self::account_row_merge_key(b).unwrap_or_default();
            ka.cmp(&kb)
        });
        self.cache
            .lock()
            .unwrap()
            .insert(device_id.to_string(), serde_json::Value::Array(merged_vec));
        let s = self.snapshot_json(agent);
        let _ = self.tx.send(s);
        Ok(())
    }

    fn remove_device(&self, agent: &Mutex<agent::AgentStore>, device_id: &str) {
        self.cache.lock().unwrap().remove(device_id);
        let s = self.snapshot_json(agent);
        let _ = self.tx.send(s);
    }

    /// How many devices have a non-empty cached snapshot (for admin diagnostics).
    fn cache_device_count(&self) -> usize {
        self.cache.lock().unwrap().len()
    }
}

#[derive(Clone)]
pub struct AppState {
    pairs: Arc<Mutex<Vec<PositionPair>>>,
    pair_file: PathBuf,
    close_both_bot_file: PathBuf,
    /// (ticket, account_id) for positions opened via single-account (FixedLot); never close these in hedge logic.
    single_account_tickets: Arc<Mutex<Vec<(u64, String)>>>,
    single_account_tickets_file: PathBuf,
    positions_tx: broadcast::Sender<String>,
    exness_config: Arc<Mutex<ExnessConfig>>,
    exness_config_file: PathBuf,
    worker_config: Arc<Mutex<WorkerConfig>>,
    worker_config_file: PathBuf,
    /// Remote MT5 desktop agents (pairing, command queue).
    agent: Arc<Mutex<agent::AgentStore>>,
    /// Push notifications for agent hub (devices/commands). Subscribers: `GET /ws/agent`.
    agent_hub_tx: broadcast::Sender<String>,
    /// Throttle high-frequency refreshes (e.g. heartbeats).
    agent_hub_throttle: Arc<Mutex<Option<std::time::Instant>>>,
    /// Operator login (JWT cookie); see `auth` module.
    pub operators: Arc<auth::OperatorStore>,
    /// Effective agent admin secret (remote devices / pairing). Loaded from `agent_admin_key_file` if present, else env `AGENT_ADMIN_KEY`, else dev default.
    pub agent_admin_key: Arc<Mutex<String>>,
    pub agent_admin_key_file: PathBuf,
    remote_positions: Arc<RemotePositionsHub>,
    /// Latest `/ws/positions` JSON so new WebSocket subscribers get data immediately (avoids empty UI until next tick).
    positions_last_broadcast: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub fn verify_agent_admin_key(&self, key: Option<&str>) -> bool {
        let g = self.agent_admin_key.lock().unwrap();
        key == Some(g.as_str())
    }

    pub(crate) fn remote_positions_apply_snapshot(
        &self,
        device_id: &str,
        results: serde_json::Value,
    ) -> Result<(), String> {
        self.remote_positions
            .set_device_results(&self.agent, device_id, results)
    }

    pub(crate) fn remote_positions_merge_snapshot(
        &self,
        device_id: &str,
        results: serde_json::Value,
    ) -> Result<(), String> {
        self.remote_positions
            .merge_device_results(&self.agent, device_id, results)
    }

    pub(crate) fn remote_positions_clear_device(&self, device_id: &str) {
        self.remote_positions.remove_device(&self.agent, device_id);
    }

    fn emit_agent_hub_refresh(&self) {
        let _ = self.agent_hub_tx.send(r#"{"type":"refresh"}"#.to_string());
    }

    /// Push terminal inventory for one device to admin `/ws/agent` subscribers (no HTTP polling).
    pub(crate) fn emit_device_terminals(&self, device_id: &str, terminals: &[agent::TerminalInventoryEntry]) {
        let _ = self.agent_hub_tx.send(
            serde_json::json!({
                "type": "device_terminals",
                "device_id": device_id,
                "terminals": terminals
            })
            .to_string(),
        );
    }

    fn emit_agent_hub_refresh_throttled(&self, min_interval: std::time::Duration) {
        let mut last = self.agent_hub_throttle.lock().unwrap();
        let now = std::time::Instant::now();
        if let Some(t) = *last {
            if now.duration_since(t) < min_interval {
                return;
            }
        }
        *last = Some(now);
        drop(last);
        self.emit_agent_hub_refresh();
    }
}

#[derive(Deserialize)]
struct HedgeCloseOrphanRequest {
    ticket: u64,
    account_id: String,
}

#[derive(Deserialize)]
struct HedgeClosePairRequest {
    /// Index into the pairs list (0-based).
    index: usize,
}

#[derive(Deserialize)]
struct HedgePairUpdateRequest {
    index: usize,
    /// 0 = first leg (account_0), 1 = second leg (account_1)
    leg: u8,
    sl_pips: f64,
    tp_pips: f64,
}

#[derive(Serialize, Deserialize)]
struct CloseBothBotState {
    enabled: bool,
}

fn load_pairs(path: &std::path::Path) -> Vec<PositionPair> {
    let Ok(data) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_pairs(path: &std::path::Path, pairs: &[PositionPair]) {
    let _ = (|| {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let data = serde_json::to_string_pretty(pairs).ok()?;
        std::fs::write(path, data).ok()
    })();
}

fn load_close_both_bot(path: &std::path::Path) -> bool {
    let Ok(data) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<CloseBothBotState>(&data)
        .map(|s| s.enabled)
        .unwrap_or(false)
}

fn save_close_both_bot(path: &std::path::Path, enabled: bool) {
    let _ = (|| {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let data = serde_json::to_string_pretty(&CloseBothBotState { enabled }).ok()?;
        std::fs::write(path, data).ok()
    })();
}

/// Tickets opened via single-account (FixedLot) — never close these in hedge_sync / hedge_close_orphan.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SingleAccountTicketEntry {
    ticket: u64,
    account_id: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SingleAccountTicketsFile {
    tickets: Vec<SingleAccountTicketEntry>,
}
const SINGLE_ACCOUNT_TICKETS_MAX: usize = 2000;

fn load_single_account_tickets(path: &std::path::Path) -> Vec<(u64, String)> {
    let Ok(data) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let parsed: SingleAccountTicketsFile = serde_json::from_str(&data).unwrap_or_default();
    parsed
        .tickets
        .into_iter()
        .map(|e| (e.ticket, e.account_id))
        .collect()
}

fn save_single_account_tickets(path: &std::path::Path, tickets: &[(u64, String)]) {
    let _ = (|| {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tail = if tickets.len() > SINGLE_ACCOUNT_TICKETS_MAX {
            tickets.len() - SINGLE_ACCOUNT_TICKETS_MAX
        } else {
            0
        };
        let file = SingleAccountTicketsFile {
            tickets: tickets[tail..]
                .iter()
                .map(|(t, a)| SingleAccountTicketEntry {
                    ticket: *t,
                    account_id: a.clone(),
                })
                .collect(),
        };
        let data = serde_json::to_string_pretty(&file).ok()?;
        std::fs::write(path, data).ok()
    })();
}

/// Close one position on one account (watcher first, then bridge). Does not touch pairs list.
async fn close_one_position(state: &AppState, ticket: u64, account_id: &str) -> bool {
    let path = match get_path_for_account(state, account_id) {
        Some(p) => p,
        None => return false,
    };
    let watcher_close_url = get_watcher_close_url(state, account_id);
    if !watcher_close_url.is_empty() {
        if let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
        {
            let body = serde_json::json!({ "ticket": ticket });
            let res = client.post(&watcher_close_url).json(&body).send().await;
            if let Ok(r) = res {
                if r.status().is_success() {
                    if let Ok(j) = r.json::<serde_json::Value>().await {
                        if j.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    let path_clone = path;
    let close_body = format!("{{\"ticket\":{}}}", ticket);
    tokio::task::spawn_blocking(move || call_python_bridge("close_position", &close_body, &path_clone).is_ok())
        .await
        .unwrap_or(false)
}

/// Returns list of position tickets for the given account (blocking). Path must be resolved by caller.
fn get_position_tickets(path: &str) -> Vec<u64> {
    let Ok(stdout) = call_python_bridge("positions", "{}", path) else {
        return Vec::new();
    };
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or(serde_json::json!({}));
    let arr = v
        .get("positions")
        .and_then(|p| p.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    arr.iter()
        .filter_map(|p| p.get("ticket").and_then(|t| t.as_u64()))
        .collect()
}

/// Returns position comment for the given ticket, or empty string if not found (blocking).
fn get_position_comment(path: &str, ticket: u64) -> String {
    let Ok(stdout) = call_python_bridge("positions", "{}", path) else {
        return String::new();
    };
    let v: serde_json::Value = serde_json::from_str(&stdout).unwrap_or(serde_json::json!({}));
    let arr = v
        .get("positions")
        .and_then(|p| p.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    for p in arr {
        if p.get("ticket").and_then(|t| t.as_u64()) == Some(ticket) {
            return p.get("comment").and_then(|c| c.as_str()).unwrap_or("").to_string();
        }
    }
    String::new()
}

/// Comment substring that marks single-account (FixedLot) positions; do not close these in hedge sync/orphan.
const FIXEDLOT_COMMENT: &str = "fixedlot";

/// Periodically check paired positions; if one leg closed (SL/TP/manual), close the other.
async fn hedge_sync_task(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let (id0, _) = ACCOUNT_LIST[0];
    let (id1, _) = ACCOUNT_LIST[1];
    let id0 = id0.to_string();
    let id1 = id1.to_string();

    loop {
        interval.tick().await;

        let pair_count = state.pairs.lock().unwrap().len();
        if pair_count > 0 {
            log_to_file(&format!("hedge_sync cycle: checking {} paired position(s)", pair_count));
        }

        let path0 = get_path_for_account(&state, &id0).unwrap_or_default();
        let path1 = get_path_for_account(&state, &id1).unwrap_or_default();
        let tickets_0 = tokio::task::spawn_blocking(move || get_position_tickets(&path0))
            .await
            .unwrap_or_default();
        let tickets_1 = tokio::task::spawn_blocking(move || get_position_tickets(&path1))
            .await
            .unwrap_or_default();

        let set0: std::collections::HashSet<u64> = tickets_0.into_iter().collect();
        let set1: std::collections::HashSet<u64> = tickets_1.into_iter().collect();

        let mut to_remove = Vec::new();
        let mut to_close: Vec<(u64, String)> = Vec::new(); // (ticket, account_id)

        {
            let mut pairs = state.pairs.lock().unwrap();
            for (i, pair) in pairs.iter().enumerate() {
                let in0 = set0.contains(&pair.ticket_0);
                let in1 = set1.contains(&pair.ticket_1);
                if !in0 && in1 {
                    to_close.push((pair.ticket_1, pair.account_1.clone()));
                    to_remove.push(i);
                    log_to_file(&format!(
                        "hedge_sync: pair {} {} (ticket_0={}) closed on account_0; closing ticket_1={} on {}",
                        pair.symbol, pair.created_at, pair.ticket_0, pair.ticket_1, pair.account_1
                    ));
                } else if in0 && !in1 {
                    to_close.push((pair.ticket_0, pair.account_0.clone()));
                    to_remove.push(i);
                    log_to_file(&format!(
                        "hedge_sync: pair {} {} (ticket_1={}) closed on account_1; closing ticket_0={} on {}",
                        pair.symbol, pair.created_at, pair.ticket_1, pair.ticket_0, pair.account_0
                    ));
                } else if !in0 && !in1 {
                    to_remove.push(i);
                }
            }
            for i in to_remove.iter().rev() {
                pairs.remove(*i);
            }
            save_pairs(&state.pair_file, &pairs);
        }

        // Prune single_account_tickets: remove entries for tickets no longer open on that account
        {
            let mut list = state.single_account_tickets.lock().unwrap();
            let before = list.len();
            list.retain(|(t, a)| {
                if a == &id0 {
                    set0.contains(t)
                } else if a == &id1 {
                    set1.contains(t)
                } else {
                    true
                }
            });
            if list.len() != before {
                save_single_account_tickets(&state.single_account_tickets_file, &list);
            }
        }

        for (ticket, account_id) in to_close {
            {
                let list = state.single_account_tickets.lock().unwrap();
                if list.iter().any(|(t, a)| *t == ticket && *a == account_id) {
                    log_to_file(&format!(
                        "hedge_sync: skipping close account={} ticket={} (registered single-account/fixedlot)",
                        account_id, ticket
                    ));
                    continue;
                }
            }
            let path = get_path_for_account(&state, &account_id).unwrap_or_default();
            let path_clone = path.clone();
            let comment = tokio::task::spawn_blocking(move || get_position_comment(&path_clone, ticket))
                .await
                .unwrap_or_default();
            if comment.to_lowercase().contains(FIXEDLOT_COMMENT) {
                log_to_file(&format!(
                    "hedge_sync: skipping close account={} ticket={} (fixedlot/single-account position)",
                    account_id, ticket
                ));
                continue;
            }
            let close_body = format!("{{\"ticket\":{}}}", ticket);
            let result = tokio::task::spawn_blocking(move || call_python_bridge("close_position", &close_body, &path))
                .await
                .unwrap_or_else(|_| Err("task join failed".to_string()));
            log_to_file(&format!(
                "hedge_sync close_position account={} ticket={} result={}",
                account_id,
                ticket,
                result.as_ref().map(|s| s.as_str()).unwrap_or_else(|e| e)
            ));
        }
    }
}

#[tokio::main]
async fn main() {
    let cors = build_cors_layer();

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let data_dir = if cwd.join("backend").join("Cargo.toml").exists() {
        cwd.join("backend").join("data")
    } else {
        cwd.join("data")
    };
    let pair_file = data_dir.join("position_pairs.json");
    let close_both_bot_file = data_dir.join("close_both_bot.json");
    let single_account_tickets_file = data_dir.join("single_account_tickets.json");
    let exness_config_file = data_dir.join("exness_config.json");
    let worker_config_file = data_dir.join("worker_config.json");
    let pairs = load_pairs(&pair_file);
    let single_account_tickets = load_single_account_tickets(&single_account_tickets_file);
    let mut exness_config = load_exness_config(&exness_config_file);
    if exness_config.exness_copy_count < 1 {
        exness_config.exness_copy_count = 1;
        let _ = save_exness_config(&exness_config_file, &exness_config);
    }
    let worker_config = load_worker_config(&worker_config_file);
    let agent_state_path = data_dir.join("agent_state.json");
    let agent_store = agent::AgentStore::load(agent_state_path);
    let agent_admin_key_file = data_dir.join("agent_admin_key.txt");
    let env_agent_key =
        std::env::var("AGENT_ADMIN_KEY").unwrap_or_else(|_| "dev-admin-change-me".to_string());
    let initial_agent_admin_key =
        load_agent_admin_key_file(&agent_admin_key_file).unwrap_or(env_agent_key);
    warn_insecure_deployment_defaults(initial_agent_admin_key.as_str());
    let operators_path = data_dir.join("operators.json");
    auth::maybe_bootstrap_operators(&operators_path);
    let operators = Arc::new(auth::OperatorStore::load(operators_path));
    let (positions_tx, _) = broadcast::channel::<String>(64);
    let positions_tx_for_loop = positions_tx.clone();
    let (agent_hub_tx, _) = broadcast::channel::<String>(256);
    let remote_positions = RemotePositionsHub::new();
    let state = AppState {
        pairs: Arc::new(Mutex::new(pairs)),
        pair_file: pair_file.clone(),
        close_both_bot_file: close_both_bot_file.clone(),
        single_account_tickets: Arc::new(Mutex::new(single_account_tickets)),
        single_account_tickets_file: single_account_tickets_file.clone(),
        positions_tx: positions_tx.clone(),
        exness_config: Arc::new(Mutex::new(exness_config)),
        exness_config_file: exness_config_file.clone(),
        worker_config: Arc::new(Mutex::new(worker_config)),
        worker_config_file: worker_config_file.clone(),
        agent: Arc::new(Mutex::new(agent_store)),
        agent_hub_tx: agent_hub_tx.clone(),
        agent_hub_throttle: Arc::new(Mutex::new(None)),
        operators: operators.clone(),
        agent_admin_key: Arc::new(Mutex::new(initial_agent_admin_key)),
        agent_admin_key_file: agent_admin_key_file.clone(),
        remote_positions: remote_positions.clone(),
        positions_last_broadcast: Arc::new(Mutex::new(None)),
    };
    tokio::spawn(positions_broadcast_loop(positions_tx_for_loop, state.clone()));
    let state_for_sync = state.clone();
    let state_worker = state.clone();
    let state_remote_worker = state.clone();

    let mut agent_register_builder = GovernorConfigBuilder::default();
    let mut agent_register_builder = agent_register_builder.key_extractor(SmartIpKeyExtractor);
    agent_register_builder
        .period(Duration::from_secs(1))
        .burst_size(25);
    let agent_register_limit = Arc::new(agent_register_builder.finish().unwrap());

    let app = Router::new()
        .route("/api/auth/login", post(auth::auth_login))
        .route("/api/auth/logout", post(auth::auth_logout))
        .route("/api/auth/me", get(auth::auth_me))
        .route("/api/auth/mfa/setup", post(auth::auth_mfa_setup))
        .route("/api/auth/mfa/confirm", post(auth::auth_mfa_confirm))
        .route("/api/auth/users", post(auth::auth_add_user))
        .route("/api/health", get(health))
        .route("/ws/positions", get(ws_positions))
        .route("/ws/remote-positions", get(ws_remote_positions))
        .route("/ws/agent", get(ws_agent_hub))
        .route("/ws/agent/device", get(agent::ws_agent_device))
        .route("/api/accounts", get(accounts_list))
        .route("/api/symbols", get(symbols))
        .route("/api/positions", get(positions))
        .route("/api/positions/all", get(positions_all))
        .route("/api/positions/close-all", post(positions_close_all))
        .route("/api/positions/close-selected", post(positions_close_selected))
        .route("/api/history/all", get(history_all))
        .route("/api/history/paired", get(history_paired))
        .route("/api/positions", post(create_position))
        .route("/api/positions/both", post(create_position_both))
        .route("/api/positions/master-slave-hedge", post(create_position_master_slave_hedge))
        .route("/api/hedge-pairs", get(hedge_pairs_list))
        .route("/api/hedge-close-orphan", post(hedge_close_orphan))
        .route("/api/hedge-close-pair", post(hedge_close_pair))
        .route("/api/hedge-pair-update", post(hedge_pair_update))
        .route("/api/hedge-close-all-pairs", post(hedge_close_all_pairs))
        .route("/api/close-both-bot", get(close_both_bot_get))
        .route("/api/close-both-bot", post(close_both_bot_set))
        .route("/api/exness-config", get(exness_config_get))
        .route("/api/exness-config", patch(exness_config_patch))
        .route(
            "/api/exness-terminal-clone/defaults",
            get(exness_terminal_clone_defaults),
        )
        .route("/api/exness-terminal-clone", post(exness_terminal_clone))
        .route("/api/terminals", get(terminals_list))
        .route("/api/worker/config", get(worker_config_get))
        .route("/api/worker/config", patch(worker_config_patch))
        .route("/api/worker/run-once", post(worker_run_once))
        .route("/api/agent/panel-base-url", get(agent_panel_base_url_hint))
        .route("/api/agent/admin-key/status", get(agent::agent_admin_key_status))
        .route("/api/agent/admin-key", post(agent::agent_admin_key_update))
        .route(
            "/api/agent/pairing-codes",
            post(agent::agent_create_pairing_code),
        )
        .route(
            "/api/agent/register",
            post(agent::agent_register).layer(GovernorLayer {
                config: agent_register_limit,
            }),
        )
        .route("/api/agent/heartbeat", post(agent::agent_heartbeat))
        .route("/api/agent/commands/next", get(agent::agent_commands_next))
        .route(
            "/api/agent/commands/complete",
            post(agent::agent_command_complete),
        )
        .route(
            "/api/agent/commands/enqueue",
            post(agent::agent_enqueue_command),
        )
        .route("/api/agent/devices/list", post(agent::agent_list_devices))
        .route("/api/agent/devices", get(agent::agent_list_devices_get))
        .route(
            "/api/agent/remote-positions",
            get(agent_remote_positions_snapshot_get),
        )
        .route(
            "/api/agent/devices/delete",
            post(agent::agent_delete_device),
        )
        .route(
            "/api/agent/devices/revoke",
            post(agent::agent_revoke_device),
        )
        .route("/api/agent/commands/list", post(agent::agent_list_commands))
        .route("/api/agent/worker/set", post(agent::agent_worker_set))
        .route("/api/agent/worker/get", post(agent::agent_worker_get))
        .route(
            "/api/agent/remote-positions/peek",
            post(remote_positions_peek),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access_control_middleware,
        ))
        .layer(cors)
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("geolocation=(), microphone=(), camera=()"),
        ))
        .with_state(state);

    tokio::spawn(hedge_sync_task(state_for_sync));
    tokio::spawn(worker_scheduler_loop(state_worker));
    tokio::spawn(agent::remote_worker_scheduler_loop(state_remote_worker));

    let addr = format!("0.0.0.0:{}", listen_port());
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    println!(
        "MT5 Panel API listening on http://localhost:{}",
        listen_port()
    );
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap();
}

/// Strip to `scheme://host[:port]` from a full URL or Origin-style value (no `url` crate).
fn absolute_origin_from_url_like(s: &str) -> Option<String> {
    let s = s.trim();
    let (scheme, after) = s
        .strip_prefix("https://")
        .map(|a| ("https", a))
        .or_else(|| s.strip_prefix("http://").map(|a| ("http", a)))?;
    let host_end = after.find('/').unwrap_or(after.len());
    let host_port = after.get(..host_end)?;
    if host_port.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme, host_port))
}

fn host_port_is_loopback(host_port: &str) -> bool {
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            &rest[..end]
        } else {
            return true;
        }
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    let h = host.to_ascii_lowercase();
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "0.0.0.0"
}

fn origin_is_usable_public_base(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    !host_port_is_loopback(rest)
}

/// Picks the URL agents should call: explicit env, then browser Origin/Referer (e.g. trycloudflare), then Host headers.
fn resolve_panel_public_base_url(headers: &HeaderMap) -> (String, &'static str) {
    if let Ok(v) = std::env::var("PANEL_PUBLIC_BASE_URL") {
        let s = v.trim().trim_end_matches('/').to_string();
        if !s.is_empty() {
            return (s, "env");
        }
    }
    if let Some(v) = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| absolute_origin_from_url_like(s))
    {
        if origin_is_usable_public_base(&v) {
            return (v, "origin");
        }
    }
    if let Some(v) = headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| absolute_origin_from_url_like(s))
    {
        if origin_is_usable_public_base(&v) {
            return (v, "referer");
        }
    }
    (panel_public_base_url_from_headers(headers), "host")
}

/// Public hint: base URL remote agents should use (`api_base`), derived from this HTTP request's Host / reverse-proxy headers.
fn panel_public_base_url_from_headers(headers: &HeaderMap) -> String {
    let api_port = listen_port();
    let host_header = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1")
        .trim();

    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok());

    // Host may be `[::1]:5173` or `[::1]` (RFC 3986 / HTTP Host).
    if let Some(rest) = host_header.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let inner = &rest[..end];
            let suffix = &rest[end + 1..];
            let port = suffix.strip_prefix(':').and_then(|s| s.parse::<u16>().ok());
            let host_part = format!("[{}]", inner);
            return match port {
                Some(443) => format!("{}://{}", forwarded_proto.unwrap_or("https"), host_part),
                Some(80) => format!("{}://{}", forwarded_proto.unwrap_or("http"), host_part),
                Some(_) | None => format!("http://{}:{}", host_part, api_port),
            };
        }
        return format!("http://127.0.0.1:{}", api_port);
    }

    if let Some((hostname, port_str)) = host_header.rsplit_once(':') {
        if let Ok(p) = port_str.parse::<u16>() {
            if p != 80 && p != 443 {
                return format!("http://{}:{}", hostname, api_port);
            }
            if p == 443 {
                let scheme = forwarded_proto.unwrap_or("https");
                return format!("{}://{}", scheme, hostname);
            }
            let scheme = forwarded_proto.unwrap_or("http");
            return format!("{}://{}", scheme, hostname);
        }
    }

    let scheme = forwarded_proto.unwrap_or("http");
    format!("{}://{}", scheme, host_header)
}

async fn agent_panel_base_url_hint(headers: HeaderMap) -> impl IntoResponse {
    let (panel_api_base, source) = resolve_panel_public_base_url(&headers);
    Json(serde_json::json!({
        "ok": true,
        "panel_api_base": panel_api_base,
        "source": source
    }))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "mt5-panel-api",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Parse mt5_bridge `positions` stdout: rows and optional warning when `ok` is false.
fn parse_positions_bridge_stdout(stdout: &str) -> (Vec<serde_json::Value>, Option<String>) {
    let v: serde_json::Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => {
            return (
                Vec::new(),
                Some("invalid JSON from MT5 bridge".to_string()),
            );
        }
    };
    let positions = v
        .get("positions")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let err = if v.get("ok").and_then(|x| x.as_bool()) == Some(false) {
        v.get("message")
            .or_else(|| v.get("error"))
            .and_then(|m| m.as_str())
            .map(std::string::ToString::to_string)
    } else {
        None
    };
    (positions, err)
}

/// Every 500ms fetch positions from all available accounts (fixed + clones) and broadcast to WebSocket.
/// Idles when no subscribers so we do not poll MT5 while nobody is connected.
async fn positions_broadcast_loop(tx: broadcast::Sender<String>, state: AppState) {
    use std::collections::HashSet;
    use tokio::time::Duration;
    const POSITIONS_UPDATE_MS: u64 = 500;
    const POSITIONS_CALL_TIMEOUT_MS: u64 = 2500;
    const TICKS_CALL_TIMEOUT_MS: u64 = 1500;
    const IDLE_WAIT_SEC: u64 = 2;
    loop {
        while tx.receiver_count() == 0 {
            tokio::time::sleep(Duration::from_secs(IDLE_WAIT_SEC)).await;
        }
        tokio::time::sleep(Duration::from_millis(POSITIONS_UPDATE_MS)).await;
        let mut account_list: Vec<(String, String)> = FIXED_ACCOUNTS
            .iter()
            .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
            .collect();
        account_list.extend(collect_clone_accounts());
        let mut results: Vec<serde_json::Value> = Vec::new();
        let mut symbols_set: HashSet<String> = HashSet::new();

        // Run positions fetches in parallel so one slow terminal does not block others.
        let mut handles = Vec::new();
        for (id, label) in account_list {
            let path = get_path_for_account(&state, &id).unwrap_or_default();
            let path_clone = path.clone();
            let h = tokio::task::spawn_blocking(move || {
                call_python_bridge_with_timeout("positions", "{}", &path_clone, POSITIONS_CALL_TIMEOUT_MS)
            });
            handles.push((id, label, h));
        }

        for (id, label, handle) in handles {
            match handle.await {
                Ok(Ok(stdout)) => {
                    let (positions, bridge_err) = parse_positions_bridge_stdout(&stdout);
                    for p in &positions {
                        if let Some(s) = p.get("symbol").and_then(|s| s.as_str()) {
                            symbols_set.insert(s.to_string());
                        }
                    }
                    let mut row = serde_json::json!({
                        "account_id": id,
                        "label": label,
                        "positions": positions
                    });
                    if let Some(e) = bridge_err {
                        row["bridge_error"] = serde_json::json!(e);
                    }
                    results.push(row);
                }
                Ok(Err(_)) | Err(_) => {
                    results.push(serde_json::json!({
                        "account_id": id,
                        "label": label,
                        "positions": []
                    }));
                }
            }
        }
        // Always include EURUSD in the websocket price payload for live ticker UIs
        // even when there are no open positions.
        symbols_set.insert("EURUSD".to_string());
        symbols_set.insert("EURUSDm".to_string());

        let mut prices = serde_json::Map::new();
        if !symbols_set.is_empty() {
            let symbols: Vec<String> = symbols_set.into_iter().collect();
            let path0 = get_path_for_account(&state, FIXED_ACCOUNTS[0].0).unwrap_or_default();
            let body = serde_json::json!({ "symbols": symbols }).to_string();
            let ticks_h = tokio::task::spawn_blocking(move || {
                call_python_bridge_with_timeout("symbol_ticks", &body, &path0, TICKS_CALL_TIMEOUT_MS)
            });
            if let Ok(Ok(stdout)) = ticks_h.await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                    if let Some(t) = v.get("ticks").and_then(|t| t.as_object()) {
                        prices = t.clone();
                    }
                }
            }
        }
        let json = serde_json::json!({ "ok": true, "results": results, "prices": prices }).to_string();
        {
            let mut last = state.positions_last_broadcast.lock().unwrap();
            *last = Some(json.clone());
        }
        let _ = tx.send(json);
    }
}

async fn ws_positions(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_positions_socket(socket, state))
}

async fn ws_remote_positions(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_remote_positions_socket(socket, state))
}

async fn handle_remote_positions_socket(mut socket: WebSocket, state: AppState) {
    use broadcast::error::RecvError;
    let initial = state.remote_positions.snapshot_json(&state.agent);
    if socket.send(Message::Text(initial.into())).await.is_err() {
        return;
    }
    let mut rx = state.remote_positions.subscribe();
    loop {
        match rx.recv().await {
            Ok(msg) => {
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            Err(RecvError::Lagged(_)) => {
                // Skipped messages; push current merged snapshot so the client is not stuck on stale/empty JSON.
                let resync = state.remote_positions.snapshot_json(&state.agent);
                if socket.send(Message::Text(resync.into())).await.is_err() {
                    break;
                }
            }
            Err(RecvError::Closed) => break,
        }
    }
}

async fn handle_positions_socket(mut socket: WebSocket, state: AppState) {
    use broadcast::error::RecvError;
    let snap = state.positions_last_broadcast.lock().unwrap().clone();
    if let Some(s) = snap {
        if socket.send(Message::Text(s.into())).await.is_err() {
            return;
        }
    }
    let mut rx = state.positions_tx.subscribe();
    loop {
        match rx.recv().await {
            Ok(msg) => {
                if socket.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
            Err(RecvError::Lagged(_)) => {
                // Same idea as `/ws/remote-positions`: after lag, send the latest snapshot so the UI does not sit on stale/empty data.
                let resync = state.positions_last_broadcast.lock().unwrap().clone();
                if let Some(s) = resync {
                    if socket.send(Message::Text(s)).await.is_err() {
                        break;
                    }
                }
            }
            Err(RecvError::Closed) => break,
        }
    }
}

async fn ws_agent_hub(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_agent_hub_socket(socket, state))
}

async fn handle_agent_hub_socket(mut socket: WebSocket, state: AppState) {
    use broadcast::error::RecvError;

    let first = socket.recv().await;
    let Some(Ok(Message::Text(txt))) = first else {
        let _ = socket.close().await;
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
        let _ = socket.close().await;
        return;
    };
    let key = v.get("admin_key").and_then(|x| x.as_str());
    if !state.verify_agent_admin_key(key) {
        let _ = socket
            .send(Message::Text(r#"{"ok":false,"error":"unauthorized"}"#.into()))
            .await;
        let _ = socket.close().await;
        return;
    }
    let snapshot = {
        let store = state.agent.lock().unwrap();
        store.terminal_inventories_snapshot_json()
    };
    let sub = serde_json::json!({
        "ok": true,
        "type": "subscribed",
        "device_terminals": snapshot
    });
    if socket.send(Message::Text(sub.to_string().into())).await.is_err() {
        return;
    }

    let mut rx = state.agent_hub_tx.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    None => break,
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(p))) => {
                        let _ = socket.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            push = rx.recv() => {
                match push {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg)).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
        }
    }
}

async fn hedge_pairs_list(State(state): State<AppState>) -> impl IntoResponse {
    let pairs = state.pairs.lock().unwrap().clone();
    let body = serde_json::json!({ "ok": true, "pairs": pairs });
    (StatusCode::OK, axum::body::Body::from(body.to_string()))
}

/// Called by hedge watchers when they detect one leg closed: close the other leg and remove the pair.
async fn hedge_close_orphan(
    State(state): State<AppState>,
    Json(body): Json<HedgeCloseOrphanRequest>,
) -> impl IntoResponse {
    let ticket = body.ticket;
    let account_id = body.account_id.as_str();
    let path = match get_path_for_account(&state, account_id) {
        Some(p) => p,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                axum::body::Body::from(
                    serde_json::json!({ "ok": false, "error": "Unknown account_id" }).to_string(),
                ),
            );
        }
    };

    // Do not close single-account (FixedLot) positions — check registered list first (does not rely on broker comment).
    {
        let list = state.single_account_tickets.lock().unwrap();
        if list.iter().any(|(t, a)| *t == ticket && *a == account_id) {
            let removed = {
                let mut pairs = state.pairs.lock().unwrap();
                let idx = pairs.iter().position(|p| {
                    (p.ticket_0 == ticket && p.account_0 == account_id)
                        || (p.ticket_1 == ticket && p.account_1 == account_id)
                });
                if let Some(i) = idx {
                    pairs.remove(i);
                    save_pairs(&state.pair_file, &*pairs);
                    true
                } else {
                    false
                }
            };
            log_to_file(&format!(
                "hedge_close_orphan: skipped close account={} ticket={} (registered single-account/fixedlot); pair_removed={}",
                account_id, ticket, removed
            ));
            return (
                StatusCode::OK,
                axum::body::Body::from(
                    serde_json::json!({
                        "ok": true,
                        "skipped": true,
                        "message": "Single-account (fixedlot) position; not closed."
                    })
                    .to_string(),
                ),
            );
        }
    }

    // Do not close single-account (FixedLot) positions even if they appear in a pair (data inconsistency).
    let path_for_comment = path.clone();
    let comment = tokio::task::spawn_blocking(move || get_position_comment(&path_for_comment, ticket))
        .await
        .unwrap_or_default();
    if comment.to_lowercase().contains(FIXEDLOT_COMMENT) {
        let removed = {
            let mut pairs = state.pairs.lock().unwrap();
            let idx = pairs.iter().position(|p| {
                (p.ticket_0 == ticket && p.account_0 == account_id)
                    || (p.ticket_1 == ticket && p.account_1 == account_id)
            });
            if let Some(i) = idx {
                pairs.remove(i);
                save_pairs(&state.pair_file, &*pairs);
                true
            } else {
                false
            }
        };
        log_to_file(&format!(
            "hedge_close_orphan: skipped close account={} ticket={} (fixedlot); pair_removed={}",
            account_id, ticket, removed
        ));
        return (
            StatusCode::OK,
            axum::body::Body::from(
                serde_json::json!({
                    "ok": true,
                    "skipped": true,
                    "message": "Single-account (fixedlot) position; not closed."
                })
                .to_string(),
            ),
        );
    }

    let removed = {
        let mut pairs = state.pairs.lock().unwrap();
        let idx = pairs.iter().position(|p| {
            (p.ticket_0 == ticket && p.account_0 == account_id)
                || (p.ticket_1 == ticket && p.account_1 == account_id)
        });
        if let Some(i) = idx {
            pairs.remove(i);
            save_pairs(&state.pair_file, &*pairs);
            true
        } else {
            false
        }
    };

    if !removed {
        return (
            StatusCode::NOT_FOUND,
            axum::body::Body::from(
                serde_json::json!({ "ok": false, "error": "Pair not found for this ticket" }).to_string(),
            ),
        );
    }

    log_to_file(&format!(
        "hedge_close_orphan: closing ticket {} on {} (requested by watcher)",
        ticket, account_id
    ));

    // Prefer watcher in-process close (ms); fallback to Python bridge if watcher unreachable
    let watcher_close_url = get_watcher_close_url(&state, account_id);
    let mut close_ok = false;
    let mut used_watcher = false;
    if !watcher_close_url.is_empty() {
        if let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
        {
            let body = serde_json::json!({ "ticket": ticket });
            let res = client.post(&watcher_close_url).json(&body).send().await;
            if let Ok(r) = res {
                if r.status().is_success() {
                    if let Ok(j) = r.json::<serde_json::Value>().await {
                        close_ok = j.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                        used_watcher = close_ok;
                    }
                }
            }
        }
        if !close_ok {
            log_to_file(&format!(
                "hedge_close_orphan: watcher unreachable for {}, using Python bridge",
                account_id
            ));
            let path_clone = path.clone();
            let close_body = format!("{{\"ticket\":{}}}", ticket);
            close_ok = tokio::task::spawn_blocking(move || {
                call_python_bridge("close_position", &close_body, &path_clone).is_ok()
            })
            .await
            .unwrap_or(false);
        }
    } else {
        let path_clone = path;
        let close_body = format!("{{\"ticket\":{}}}", ticket);
        close_ok = tokio::task::spawn_blocking(move || {
            call_python_bridge("close_position", &close_body, &path_clone).is_ok()
        })
        .await
        .unwrap_or(false);
    }

    log_to_file(&format!(
        "hedge_close_orphan result account={} ticket={} close_ok={} via={}",
        account_id,
        ticket,
        close_ok,
        if used_watcher { "watcher" } else { "bridge" }
    ));

    (
        StatusCode::OK,
        axum::body::Body::from(
            serde_json::json!({
                "ok": true,
                "message": "Orphan closed",
                "close_ok": close_ok
            })
            .to_string(),
        ),
    )
}

async fn close_both_bot_get(State(state): State<AppState>) -> impl IntoResponse {
    let enabled = load_close_both_bot(&state.close_both_bot_file);
    (
        StatusCode::OK,
        axum::body::Body::from(
            serde_json::json!({ "ok": true, "enabled": enabled }).to_string(),
        ),
    )
}

#[derive(Deserialize)]
struct CloseBothBotSetRequest {
    enabled: bool,
}

async fn close_both_bot_set(
    State(state): State<AppState>,
    Json(body): Json<CloseBothBotSetRequest>,
) -> impl IntoResponse {
    save_close_both_bot(&state.close_both_bot_file, body.enabled);
    (
        StatusCode::OK,
        axum::body::Body::from(
            serde_json::json!({ "ok": true, "enabled": body.enabled }).to_string(),
        ),
    )
}

/// Close a pair on both accounts at the same time (parallel). Removes the pair then closes both legs.
async fn hedge_close_pair(
    State(state): State<AppState>,
    Json(body): Json<HedgeClosePairRequest>,
) -> impl IntoResponse {
    let pair_opt = {
        let mut pairs = state.pairs.lock().unwrap();
        if body.index >= pairs.len() {
            None
        } else {
            Some(pairs.remove(body.index))
        }
    };
    let Some(pair) = pair_opt else {
        return (
            StatusCode::NOT_FOUND,
            axum::body::Body::from(
                serde_json::json!({ "ok": false, "error": "Pair not found or invalid index" }).to_string(),
            ),
        );
    };
    save_pairs(&state.pair_file, &*state.pairs.lock().unwrap());

    log_to_file(&format!(
        "hedge_close_pair: closing both legs ticket_0={} on {} and ticket_1={} on {}",
        pair.ticket_0, pair.account_0, pair.ticket_1, pair.account_1
    ));

    let (close_0, close_1) = tokio::join!(
        close_one_position(&state, pair.ticket_0, &pair.account_0),
        close_one_position(&state, pair.ticket_1, &pair.account_1),
    );

    log_to_file(&format!(
        "hedge_close_pair result close_0={} close_1={}",
        close_0, close_1
    ));

    (
        StatusCode::OK,
        axum::body::Body::from(
            serde_json::json!({
                "ok": true,
                "message": "Pair closed on both accounts",
                "close_0": close_0,
                "close_1": close_1
            })
            .to_string(),
        ),
    )
}

/// Update panel SL/TP (pips) for one leg of a pair. Does not touch MT5.
async fn hedge_pair_update(
    State(state): State<AppState>,
    Json(body): Json<HedgePairUpdateRequest>,
) -> impl IntoResponse {
    let sl_pips = body.sl_pips.max(0.0);
    let tp_pips = body.tp_pips.max(0.0);
    let mut pairs = state.pairs.lock().unwrap();
    if body.index >= pairs.len() {
        return (
            StatusCode::NOT_FOUND,
            axum::body::Body::from(
                serde_json::json!({ "ok": false, "error": "Pair not found or invalid index" }).to_string(),
            ),
        );
    }
    let pair = &mut pairs[body.index];
    if body.leg == 0 {
        pair.sl_pips_0 = Some(sl_pips);
        pair.tp_pips_0 = Some(tp_pips);
    } else {
        pair.sl_pips_1 = Some(sl_pips);
        pair.tp_pips_1 = Some(tp_pips);
    }
    drop(pairs);
    save_pairs(&state.pair_file, &*state.pairs.lock().unwrap());
    (
        StatusCode::OK,
        axum::body::Body::from(
            serde_json::json!({ "ok": true, "message": "Panel SL/TP updated" }).to_string(),
        ),
    )
}

/// Close all tracked pairs: remove all from list, then close both legs for each pair.
async fn hedge_close_all_pairs(State(state): State<AppState>) -> impl IntoResponse {
    let pairs_to_close: Vec<PositionPair> = {
        let mut pairs = state.pairs.lock().unwrap();
        std::mem::take(&mut *pairs)
    };
    save_pairs(&state.pair_file, &*state.pairs.lock().unwrap());

    let n = pairs_to_close.len();
    if n == 0 {
        return (
            StatusCode::OK,
            axum::body::Body::from(
                serde_json::json!({ "ok": true, "message": "No pairs to close", "closed_count": 0 }).to_string(),
            ),
        );
    }

    log_to_file(&format!("hedge_close_all_pairs: closing {} pair(s)", n));

    let mut closed_ok = 0usize;
    for pair in &pairs_to_close {
        let (c0, c1) = tokio::join!(
            close_one_position(&state, pair.ticket_0, &pair.account_0),
            close_one_position(&state, pair.ticket_1, &pair.account_1),
        );
        if c0 && c1 {
            closed_ok += 1;
        }
    }

    log_to_file(&format!("hedge_close_all_pairs result: {} pair(s), {} closed both legs", n, closed_ok));

    (
        StatusCode::OK,
        axum::body::Body::from(
            serde_json::json!({
                "ok": true,
                "message": format!("Closed {} of {} pair(s) on both accounts", closed_ok, n),
                "closed_count": closed_ok,
                "total_count": n
            })
            .to_string(),
        ),
    )
}

fn resolve_account_id(state: &AppState, account_id: Option<String>) -> Result<String, String> {
    let id = account_id.unwrap_or_else(|| "default".to_string());
    if get_path_for_account(state, &id).is_some() {
        Ok(id)
    } else {
        let mut names: Vec<String> = FIXED_ACCOUNTS.iter().map(|(k, _)| (*k).to_string()).collect();
        names.extend(collect_clone_accounts().into_iter().map(|(i, _)| i));
        Err(format!("Unknown account_id: {}. Use one of: {}", id, names.join(", ")))
    }
}

async fn accounts_list(State(_state): State<AppState>) -> impl IntoResponse {
    let mut list: Vec<serde_json::Value> = FIXED_ACCOUNTS
        .iter()
        .map(|(id, label)| serde_json::json!({ "id": id, "label": label }))
        .collect();
    for (id, label) in collect_clone_accounts() {
        list.push(serde_json::json!({ "id": id, "label": label }));
    }
    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "accounts": list }).to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerConfigPatch {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    fixed_interval: Option<bool>,
    #[serde(default)]
    interval_minutes: Option<f64>,
    #[serde(default)]
    min_minutes: Option<f64>,
    #[serde(default)]
    max_minutes: Option<f64>,
    #[serde(default)]
    symbols: Option<Vec<String>>,
    #[serde(default)]
    min_volume: Option<f64>,
    #[serde(default)]
    max_volume: Option<f64>,
    #[serde(default)]
    place_mode: Option<String>,
    #[serde(default)]
    use_sl_tp: Option<bool>,
    #[serde(default)]
    sl_tp_pips: Option<std::collections::HashMap<String, SlTpPips>>,
    /// Reset run count to 0
    #[serde(default)]
    reset_run_count: Option<bool>,
    /// Clear failed positions list
    #[serde(default)]
    clear_failed_positions: Option<bool>,
    /// Reset balance (account1_buy, account1_sell to 0)
    #[serde(default)]
    reset_balance: Option<bool>,
    #[serde(default)]
    max_open_positions: Option<u32>,
}

/// Compute next run time from now (seconds since epoch). Returns ISO 8601 string.
fn worker_compute_next_run_at(now_secs: i64, config: &WorkerConfig) -> Option<String> {
    if !config.enabled || config.symbols.is_empty() {
        return None;
    }
    let delay_secs = if config.fixed_interval {
        (config.interval_minutes * 60.0).round().max(30.0) as i64
    } else {
        let min_s = (config.min_minutes * 60.0).round().max(30.0) as i64;
        let max_s = (config.max_minutes * 60.0).round().max(min_s as f64) as i64;
        if max_s <= min_s {
            min_s
        } else {
            rand::thread_rng().gen_range(min_s..=max_s)
        }
    };
    let next = now_secs + delay_secs;
    use chrono::TimeZone;
    let dt = chrono::Utc
        .timestamp_opt(next, 0)
        .single()
        .unwrap_or_else(|| chrono::Utc::now());
    Some(dt.to_rfc3339())
}

#[derive(Deserialize)]
struct ExnessConfigUpdate {
    #[serde(default)]
    exness_copy_count: Option<u32>,
}

async fn exness_config_get(State(state): State<AppState>) -> impl IntoResponse {
    let config = state.exness_config.lock().unwrap();
    let n = config.exness_copy_count.max(1);
    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "exness_copy_count": n }).to_string()))
}

async fn exness_config_patch(State(state): State<AppState>, Json(body): Json<ExnessConfigUpdate>) -> impl IntoResponse {
    let Some(n) = body.exness_copy_count else {
        let config = state.exness_config.lock().unwrap();
        let n = config.exness_copy_count.max(1);
        return (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "exness_copy_count": n }).to_string()));
    };
    if n < 1 {
        return (StatusCode::BAD_REQUEST, axum::body::Body::from(serde_json::json!({ "ok": false, "error": "exness_copy_count must be at least 1" }).to_string()));
    }
    let mut config = state.exness_config.lock().unwrap();
    config.exness_copy_count = n;
    if save_exness_config(&state.exness_config_file, &config).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, axum::body::Body::from(serde_json::json!({ "ok": false, "error": "Failed to save config" }).to_string()));
    }
    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "exness_copy_count": n }).to_string()))
}

/// Default Exness MT5 installation folder (contains `terminal64.exe`).
fn default_exness_install_dir() -> PathBuf {
    PathBuf::from(r"C:\Program Files\MetaTrader 5 EXNESS")
}

fn default_exness_clone_parent_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join("MT5_EXNESS_clones"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\MT5_EXNESS_clones"))
}

async fn exness_terminal_clone_defaults() -> impl IntoResponse {
    let source = default_exness_install_dir();
    let parent = default_exness_clone_parent_dir();
    let exe = source.join("terminal64.exe");
    let body = serde_json::json!({
        "ok": true,
        "default_source_dir": source.to_string_lossy(),
        "default_parent_dir": parent.to_string_lossy(),
        "default_exness_exe": exe.to_string_lossy(),
    });
    (StatusCode::OK, axum::body::Body::from(body.to_string()))
}

#[derive(Deserialize)]
struct ExnessTerminalCloneRequest {
    /// How many full-folder clones to create (1–50).
    count: u32,
    #[serde(default)]
    source_dir: Option<String>,
    /// Each clone is written to `parent_dir/EXNESS_clone_NNN`.
    #[serde(default)]
    parent_dir: Option<String>,
    /// Start `terminal64.exe` in each clone after copy (default true).
    #[serde(default = "default_launch_after_clone")]
    launch_after: bool,
}

fn default_launch_after_clone() -> bool {
    true
}

#[derive(Serialize)]
struct ExnessCloneItemResult {
    index: u32,
    destination_dir: String,
    copy_ok: bool,
    launch_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(windows)]
fn robocopy_clone_folder(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let out = Command::new("robocopy")
        .arg(src.as_os_str())
        .arg(dst.as_os_str())
        .args(["/E", "/COPY:DAT", "/R:2", "/W:1"])
        .output()
        .map_err(|e| format!("Could not run robocopy: {}", e))?;
    let code = out.status.code().unwrap_or(8);
    // Robocopy: exit codes 0–7 indicate success (with different meanings).
    if code >= 8 {
        return Err(format!(
            "robocopy failed (exit {}). {}",
            code,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn launch_exness_terminal(exe: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    let dir = exe.parent().ok_or_else(|| "Invalid terminal path".to_string())?;
    Command::new(exe)
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{}", e))?;
    Ok(())
}

#[cfg(windows)]
fn run_exness_clones_blocking(
    source: PathBuf,
    parent: PathBuf,
    count: u32,
    launch_after: bool,
) -> Result<Vec<ExnessCloneItemResult>, String> {
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    if !source.join("terminal64.exe").is_file() {
        return Err(format!(
            "terminal64.exe not found under: {}",
            source.display()
        ));
    }
    let mut items = Vec::new();
    for i in 1..=count {
        let dest = parent.join(format!("EXNESS_clone_{:03}", i));
        let mut row = ExnessCloneItemResult {
            index: i,
            destination_dir: dest.to_string_lossy().to_string(),
            copy_ok: false,
            launch_ok: false,
            error: None,
        };
        match robocopy_clone_folder(&source, &dest) {
            Ok(()) => row.copy_ok = true,
            Err(e) => {
                row.error = Some(e);
                items.push(row);
                continue;
            }
        }
        if launch_after {
            let exe = dest.join("terminal64.exe");
            if !exe.is_file() {
                row.error = Some("terminal64.exe missing after copy".to_string());
            } else {
                match launch_exness_terminal(&exe) {
                    Ok(()) => row.launch_ok = true,
                    Err(e) => row.error = Some(e),
                }
            }
        }
        items.push(row);
    }
    Ok(items)
}

async fn exness_terminal_clone(Json(body): Json<ExnessTerminalCloneRequest>) -> impl IntoResponse {
    #[cfg(not(windows))]
    {
        let _ = body;
        return (
            StatusCode::NOT_IMPLEMENTED,
            axum::body::Body::from(
                serde_json::json!({ "ok": false, "error": "Exness terminal clone is only supported on Windows" })
                    .to_string(),
            ),
        );
    }
    #[cfg(windows)]
    {
        if body.count < 1 || body.count > 50 {
            return (
                StatusCode::BAD_REQUEST,
                axum::body::Body::from(
                    serde_json::json!({ "ok": false, "error": "count must be between 1 and 50" }).to_string(),
                ),
            );
        }
        let source = body
            .source_dir
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_exness_install_dir);
        let parent = body
            .parent_dir
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_exness_clone_parent_dir);
        let count = body.count;
        let launch_after = body.launch_after;
        let res = tokio::task::spawn_blocking(move || {
            run_exness_clones_blocking(source, parent, count, launch_after)
        })
        .await;
        match res {
            Ok(Ok(items)) => (
                StatusCode::OK,
                axum::body::Body::from(
                    serde_json::json!({ "ok": true, "results": items }).to_string(),
                ),
            ),
            Ok(Err(e)) => (
                StatusCode::BAD_REQUEST,
                axum::body::Body::from(serde_json::json!({ "ok": false, "error": e }).to_string()),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::body::Body::from(
                    serde_json::json!({ "ok": false, "error": format!("task failed: {}", e) }).to_string(),
                ),
            ),
        }
    }
}

#[derive(Serialize)]
struct TerminalListItem {
    label: String,
    exe_path: String,
}

fn dedupe_and_sort_terminals(mut items: Vec<TerminalListItem>) -> Vec<TerminalListItem> {
    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    items.retain(|t| {
        let key = t.exe_path.to_lowercase();
        if seen.contains(&key) {
            false
        } else {
            seen.insert(key);
            true
        }
    });
    items.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    items
}

/// Find every `terminal64.exe` one level under well-known roots (Program Files, clone folder).
fn collect_terminal_installs() -> Vec<TerminalListItem> {
    let mut v = Vec::new();

    let program_roots = [
        PathBuf::from(r"C:\Program Files"),
        PathBuf::from(r"C:\Program Files (x86)"),
    ];
    for root in program_roots {
        if !root.is_dir() {
            continue;
        }
        let src_tag = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Program Files");
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut rows: Vec<_> = rd.flatten().collect();
        rows.sort_by_key(|e| e.path());
        for e in rows {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let exe = dir.join("terminal64.exe");
            if !exe.is_file() {
                continue;
            }
            let folder = dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("MetaTrader");
            v.push(TerminalListItem {
                label: format!("{} ({src_tag})", folder),
                exe_path: exe.to_string_lossy().into_owned(),
            });
        }
    }

    // Any subfolder under %USERPROFILE%\MT5_EXNESS_clones that contains terminal64.exe
    let parent = default_exness_clone_parent_dir();
    if let Ok(rd) = std::fs::read_dir(&parent) {
        let mut rows: Vec<_> = rd.flatten().collect();
        rows.sort_by_key(|e| e.path());
        for e in rows {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let exe = p.join("terminal64.exe");
            if !exe.is_file() {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("folder");
            v.push(TerminalListItem {
                label: format!("{} (MT5_EXNESS_clones)", name),
                exe_path: exe.to_string_lossy().into_owned(),
            });
        }
    }

    dedupe_and_sort_terminals(v)
}

async fn terminals_list() -> impl IntoResponse {
    let terminals = collect_terminal_installs();
    (
        StatusCode::OK,
        axum::body::Body::from(serde_json::json!({ "ok": true, "terminals": terminals }).to_string()),
    )
}

/// Lightweight scheduler: every 15s check if next_run_at is due; if so, POST /api/worker/run-once (no file I/O on hot path).
async fn worker_scheduler_loop(state: AppState) {
    use tokio::time::Duration;
    const TICK_SECS: u64 = 15;
    let client = reqwest::Client::new();
    loop {
        tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
        let should_run = {
            let config = state.worker_config.lock().unwrap();
            if !config.enabled || config.symbols.is_empty() {
                false
            } else {
                let now_secs = chrono::Utc::now().timestamp();
                config.next_run_at.as_ref().map_or(false, |s| {
                    chrono::DateTime::parse_from_rfc3339(s)
                        .ok()
                        .map(|dt| dt.timestamp() <= now_secs)
                        .unwrap_or(false)
                })
            }
        };
        if should_run {
            if let Err(e) = client
                .post(format!("{}/api/worker/run-once", api_local_base()))
                .send()
                .await
            {
                log_to_file(&format!("worker_scheduler_loop run-once failed: {}", e));
            }
        }
    }
}

async fn worker_config_get(State(state): State<AppState>) -> impl IntoResponse {
    let mut config = state.worker_config.lock().unwrap();
    if config.enabled && !config.symbols.is_empty() && config.next_run_at.is_none() {
        let now_secs = chrono::Utc::now().timestamp();
        config.next_run_at = worker_compute_next_run_at(now_secs, &config);
        let _ = save_worker_config(&state.worker_config_file, &config);
    }
    let json = serde_json::to_string(&*config).unwrap_or_else(|_| "{}".to_string());
    (StatusCode::OK, axum::body::Body::from(json))
}

async fn worker_config_patch(State(state): State<AppState>, Json(patch): Json<WorkerConfigPatch>) -> impl IntoResponse {
    let now_secs = chrono::Utc::now().timestamp();
    let mut config = state.worker_config.lock().unwrap();
    if let Some(v) = patch.enabled {
        config.enabled = v;
    }
    if let Some(v) = patch.fixed_interval {
        config.fixed_interval = v;
    }
    if let Some(v) = patch.interval_minutes {
        config.interval_minutes = v.max(0.5).min(1440.0);
    }
    if let Some(v) = patch.min_minutes {
        config.min_minutes = v.max(0.5).min(1440.0);
    }
    if let Some(v) = patch.max_minutes {
        config.max_minutes = v.max(1.0).min(1440.0);
    }
    if patch.symbols.is_some() {
        config.symbols = patch.symbols.unwrap_or_default();
    }
    if let Some(v) = patch.min_volume {
        config.min_volume = v.max(0.0001);
    }
    if let Some(v) = patch.max_volume {
        config.max_volume = v.max(0.0001);
    }
    if let Some(v) = patch.place_mode {
        config.place_mode = if v == "master_slave_hedge" { "master_slave_hedge".to_string() } else { "both".to_string() };
    }
    if let Some(v) = patch.use_sl_tp {
        config.use_sl_tp = v;
    }
    if let Some(v) = patch.sl_tp_pips {
        config.sl_tp_pips = v;
    }
    if let Some(v) = patch.max_open_positions {
        config.max_open_positions = v;
    }
    if patch.reset_run_count == Some(true) {
        config.run_count = 0;
    }
    if patch.clear_failed_positions == Some(true) {
        config.failed_positions.clear();
    }
    if patch.reset_balance == Some(true) {
        config.worker_balance = WorkerBalance::default();
    }
    if config.enabled && !config.symbols.is_empty() {
        config.next_run_at = worker_compute_next_run_at(now_secs, &config);
    } else {
        config.next_run_at = None;
    }
    if save_worker_config(&state.worker_config_file, &config).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, axum::body::Body::from(serde_json::json!({ "ok": false, "error": "Failed to save worker config" }).to_string()));
    }
    let json = serde_json::to_string(&*config).unwrap_or_else(|_| "{}".to_string());
    (StatusCode::OK, axum::body::Body::from(json))
}

async fn worker_run_once(State(state): State<AppState>) -> impl IntoResponse {
    {
        let config = state.worker_config.lock().unwrap();
        if !config.enabled || config.symbols.is_empty() {
            return (StatusCode::BAD_REQUEST, axum::body::Body::from(serde_json::json!({
                "ok": false,
                "error": "Worker is disabled or has no symbols"
            }).to_string()));
        }
    }
    // If max_open_positions is set, skip this run when current open count is at or above limit.
    let max_open = {
        let config = state.worker_config.lock().unwrap();
        config.max_open_positions
    };
    if max_open > 0 {
        let (id0, id1) = (ACCOUNT_LIST[0].0, ACCOUNT_LIST[1].0);
        let path0 = get_path_for_account(&state, id0).unwrap_or_default();
        let path1 = get_path_for_account(&state, id1).unwrap_or_default();
        let path0_c = path0.clone();
        let path1_c = path1.clone();
        let current_count: u32 = tokio::task::spawn_blocking(move || {
            let c0 = get_position_tickets(&path0_c).len() as u32;
            let c1 = get_position_tickets(&path1_c).len() as u32;
            c0 + c1
        })
        .await
        .unwrap_or(0);
        if current_count >= max_open {
            let now_secs = chrono::Utc::now().timestamp();
            let mut config = state.worker_config.lock().unwrap();
            config.next_run_at = worker_compute_next_run_at(now_secs, &config);
            let _ = save_worker_config(&state.worker_config_file, &config);
            return (
                StatusCode::OK,
                axum::body::Body::from(
                    serde_json::json!({
                        "ok": true,
                        "skipped": true,
                        "reason": "max_open_positions",
                        "current_count": current_count,
                        "max_open_positions": max_open
                    })
                    .to_string(),
                ),
            );
        }
    }
    let (url, body, update_balance, first_account_buy): (String, serde_json::Value, bool, Option<bool>) = {
        let mut config = state.worker_config.lock().unwrap();
        let syms: Vec<String> = config.symbols.iter().filter(|s| config.last_symbol.as_ref() != Some(*s)).cloned().collect();
        let pool = if syms.is_empty() { config.symbols.clone() } else { syms };
        let sym = pool[rand::thread_rng().gen_range(0..pool.len())].clone();
        config.last_symbol = Some(sym.clone());

        let (id0, id1) = (ACCOUNT_LIST[0].0, ACCOUNT_LIST[1].0);
        let default_pips_0 = SlTpPips { sl_pips: 10.0, tp_pips: 30.0 };
        let default_pips_1 = SlTpPips { sl_pips: 30.0, tp_pips: 10.0 };
        let pips0 = config.sl_tp_pips.get(id0).unwrap_or(&default_pips_0);
        let pips1 = config.sl_tp_pips.get(id1).unwrap_or(&default_pips_1);
        let sl_tp_pips = if config.use_sl_tp {
            let mut m = std::collections::HashMap::new();
            m.insert(id0.to_string(), pips0.clone());
            m.insert(id1.to_string(), pips1.clone());
            Some(m)
        } else {
            None
        };

        let min_v = config.min_volume.min(config.max_volume);
        let max_v = config.min_volume.max(config.max_volume);
        let vol = if config.place_mode == "master_slave_hedge" {
            let n = { state.exness_config.lock().unwrap().exness_copy_count.max(1) };
            let min_vol_hedge = (n as f64 * 0.01 * 100.0).ceil() / 100.0;
            let eff_min = min_v.max(min_vol_hedge);
            let eff_max = max_v.max(min_vol_hedge);
            let range = eff_max - eff_min;
            if range > 0.0 {
                (eff_min + rand::random::<f64>() * range).round() * 100.0 / 100.0
            } else {
                eff_min
            }.max(min_vol_hedge)
        } else {
            (min_v + rand::random::<f64>() * (max_v - min_v).max(0.0)).round() * 100.0 / 100.0
        }.max(0.01);

        let (url, body, update_balance, first_account_buy) = if config.place_mode == "master_slave_hedge" {
            let exness_buy = rand::thread_rng().gen_bool(0.5);
            let body = serde_json::json!({
                "symbol": sym,
                "order_type": if exness_buy { "buy" } else { "sell" },
                "volume": vol,
                "comment": ""
            });
            (
                format!("{}/api/positions/master-slave-hedge", api_local_base()),
                body,
                false,
                None,
            )
        } else {
            let total = config.worker_balance.account1_buy + config.worker_balance.account1_sell;
            let p_buy = if total == 0 { 0.5 } else { (config.worker_balance.account1_sell as f64 + 1.0) / (total as f64 + 2.0) };
            let first_buy = rand::random::<f64>() < p_buy;
            let body = serde_json::json!({
                "symbol": sym,
                "order_type": "buy",
                "volume": vol,
                "sl_tp_pips": sl_tp_pips,
                "first_account_buy": first_buy
            });
            (
                format!("{}/api/positions/both", api_local_base()),
                body,
                true,
                Some(first_buy),
            )
        };
        (url, body, update_balance, first_account_buy)
    };

    let client = reqwest::Client::new();
    let res = client.post(&url).json(&body).send().await;
    let (ok, one_sided_rollback, message, err_msg) = match res {
        Ok(r) => {
            let status = r.status();
            let data: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
            let ok = data.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let one_sided = data.get("one_sided_rollback").and_then(|v| v.as_bool()).unwrap_or(false);
            let msg = data.get("message").and_then(|m| m.as_str()).unwrap_or("");
            let err = data.get("error").and_then(|e| e.as_str()).unwrap_or("");
            (ok && status.is_success(), one_sided, msg.to_string(), err.to_string())
        }
        Err(e) => (false, false, String::new(), e.to_string()),
    };
    let placement_ok = ok && !one_sided_rollback;

    let now_iso = chrono::Utc::now().to_rfc3339();
    let sym = body.get("symbol").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let vol = body.get("volume").and_then(|v| v.as_f64()).unwrap_or(0.0);

    let mut config = state.worker_config.lock().unwrap();
    config.last_run_at = Some(now_iso.clone());
    if placement_ok {
        config.run_count += 1;
        if update_balance {
            if first_account_buy == Some(true) {
                config.worker_balance.account1_buy += 1;
            } else if first_account_buy == Some(false) {
                config.worker_balance.account1_sell += 1;
            }
        }
    } else {
        let msg = if !err_msg.is_empty() { err_msg } else { message };
        config.failed_positions.insert(0, WorkerFailedRecord {
            time: now_iso,
            symbol: sym.clone(),
            volume: vol,
            message: Some(if msg.is_empty() { "Order failed".to_string() } else { msg }),
        });
        while config.failed_positions.len() > 100 {
            config.failed_positions.pop();
        }
    }
    let now_secs = chrono::Utc::now().timestamp();
    config.next_run_at = worker_compute_next_run_at(now_secs, &config);
    let _ = save_worker_config(&state.worker_config_file, &config);

    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "next_run_at": config.next_run_at }).to_string()))
}

fn json_error(error: &str) -> axum::body::Body {
    axum::body::Body::from(
        serde_json::json!({ "ok": false, "error": error }).to_string(),
    )
}

fn json_message(message: &str) -> axum::body::Body {
    axum::body::Body::from(
        serde_json::json!({ "ok": false, "message": message }).to_string(),
    )
}

/// Parse "Bridge error: {...}" to get a clean message and optional hint for the UI.
fn parse_bridge_error(e: &str) -> (String, Option<String>) {
    let json_str = match e.strip_prefix("Bridge error: ") {
        Some(s) => s,
        None => return (e.to_string(), None),
    };
    let v: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return (e.to_string(), None),
    };
    let msg = v
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_else(|| v.get("error").and_then(|e| e.as_str()).unwrap_or(""));
    let hint = v.get("hint").and_then(|h| h.as_str()).filter(|s| !s.is_empty());
    let message = match hint {
        Some(h) => format!("{} — {}", msg, h),
        None => msg.to_string(),
    };
    (message, hint.map(String::from))
}

async fn symbols(State(state): State<AppState>, Query(q): Query<AccountQuery>) -> impl IntoResponse {
    let account_id = match resolve_account_id(&state, q.account_id) {
        Ok(id) => id,
        Err(e) => return (StatusCode::BAD_REQUEST, json_error(&e)),
    };
    let path = get_path_for_account(&state, &account_id).unwrap_or_default();
    match call_python_bridge("symbols", "{}", &path) {
        Ok(s) => (StatusCode::OK, axum::body::Body::from(s)),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, json_error(&e)),
    }
}

async fn positions(State(state): State<AppState>, Query(q): Query<AccountQuery>) -> impl IntoResponse {
    let account_id = match resolve_account_id(&state, q.account_id) {
        Ok(id) => id,
        Err(e) => return (StatusCode::BAD_REQUEST, json_error(&e)),
    };
    let path = get_path_for_account(&state, &account_id).unwrap_or_default();
    match call_python_bridge("positions", "{}", &path) {
        Ok(s) => (StatusCode::OK, axum::body::Body::from(s)),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, json_error(&e)),
    }
}

async fn positions_all(State(state): State<AppState>) -> impl IntoResponse {
    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut account_list: Vec<(String, String)> = FIXED_ACCOUNTS
        .iter()
        .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
        .collect();
    account_list.extend(collect_clone_accounts());
    for (id, label) in account_list {
        let path = get_path_for_account(&state, &id).unwrap_or_default();
        match call_python_bridge("positions", "{}", &path) {
            Ok(stdout) => {
                let (positions, bridge_err) = parse_positions_bridge_stdout(&stdout);
                let mut row = serde_json::json!({
                    "account_id": id,
                    "label": label,
                    "positions": positions
                });
                if let Some(e) = bridge_err {
                    row["bridge_error"] = serde_json::json!(e);
                }
                results.push(row);
            }
            Err(_) => {
                results.push(serde_json::json!({
                    "account_id": id,
                    "label": label,
                    "positions": []
                }));
            }
        }
    }
    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "results": results }).to_string()))
}

#[derive(Deserialize)]
struct RemotePositionsPeekBody {
    admin_key: String,
}

/// Same merged snapshot as `/ws/remote-positions` initial frame — for browsers (JWT or panel key via middleware).
async fn agent_remote_positions_snapshot_get(State(state): State<AppState>) -> impl IntoResponse {
    let raw = state.remote_positions.snapshot_json(&state.agent);
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => Json(v).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": "snapshot_serialize"})),
        )
            .into_response(),
    }
}

/// POST same auth as other agent admin routes — returns merged `/ws/remote-positions` snapshot JSON + cache size (debug).
async fn remote_positions_peek(
    State(state): State<AppState>,
    Json(body): Json<RemotePositionsPeekBody>,
) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"ok": false, "error": "unauthorized"})),
        )
            .into_response();
    }
    let raw = state.remote_positions.snapshot_json(&state.agent);
    let cache_devices = state.remote_positions.cache_device_count();
    let mut v = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(x) => x,
        Err(_) => serde_json::json!({"ok": false, "error": "snapshot parse"}),
    };
    if let Some(o) = v.as_object_mut() {
        o.insert("_debug_cached_device_entries".to_string(), serde_json::json!(cache_devices));
    }
    Json(v).into_response()
}

/// Close all open positions on both accounts at once (same milliseconds): one blocking task spawns all close processes then waits.
async fn positions_close_all(State(state): State<AppState>) -> impl IntoResponse {
    let (id0, _) = ACCOUNT_LIST[0];
    let (id1, _) = ACCOUNT_LIST[1];
    let ids = vec![id0.to_string(), id1.to_string()];
    close_positions_for_accounts(&state, ids, "both accounts").await
}

#[derive(Deserialize)]
struct CloseSelectedRequest {
    #[serde(default)]
    account_ids: Vec<String>,
}

/// Close all positions on selected account IDs (supports fixed accounts and clone:* accounts).
async fn positions_close_selected(
    State(state): State<AppState>,
    Json(body): Json<CloseSelectedRequest>,
) -> impl IntoResponse {
    if body.account_ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::body::Body::from(
                serde_json::json!({ "ok": false, "error": "account_ids is required" }).to_string(),
            ),
        );
    }
    close_positions_for_accounts(&state, body.account_ids, "selected accounts").await
}

async fn close_positions_for_accounts(
    state: &AppState,
    account_ids: Vec<String>,
    scope_label: &str,
) -> (StatusCode, axum::body::Body) {
    let mut ids: Vec<String> = Vec::new();
    for id in account_ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !ids.iter().any(|x| x == trimmed) {
            ids.push(trimmed.to_string());
        }
    }
    if ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::body::Body::from(
                serde_json::json!({ "ok": false, "error": "No valid account_ids provided" }).to_string(),
            ),
        );
    }

    let mut to_close: Vec<(u64, String)> = Vec::new();
    for id in &ids {
        let Some(path) = get_path_for_account(state, id) else {
            return (
                StatusCode::BAD_REQUEST,
                axum::body::Body::from(
                    serde_json::json!({ "ok": false, "error": format!("Unknown account_id: {}", id) })
                        .to_string(),
                ),
            );
        };
        let path_c = path.clone();
        let tickets: Vec<u64> = tokio::task::spawn_blocking(move || get_position_tickets(&path_c))
            .await
            .unwrap_or_default();
        for t in tickets {
            to_close.push((t, path.clone()));
        }
    }

    if to_close.is_empty() {
        let body = serde_json::json!({
            "ok": true,
            "closed_count": 0,
            "failed_count": 0,
            "message": "No open positions to close",
        });
        return (StatusCode::OK, axum::body::Body::from(body.to_string()));
    }

    let total = to_close.len();
    log_to_file(&format!(
        "positions_close_all({}): closing {} position(s) in parallel",
        scope_label, total
    ));

    let closed_count: usize = tokio::task::spawn_blocking(move || {
        let mut children: Vec<(Child, usize)> = Vec::with_capacity(to_close.len());
        for (ticket, path) in &to_close {
            let body = format!("{{\"ticket\":{}}}", ticket);
            match spawn_python_bridge("close_position", &body, path) {
                Ok(c) => children.push((c, body.len())),
                Err(e) => {
                    log_to_file(&format!(
                        "positions_close_all spawn failed ticket={} path_len={} err={}",
                        ticket,
                        path.len(),
                        e
                    ));
                }
            }
        }
        let mut ok_count = 0usize;
        for (child, body_len) in children {
            match wait_python_bridge_child(child, "close_position", body_len) {
                Ok(_) => ok_count += 1,
                Err(e) => log_to_file(&format!("positions_close_all wait failed: {}", e)),
            }
        }
        log_to_file(&format!(
            "positions_close_all result: {} ok, {} failed",
            ok_count,
            total.saturating_sub(ok_count)
        ));
        ok_count
    })
    .await
    .unwrap_or(0);

    let failed_count = total.saturating_sub(closed_count);
    let body = serde_json::json!({
        "ok": failed_count == 0,
        "closed_count": closed_count,
        "failed_count": failed_count,
        "total": total,
        "message": if failed_count == 0 {
            format!("Closed {} position(s) on {}", closed_count, scope_label)
        } else {
            format!("Closed {} of {} position(s); {} failed", closed_count, total, failed_count)
        },
    });
    (StatusCode::OK, axum::body::Body::from(body.to_string()))
}

async fn history_all(State(state): State<AppState>) -> impl IntoResponse {
    let body = serde_json::json!({ "days": 30 }).to_string();
    let mut results: Vec<serde_json::Value> = Vec::new();
    let account_list: Vec<(String, String)> = FIXED_ACCOUNTS.iter().map(|(a, b)| ((*a).to_string(), (*b).to_string())).collect();
    for (id, label) in account_list {
        let path = get_path_for_account(&state, &id).unwrap_or_default();
        match call_python_bridge("history_deals", &body, &path) {
            Ok(stdout) => {
                let deals: Vec<serde_json::Value> = serde_json::from_str(&stdout)
                    .ok()
                    .and_then(|v: serde_json::Value| v.get("deals").cloned())
                    .and_then(|d| d.as_array().cloned())
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "account_id": id,
                    "label": label,
                    "deals": deals
                }));
            }
            Err(_) => {
                results.push(serde_json::json!({
                    "account_id": id,
                    "label": label,
                    "deals": []
                }));
            }
        }
    }
    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "results": results }).to_string()))
}

/// Paired closed positions: same symbol+volume from both accounts, with close times and time difference.
async fn history_paired(State(state): State<AppState>) -> impl IntoResponse {
    let body = serde_json::json!({ "days": 30 }).to_string();
    let (id0, label0) = ACCOUNT_LIST[0];
    let (id1, label1) = ACCOUNT_LIST[1];
    let path0 = get_path_for_account(&state, id0).unwrap_or_default();
    let path1 = get_path_for_account(&state, id1).unwrap_or_default();

    let deals0: Vec<serde_json::Value> = match call_python_bridge("history_deals", &body, &path0) {
        Ok(stdout) => serde_json::from_str(&stdout)
            .ok()
            .and_then(|v: serde_json::Value| v.get("deals").cloned())
            .and_then(|d| d.as_array().cloned())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let deals1: Vec<serde_json::Value> = match call_python_bridge("history_deals", &body, &path1) {
        Ok(stdout) => serde_json::from_str(&stdout)
            .ok()
            .and_then(|v: serde_json::Value| v.get("deals").cloned())
            .and_then(|d| d.as_array().cloned())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    let mut used1 = vec![false; deals1.len()];
    let mut paired: Vec<serde_json::Value> = Vec::new();
    const MAX_DIFF_SEC: i64 = 600;

    for d0 in &deals0 {
        let sym0 = d0.get("symbol").and_then(|s| s.as_str()).unwrap_or("");
        let vol0 = d0.get("volume").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let time0 = d0.get("time").and_then(|t| t.as_i64()).unwrap_or(0);

        let mut best_j: Option<usize> = None;
        let mut best_diff: i64 = MAX_DIFF_SEC + 1;

        for (j, d1) in deals1.iter().enumerate() {
            if used1[j] {
                continue;
            }
            let sym1 = d1.get("symbol").and_then(|s| s.as_str()).unwrap_or("");
            let vol1 = d1.get("volume").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let time1 = d1.get("time").and_then(|t| t.as_i64()).unwrap_or(0);
            if sym0 != sym1 || (vol0 - vol1).abs() > 0.001 {
                continue;
            }
            let diff = (time0 - time1).abs();
            if diff <= MAX_DIFF_SEC && diff < best_diff {
                best_diff = diff;
                best_j = Some(j);
            }
        }

        if let Some(j) = best_j {
            used1[j] = true;
            let d1 = &deals1[j];
            let time1 = d1.get("time").and_then(|t| t.as_i64()).unwrap_or(0);
            let time_diff_sec = (time0 - time1).abs();
            paired.push(serde_json::json!({
                "symbol": sym0,
                "volume": vol0,
                "account_0": id0,
                "label_0": label0,
                "time_0": time0,
                "type_0": d0.get("type").and_then(|t| t.as_str()).unwrap_or(""),
                "profit_0": d0.get("profit").and_then(|p| p.as_f64()).unwrap_or(0.0),
                "ticket_0": d0.get("ticket"),
                "account_1": id1,
                "label_1": label1,
                "time_1": time1,
                "type_1": d1.get("type").and_then(|t| t.as_str()).unwrap_or(""),
                "profit_1": d1.get("profit").and_then(|p| p.as_f64()).unwrap_or(0.0),
                "ticket_1": d1.get("ticket"),
                "time_diff_sec": time_diff_sec
            }));
        }
    }

    paired.sort_by(|a, b| {
        let t_a = a.get("time_0").and_then(|t| t.as_i64()).unwrap_or(0).max(
            a.get("time_1").and_then(|t| t.as_i64()).unwrap_or(0),
        );
        let t_b = b.get("time_0").and_then(|t| t.as_i64()).unwrap_or(0).max(
            b.get("time_1").and_then(|t| t.as_i64()).unwrap_or(0),
        );
        t_b.cmp(&t_a)
    });

    (StatusCode::OK, axum::body::Body::from(serde_json::json!({ "ok": true, "pairs": paired }).to_string()))
}

async fn create_position(State(state): State<AppState>, Json(payload): Json<CreatePositionRequest>) -> impl IntoResponse {
    let account_id = match resolve_account_id(&state, payload.account_id.clone()) {
        Ok(id) => id,
        Err(e) => return (StatusCode::BAD_REQUEST, json_message(&e)),
    };
    let path = get_path_for_account(&state, &account_id).unwrap_or_default();
    let body = serde_json::to_string(&payload).unwrap_or_default();
    let is_single_account = payload.account_id.is_some();
    match call_python_bridge("create_position", &body, &path) {
        Ok(s) => {
            if is_single_account {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    let ticket = v
                        .get("order_ticket")
                        .or_else(|| v.get("position"))
                        .and_then(|t| t.as_u64());
                    if let Some(ticket) = ticket {
                        let mut list = state.single_account_tickets.lock().unwrap();
                        list.push((ticket, account_id.clone()));
                        save_single_account_tickets(&state.single_account_tickets_file, &list);
                        log_to_file(&format!(
                            "create_position: registered single-account ticket {} on {} (fixedlot); will not be closed by hedge logic",
                            ticket, account_id
                        ));
                    }
                }
            }
            (StatusCode::OK, axum::body::Body::from(s))
        }
        Err(e) => {
            let (message, hint) = parse_bridge_error(&e);
            let mut j = serde_json::json!({ "ok": false, "message": message });
            if let Some(h) = hint {
                j["hint"] = serde_json::json!(h);
            }
            (StatusCode::INTERNAL_SERVER_ERROR, axum::body::Body::from(j.to_string()))
        }
    }
}

#[derive(Clone, Serialize)]
struct BothResultItem {
    account_id: String,
    label: String,
    ok: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_ticket: Option<u64>,
}

async fn create_position_both(
    State(state): State<AppState>,
    Json(payload): Json<CreatePositionRequest>,
) -> impl IntoResponse {
    // Assign Buy/Sell: use first_account_buy if provided (for balanced random from worker), else random 50/50
    let first_buy = payload.first_account_buy.unwrap_or_else(|| rand::thread_rng().gen_bool(0.5));
    let (dir_first, dir_second) = if first_buy { ("buy", "sell") } else { ("sell", "buy") };

    let (id0, label0) = ACCOUNT_LIST[0];
    let (id1, label1) = ACCOUNT_LIST[1];

    // Default SL/TP pips: first account (Exness) 3:1 = SL 10 TP 30, second (IC Markets) 1:3 = SL 30 TP 10
    let default_pips_0 = SlTpPips { sl_pips: 10.0, tp_pips: 30.0 };
    let default_pips_1 = SlTpPips { sl_pips: 30.0, tp_pips: 10.0 };
    let pips0 = payload.sl_tp_pips.as_ref().and_then(|m| m.get(id0)).unwrap_or(&default_pips_0);
    let pips1 = payload.sl_tp_pips.as_ref().and_then(|m| m.get(id1)).unwrap_or(&default_pips_1);

    // Panel SL/TP: we do not set SL/TP in MT5; send 0 so positions open without stops. We store pips in the pair for the panel to monitor and close both when hit.
    let body0 = serde_json::json!({
        "symbol": payload.symbol,
        "order_type": dir_first,
        "volume": payload.volume,
        "sl_pips": 0,
        "tp_pips": 0,
        "comment": payload.comment.as_deref().unwrap_or("")
    });
    let body1 = serde_json::json!({
        "symbol": payload.symbol,
        "order_type": dir_second,
        "volume": payload.volume,
        "sl_pips": 0,
        "tp_pips": 0,
        "comment": payload.comment.as_deref().unwrap_or("")
    });
    let path0 = get_path_for_account(&state, id0).unwrap_or_default();
    let path1 = get_path_for_account(&state, id1).unwrap_or_default();
    let body0_str = body0.to_string();
    let body1_str = body1.to_string();

    log_to_file(&format!(
        "create_position_both request symbol={} volume={} first_account_buy={:?} sl_tp_pips={:?}",
        payload.symbol,
        payload.volume,
        payload.first_account_buy,
        payload.sl_tp_pips.as_ref().map(|m| {
            m.iter()
                .map(|(k, v)| format!("{}:sl{}tp{}", k, v.sl_pips, v.tp_pips))
                .collect::<Vec<_>>()
                .join(", ")
        })
    ));
    log_to_file(&format!("create_position_both body0 ({}): {}", id0, body0_str));
    log_to_file(&format!("create_position_both body1 ({}): {}", id1, body1_str));

    // Single blocking task: start both Python processes in quick succession, then wait for both.
    // This removes the ~200–350 ms delay from the second leg (Tokio blocking pool).
    let task = tokio::task::spawn_blocking(move || {
        log_timing("create_position_both SINGLE_BLOCKING_TASK_STARTED");
        let child0 = match spawn_python_bridge("create_position", &body0_str, &path0) {
            Ok(c) => {
                log_timing(&format!("create_position_both leg0 ({}) PROCESS_SPAWNED", id0));
                c
            }
            Err(e) => {
                log_timing("create_position_both leg0 spawn failed");
                return (Err(e), Err("spawn leg0 failed".to_string()));
            }
        };
        let child1 = match spawn_python_bridge("create_position", &body1_str, &path1) {
            Ok(c) => {
                log_timing(&format!("create_position_both leg1 ({}) PROCESS_SPAWNED", id1));
                c
            }
            Err(e) => {
                log_timing("create_position_both leg1 spawn failed; waiting for leg0");
                let r0 = wait_python_bridge_child(child0, "create_position", body0_str.len());
                return (r0, Err(e));
            }
        };
        let r0 = wait_python_bridge_child(child0, "create_position", body0_str.len());
        let r1 = wait_python_bridge_child(child1, "create_position", body1_str.len());
        log_timing("create_position_both SINGLE_BLOCKING_TASK_FINISHED");
        (r0, r1)
    });

    let (r0, r1) = task.await.unwrap_or_else(|_| (Err("task join failed".to_string()), Err("task join failed".to_string())));

    let parse_result = |stdout: Result<String, String>, id: &str, label: &str, order_type: &str| {
        match stdout {
            Ok(s) => {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap_or(serde_json::json!({ "ok": false, "message": "Invalid response" }));
                let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or_else(|| v.get("error").and_then(|e| e.as_str()).unwrap_or(""));
                BothResultItem {
                    account_id: id.to_string(),
                    label: format!("{} ({})", label, order_type.to_uppercase()),
                    ok: v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false),
                    message: msg.to_string(),
                    order_ticket: v.get("order_ticket").and_then(|t| t.as_u64()),
                }
            }
            Err(e) => {
                let (message, _) = parse_bridge_error(&e);
                BothResultItem {
                    account_id: id.to_string(),
                    label: format!("{} ({})", label, order_type.to_uppercase()),
                    ok: false,
                    message,
                    order_ticket: None,
                }
            }
        }
    };

    let res0 = r0;
    let res1 = r1;

    log_to_file(&format!(
        "create_position_both bridge result0: {}",
        res0.as_ref()
            .map(|s| if s.len() > 400 { format!("{}...", &s[..400]) } else { s.clone() })
            .unwrap_or_else(|e| format!("Err: {}", e))
    ));
    log_to_file(&format!(
        "create_position_both bridge result1: {}",
        res1.as_ref()
            .map(|s| if s.len() > 400 { format!("{}...", &s[..400]) } else { s.clone() })
            .unwrap_or_else(|e| format!("Err: {}", e))
    ));

    let results = vec![
        parse_result(res0, id0, label0, dir_first),
        parse_result(res1, id1, label1, dir_second),
    ];

    let any_ok = results.iter().any(|r| r.ok);
    let all_ok = results.iter().all(|r| r.ok);

    // Atomic "both or none": if one succeeded and one failed, close the opened position and return failure
    if any_ok && !all_ok {
        log_to_file("create_position_both ROLLBACK: one side succeeded and one failed; closing position on successful side to avoid unhedged exposure.");
        let path0_rb = get_path_for_account(&state, id0).unwrap_or_default();
        let path1_rb = get_path_for_account(&state, id1).unwrap_or_default();
        for (i, r) in results.iter().enumerate() {
            if r.ok {
                if let Some(ticket) = r.order_ticket {
                    let account_id = if i == 0 { id0 } else { id1 };
                    let path = if i == 0 { path0_rb.as_str() } else { path1_rb.as_str() };
                    let close_body = format!("{{\"ticket\":{}}}", ticket);
                    log_to_file(&format!("create_position_both rollback: closing ticket {} on account {}", ticket, account_id));
                    let close_result = call_python_bridge("close_position", &close_body, path);
                    log_to_file(&format!(
                        "create_position_both rollback close_position account={} ticket={} result={}",
                        account_id,
                        ticket,
                        close_result.as_ref().map(|s| s.as_str()).unwrap_or_else(|e| e)
                    ));
                }
            }
        }
        let resp = serde_json::json!({
            "ok": false,
            "one_sided_rollback": true,
            "message": "Order opened on one account but failed on the other; the opened position was closed to avoid unhedged exposure.",
            "results": results
        });
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::body::Body::from(resp.to_string()),
        );
    }

    if all_ok {
        let t0 = results[0].order_ticket;
        let t1 = results[1].order_ticket;
        if let (Some(ticket_0), Some(ticket_1)) = (t0, t1) {
            let pair = PositionPair {
                ticket_0,
                account_0: id0.to_string(),
                ticket_1,
                account_1: id1.to_string(),
                symbol: payload.symbol.clone(),
                created_at: Local::now().to_rfc3339(),
                type_0: Some(dir_first.to_string()),
                type_1: Some(dir_second.to_string()),
                sl_pips_0: Some(pips0.sl_pips),
                tp_pips_0: Some(pips0.tp_pips),
                sl_pips_1: Some(pips1.sl_pips),
                tp_pips_1: Some(pips1.tp_pips),
            };
            {
                let mut pairs = state.pairs.lock().unwrap();
                pairs.push(pair.clone());
                save_pairs(&state.pair_file, &*pairs);
            }
            log_to_file(&format!(
                "create_position_both: stored pair {} ticket_0={} ticket_1={} panel_sl_tp: leg0 sl={} tp={} leg1 sl={} tp={} (when price hits any, close both)",
                pair.symbol, pair.ticket_0, pair.ticket_1,
                pips0.sl_pips, pips0.tp_pips, pips1.sl_pips, pips1.tp_pips
            ));
        }
    }

    let status = if any_ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR };
    let resp = serde_json::json!({ "ok": any_ok, "results": results });
    (status, axum::body::Body::from(resp.to_string()))
}

/// Exness copy hedge: Broker B = full volume V, Exness (single account) = V/N. Only 2 legs.
async fn create_position_master_slave_hedge(
    State(state): State<AppState>,
    Json(payload): Json<CreatePositionRequest>,
) -> impl IntoResponse {
    let order_type_lower = payload.order_type.to_lowercase();
    let (exness_dir, broker_b_dir) = if order_type_lower == "buy" {
        ("buy", "sell")
    } else {
        ("sell", "buy")
    };

    let id_broker_b = "default";
    let id_exness = "exness";
    let label_broker_b = "MT5 (Default)";
    let label_exness = "MT5 - EXNESS";

    let n = {
        let config = state.exness_config.lock().unwrap();
        config.exness_copy_count.max(1)
    };
    let n_f64 = n as f64;

    // Normalize to multiple of N×0.01 using integer arithmetic (no float rounding issues).
    // step_cents = N (so step in lots = 0.01 * N, e.g. N=10 -> 0.10 lots).
    let step_cents = n.max(1) as u32;
    let volume_cents = (payload.volume * 100.0).round().max(0.0) as u32;
    let normalized_cents = if step_cents > 0 {
        ((volume_cents + step_cents / 2) / step_cents) * step_cents
    } else {
        volume_cents
    };
    let normalized_cents = normalized_cents.max(step_cents);
    let broker_b_volume = normalized_cents as f64 / 100.0;
    let exness_cents = normalized_cents / step_cents;
    let exness_volume = exness_cents as f64 / 100.0;

    if broker_b_volume < 0.01 {
        return (StatusCode::BAD_REQUEST, axum::body::Body::from(serde_json::json!({
            "ok": false,
            "error": "Broker B volume must be at least 0.01 lots"
        }).to_string()));
    }

    if exness_volume < 0.01 {
        return (StatusCode::BAD_REQUEST, axum::body::Body::from(serde_json::json!({
            "ok": false,
            "error": "Exness volume would be less than 0.01 lots; increase Broker B volume or decrease N (Exness copy count)"
        }).to_string()));
    }

    let body_exness = serde_json::json!({
        "symbol": payload.symbol,
        "order_type": exness_dir,
        "volume": exness_volume,
        "sl_pips": 0,
        "tp_pips": 0,
        "comment": payload.comment.as_deref().unwrap_or("")
    });
    let body_broker_b = serde_json::json!({
        "symbol": payload.symbol,
        "order_type": broker_b_dir,
        "volume": broker_b_volume,
        "sl_pips": 0,
        "tp_pips": 0,
        "comment": payload.comment.as_deref().unwrap_or("")
    });

    let path_b = get_path_for_account(&state, id_broker_b).unwrap_or_default();
    let path_e = get_path_for_account(&state, id_exness).unwrap_or_default();

    let legs: Vec<(String, String, String, String)> = vec![
        (id_broker_b.to_string(), label_broker_b.to_string(), path_b.clone(), body_broker_b.to_string()),
        (id_exness.to_string(), label_exness.to_string(), path_e.clone(), body_exness.to_string()),
    ];

    log_to_file(&format!(
        "create_position_master_slave_hedge symbol={} broker_b_volume={} exness_volume={} n={} exness_dir={} broker_b_dir={}",
        payload.symbol, broker_b_volume, exness_volume, n_f64, exness_dir, broker_b_dir
    ));

    let mut handles = Vec::with_capacity(legs.len());
    for (_, _, path, body_str) in &legs {
        let path = path.clone();
        let body_str = body_str.clone();
        handles.push(tokio::task::spawn_blocking(move || call_python_bridge("create_position", &body_str, &path)));
    }
    let mut outcomes = Vec::with_capacity(handles.len());
    for h in handles {
        outcomes.push(h.await);
    }

    let parse = |r: &Result<Result<String, String>, _>, id: &str, label: &str, dir: &str| {
        let stdout: Result<String, String> = match r {
            Ok(inner) => inner.clone(),
            Err(_) => Err("task join failed".to_string()),
        };
        match stdout {
            Ok(s) => {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap_or(serde_json::json!({ "ok": false }));
                let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or_else(|| v.get("error").and_then(|e| e.as_str()).unwrap_or(""));
                BothResultItem {
                    account_id: id.to_string(),
                    label: format!("{} ({})", label, dir.to_uppercase()),
                    ok: v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false),
                    message: msg.to_string(),
                    order_ticket: v.get("order_ticket").and_then(|t| t.as_u64()),
                }
            }
            Err(e) => {
                let (message, _) = parse_bridge_error(&e);
                BothResultItem {
                    account_id: id.to_string(),
                    label: format!("{} ({})", label, dir.to_uppercase()),
                    ok: false,
                    message,
                    order_ticket: None,
                }
            }
        }
    };

    let results: Vec<BothResultItem> = legs
        .iter()
        .zip(outcomes.iter())
        .enumerate()
        .map(|(i, ((id, label, _, _), r))| {
            let dir = if i == 0 { broker_b_dir } else { exness_dir };
            parse(r, id, label, dir)
        })
        .collect();

    let any_ok = results.iter().any(|r| r.ok);
    let all_ok = results.iter().all(|r| r.ok);

    if any_ok && !all_ok {
        log_to_file("create_position_master_slave_hedge ROLLBACK: one or more failed; closing any that opened.");
        for (i, r) in results.iter().enumerate() {
            if r.ok {
                if let (Some(path), Some(ticket)) = (legs.get(i).map(|l| &l.2), r.order_ticket) {
                    let close_body = format!("{{\"ticket\":{}}}", ticket);
                    let _ = call_python_bridge("close_position", &close_body, path);
                }
            }
        }
        let resp = serde_json::json!({
            "ok": false,
            "one_sided_rollback": true,
            "message": "One or more accounts failed; opened positions were closed to avoid imbalance.",
            "results": results
        });
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::body::Body::from(resp.to_string()),
        );
    }

    let status = if any_ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR };
    let resp = serde_json::json!({ "ok": all_ok, "results": results });
    (status, axum::body::Body::from(resp.to_string()))
}

/// Spawn Python bridge process (stdin written, process running). Caller must wait via wait_python_bridge_child.
fn spawn_python_bridge(action: &str, json_body: &str, terminal_path: &str) -> Result<Child, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let script_path = cwd
        .join("python_bridge")
        .join("mt5_bridge.py")
        .canonicalize()
        .or_else(|_| cwd.join("..").join("python_bridge").join("mt5_bridge.py").canonicalize())
        .map_err(|_| "mt5_bridge.py not found (run from project root: c:\\xampp\\htdocs\\bot3)".to_string())?;

    let project_root = script_path
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "Invalid script path".to_string())?;

    let python = std::env::var("PYTHON_CMD")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if Command::new("python").arg("--version").output().is_ok() {
                Some("python".into())
            } else if Command::new("py").arg("-3").arg("--version").output().is_ok() {
                Some("py".into())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "python".to_string());

    let mut cmd = Command::new(&python);
    if python == "py" {
        cmd.arg("-3");
    }
    cmd.arg(&script_path)
        .arg(action)
        .current_dir(project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !terminal_path.is_empty() {
        cmd.env("MT5_TERMINAL_PATH", terminal_path);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run Python (tried '{}'). Is Python on PATH? {}", python, e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(json_body.as_bytes())
            .map_err(|e| format!("Stdin write failed: {}", e))?;
    }

    Ok(child)
}

/// Wait for a bridge child process and return stdout or error (same semantics as call_python_bridge).
fn wait_python_bridge_child_with_timeout(
    mut child: Child,
    action: &str,
    body_len: usize,
    timeout_ms: u64,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if started.elapsed() >= std::time::Duration::from_millis(timeout_ms) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Bridge timeout after {} ms (action={})",
                        timeout_ms, action
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(format!("Python bridge execution failed: {}", e)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Python bridge execution failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    log_to_file(&format!(
        "bridge action={} body_len={} status={} stdout_len={} stdout_preview={}",
        action,
        body_len,
        output.status,
        stdout.len(),
        if stdout.len() > 350 {
            format!("{}...", stdout.as_ref().get(..350).unwrap_or(""))
        } else {
            stdout.to_string()
        }
    ));
    if !stderr.is_empty() {
        log_to_file(&format!("bridge stderr: {}", stderr.as_ref().get(..500).unwrap_or(stderr.as_ref())));
    }

    if !output.status.success() {
        return Err(format!("Bridge error: {}", if stderr.is_empty() { stdout.as_ref() } else { &stderr }));
    }

    Ok(stdout.to_string())
}

fn wait_python_bridge_child(child: Child, action: &str, body_len: usize) -> Result<String, String> {
    wait_python_bridge_child_with_timeout(child, action, body_len, 30000)
}

fn call_python_bridge(action: &str, json_body: &str, terminal_path: &str) -> Result<String, String> {
    let child = spawn_python_bridge(action, json_body, terminal_path)?;
    wait_python_bridge_child_with_timeout(child, action, json_body.len(), 30000)
}

fn call_python_bridge_with_timeout(
    action: &str,
    json_body: &str,
    terminal_path: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    let child = spawn_python_bridge(action, json_body, terminal_path)?;
    wait_python_bridge_child_with_timeout(child, action, json_body.len(), timeout_ms)
}
