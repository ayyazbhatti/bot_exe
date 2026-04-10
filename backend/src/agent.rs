use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::AppState;

fn agent_token_pepper() -> String {
    std::env::var("AGENT_TOKEN_PEPPER").unwrap_or_default()
}

/// Stored form: `h1:` + hex(SHA256(pepper || plaintext)). Legacy installs may still hold the raw uuid token string.
fn hash_agent_token(plaintext: &str) -> String {
    let pepper = agent_token_pepper();
    let mut hasher = Sha256::new();
    hasher.update(pepper.as_bytes());
    hasher.update(plaintext.as_bytes());
    format!("h1:{}", hex::encode(hasher.finalize()))
}

fn token_matches_stored(stored: &str, presented: &str) -> bool {
    if stored.starts_with("h1:") {
        let expected_hex = &stored[3..];
        let computed = hash_agent_token(presented);
        let got_hex = &computed[3..];
        if expected_hex.len() != got_hex.len() {
            return false;
        }
        let Ok(a) = hex::decode(expected_hex) else {
            return false;
        };
        let Ok(b) = hex::decode(got_hex) else {
            return false;
        };
        if a.len() != b.len() {
            return false;
        }
        a.ct_eq(&b).into()
    } else if stored.len() == presented.len() {
        stored.as_bytes().ct_eq(presented.as_bytes()).into()
    } else {
        false
    }
}

/// One MT5 terminal mapping (account_id → terminal64.exe), pushed by the remote agent over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInventoryEntry {
    pub id: String,
    pub label: String,
    pub exe_path: String,
}

/// Cap per paired device: `terminal_inventory` WebSocket payload and matching positions snapshot rows.
pub const MAX_REMOTE_DEVICE_TERMINALS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AgentStateFile {
    devices: HashMap<String, DeviceRecord>,
    pairing_codes: HashMap<String, PairingCodeRecord>,
    commands: Vec<CommandRecord>,
    #[serde(default)]
    worker_configs: HashMap<String, RemoteWorkerConfig>,
    /// Per device: MT5 terminals the agent reported (WebSocket sync for admin UI).
    #[serde(default)]
    terminal_inventories: HashMap<String, Vec<TerminalInventoryEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceRecord {
    token: String,
    label: String,
    #[serde(default)]
    last_heartbeat_unix: i64,
    #[serde(default)]
    last_agent_version: String,
    #[serde(default)]
    last_mt5_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PairingCodeRecord {
    expires_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRecord {
    pub id: String,
    pub device_id: String,
    #[serde(rename = "type")]
    pub cmd_type: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub created_unix: i64,
    pub expires_unix: i64,
    #[serde(default)]
    pub started_unix: i64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteWorkerConfig {
    enabled: bool,
    account_ids: Vec<String>,
    symbols: Vec<String>,
    min_volume: f64,
    max_volume: f64,
    min_interval_minutes: f64,
    max_interval_minutes: f64,
    max_open_positions: u32,
    /// Optional SL distance in pips for each worker-opened position (panel → agent → bridge).
    #[serde(default)]
    sl_pips: Option<f64>,
    /// Optional TP distance in pips.
    #[serde(default)]
    tp_pips: Option<f64>,
    /// If set, `fixed_lot_tick` skips opening when live spread (pips) on the agent exceeds this (checked on device MT5).
    #[serde(default)]
    max_spread_pips: Option<f64>,
    #[serde(default)]
    next_run_unix: i64,
    #[serde(default)]
    last_direction: Option<String>,
}

impl Default for RemoteWorkerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            account_ids: vec!["default".to_string()],
            symbols: vec![],
            min_volume: 0.01,
            max_volume: 0.10,
            min_interval_minutes: 5.0,
            max_interval_minutes: 10.0,
            max_open_positions: 0,
            sl_pips: None,
            tp_pips: None,
            max_spread_pips: None,
            next_run_unix: 0,
            last_direction: None,
        }
    }
}

pub struct AgentStore {
    path: PathBuf,
    file: AgentStateFile,
}

impl AgentStore {
    pub fn load(path: PathBuf) -> Self {
        let file = if let Ok(data) = std::fs::read_to_string(&path) {
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            AgentStateFile::default()
        };
        Self { path, file }
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.file)?;
        std::fs::write(&self.path, data)
    }

    pub fn create_pairing_code(&mut self, ttl_sec: u64) -> (String, i64) {
        let now = chrono::Utc::now().timestamp();
        let expires = now + ttl_sec as i64;
        let code: String = {
            const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            let mut rng = rand::thread_rng();
            (0..8)
                .map(|_| {
                    let idx = rng.gen_range(0..CHARSET.len());
                    CHARSET[idx] as char
                })
                .collect()
        };
        self.file
            .pairing_codes
            .insert(code.clone(), PairingCodeRecord { expires_unix: expires });
        let _ = self.save();
        (code, expires)
    }

    pub fn register_device(&mut self, code: &str, label: &str) -> Result<(String, String), String> {
        // Normalize so mobile copy/paste and lowercase entry still match server-generated codes.
        let code_key: String = code
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_ascii_uppercase();
        if code_key.is_empty() {
            return Err("missing pairing code".to_string());
        }
        const PAIRING_CODE_LEN: usize = 8;
        if code_key.len() != PAIRING_CODE_LEN {
            return Err(format!(
                "pairing code must be exactly {} characters (yours has {}). Copy from the panel — do not type by hand.",
                PAIRING_CODE_LEN,
                code_key.len()
            ));
        }
        let now = chrono::Utc::now().timestamp();
        let rec = self
            .file
            .pairing_codes
            .get(&code_key)
            .ok_or_else(|| "invalid or expired pairing code (generate a new code on Remote devices)".to_string())?;
        if rec.expires_unix < now {
            self.file.pairing_codes.remove(&code_key);
            let _ = self.save();
            return Err("pairing code expired — click New pairing code again".to_string());
        }
        self.file.pairing_codes.remove(&code_key);
        let device_id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().simple().to_string();
        let token_stored = hash_agent_token(&token);
        self.file.devices.insert(
            device_id.clone(),
            DeviceRecord {
                token: token_stored,
                label: label.to_string(),
                // So the UI shows Online right after pairing; agent must still send heartbeats (~15s) to stay online.
                last_heartbeat_unix: now,
                last_agent_version: String::new(),
                last_mt5_connected: false,
            },
        );
        self.file
            .worker_configs
            .insert(device_id.clone(), RemoteWorkerConfig::default());
        self.save().map_err(|e| e.to_string())?;
        Ok((device_id, token))
    }

    fn verify_device(&self, device_id: &str, token: &str) -> bool {
        self.file
            .devices
            .get(device_id)
            .map(|d| token_matches_stored(&d.token, token))
            .unwrap_or(false)
    }

    /// True if `token` is valid for `device_id` (used at WebSocket upgrade).
    pub fn device_auth_ok(&self, device_id: &str, token: &str) -> bool {
        self.verify_device(device_id, token)
    }

    pub fn heartbeat(
        &mut self,
        device_id: &str,
        token: &str,
        agent_version: &str,
        mt5_connected: bool,
    ) -> Result<(), String> {
        if !self.verify_device(device_id, token) {
            return Err("unauthorized".to_string());
        }
        let dev = self
            .file
            .devices
            .get_mut(device_id)
            .ok_or_else(|| "unauthorized".to_string())?;
        if !dev.token.starts_with("h1:") {
            dev.token = hash_agent_token(token);
        }
        dev.last_heartbeat_unix = chrono::Utc::now().timestamp();
        dev.last_agent_version = agent_version.to_string();
        dev.last_mt5_connected = mt5_connected;
        self.save().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn enqueue_command(
        &mut self,
        device_id: &str,
        cmd_type: &str,
        payload: serde_json::Value,
        ttl_sec: u64,
    ) -> Result<String, String> {
        if !self.file.devices.contains_key(device_id) {
            return Err("unknown device_id".to_string());
        }
        let now = chrono::Utc::now().timestamp();
        let id = Uuid::new_v4().to_string();
        let cmd = CommandRecord {
            id: id.clone(),
            device_id: device_id.to_string(),
            cmd_type: cmd_type.to_string(),
            payload,
            status: "pending".to_string(),
            created_unix: now,
            expires_unix: now + ttl_sec as i64,
            started_unix: 0,
            result: None,
        };
        self.file.commands.push(cmd);
        self.save().map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn next_command(&mut self, device_id: &str, token: &str) -> Result<Option<CommandRecord>, String> {
        if !self.verify_device(device_id, token) {
            return Err("unauthorized".to_string());
        }
        let now = chrono::Utc::now().timestamp();
        // Poll counts as liveness — agent hits this every few seconds even if heartbeat POST fails.
        if let Some(dev) = self.file.devices.get_mut(device_id) {
            dev.last_heartbeat_unix = now;
        }
        for c in &mut self.file.commands {
            if c.status == "pending" && c.expires_unix < now {
                c.status = "expired".to_string();
            }
        }
        let idx = self
            .file
            .commands
            .iter()
            .position(|c| c.device_id == device_id && c.status == "pending" && c.expires_unix >= now);
        let cmd_opt = if let Some(i) = idx {
            self.file.commands[i].status = "in_flight".to_string();
            self.file.commands[i].started_unix = now;
            Some(self.file.commands[i].clone())
        } else {
            None
        };
        self.save().map_err(|e| e.to_string())?;
        Ok(cmd_opt)
    }

    pub fn complete_command(
        &mut self,
        device_id: &str,
        token: &str,
        cmd_id: &str,
        ok: bool,
        result: serde_json::Value,
    ) -> Result<(), String> {
        if !self.verify_device(device_id, token) {
            return Err("unauthorized".to_string());
        }
        let pos = self
            .file
            .commands
            .iter()
            .position(|c| c.id == cmd_id && c.device_id == device_id);
        let Some(i) = pos else {
            return Err("command not found".to_string());
        };
        if self.file.commands[i].status != "in_flight" {
            return Err("command not in flight".to_string());
        }
        self.file.commands[i].status = if ok { "done".to_string() } else { "failed".to_string() };
        self.file.commands[i].result = Some(result);
        self.save().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn prune_commands(&mut self, keep_last: usize) {
        let mut active: Vec<CommandRecord> = self
            .file
            .commands
            .iter()
            .filter(|c| c.status == "pending" || c.status == "in_flight")
            .cloned()
            .collect();
        let mut done: Vec<CommandRecord> = self
            .file
            .commands
            .iter()
            .filter(|c| c.status != "pending" && c.status != "in_flight")
            .cloned()
            .collect();
        if done.len() > keep_last {
            done.sort_by_key(|c| c.created_unix);
            let drop = done.len() - keep_last;
            done.drain(0..drop);
        }
        active.extend(done);
        active.sort_by_key(|c| c.created_unix);
        self.file.commands = active;
        let _ = self.save();
    }

    pub fn list_commands(&self, device_id: Option<&str>, limit: usize) -> Vec<CommandRecord> {
        let mut rows: Vec<CommandRecord> = self
            .file
            .commands
            .iter()
            .filter(|c| device_id.map(|d| d == c.device_id).unwrap_or(true))
            .cloned()
            .collect();
        rows.sort_by_key(|c| c.created_unix);
        rows.reverse();
        rows.into_iter().take(limit).collect()
    }

    /// Remove `pending`, `done`, and `failed` commands. Keeps `in_flight` so agents can still POST complete.
    /// `device_filter`: `None` or empty = all devices; otherwise only matching `device_id`.
    pub fn clear_commands_queue(&mut self, device_filter: Option<&str>) -> Result<usize, String> {
        let scope = device_filter.map(|s| s.trim()).filter(|s| !s.is_empty());
        let before = self.file.commands.len();
        self.file.commands.retain(|c| {
            if c.status == "in_flight" {
                return true;
            }
            match &scope {
                None => false,
                Some(did) => {
                    if c.device_id != *did {
                        true
                    } else {
                        false
                    }
                }
            }
        });
        let removed = before - self.file.commands.len();
        self.save().map_err(|e| e.to_string())?;
        Ok(removed)
    }

    /// Same recency window as `list_devices` → `probably_online`.
    pub fn device_probably_online(last_heartbeat_unix: i64, now: i64) -> bool {
        const SEEN_RECENT_SECS: i64 = 180;
        last_heartbeat_unix > 0 && now - last_heartbeat_unix < SEEN_RECENT_SECS
    }

    pub fn list_devices(&self) -> Vec<serde_json::Value> {
        let now = chrono::Utc::now().timestamp();
        self.file
            .devices
            .iter()
            .map(|(id, d)| {
                let w = self.file.worker_configs.get(id).cloned().unwrap_or_default();
                let terminals = self
                    .file
                    .terminal_inventories
                    .get(id)
                    .cloned()
                    .unwrap_or_default();
                json!({
                    "device_id": id,
                    "label": d.label,
                    "last_heartbeat_unix": d.last_heartbeat_unix,
                    "last_agent_version": d.last_agent_version,
                    "last_mt5_connected": d.last_mt5_connected,
                    "probably_online": Self::device_probably_online(d.last_heartbeat_unix, now),
                    "worker_enabled": w.enabled,
                    "worker_next_run_unix": w.next_run_unix,
                    "terminals": terminals,
                })
            })
            .collect()
    }

    /// JSON map device_id → terminals array (for admin WebSocket subscribe snapshot).
    pub fn terminal_inventories_snapshot_json(&self) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        for (id, rows) in &self.file.terminal_inventories {
            m.insert(id.clone(), json!(rows));
        }
        json!(m)
    }

    /// Apply inventory from an authenticated device WebSocket (token verified before upgrade).
    pub fn set_terminal_inventory_for_device(
        &mut self,
        device_id: &str,
        entries: Vec<TerminalInventoryEntry>,
    ) -> Result<Vec<TerminalInventoryEntry>, String> {
        if !self.file.devices.contains_key(device_id) {
            return Err("unknown device".to_string());
        }
        const MAX_ID: usize = 80;
        const MAX_PATH: usize = 2048;
        const MAX_LABEL: usize = 256;
        if entries.len() > MAX_REMOTE_DEVICE_TERMINALS {
            return Err(format!(
                "too many terminals (max {})",
                MAX_REMOTE_DEVICE_TERMINALS
            ));
        }
        for e in &entries {
            if e.id.is_empty() || e.id.len() > MAX_ID {
                return Err("invalid terminal id".to_string());
            }
            if !e
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(
                    "terminal id must be ASCII letters, digits, underscore, or hyphen".to_string(),
                );
            }
            if e.exe_path.len() > MAX_PATH || e.label.len() > MAX_LABEL {
                return Err("terminal label or path too long".to_string());
            }
        }
        self.file
            .terminal_inventories
            .insert(device_id.to_string(), entries.clone());
        self.save().map_err(|e| e.to_string())?;
        Ok(entries)
    }

    /// Remove a device (admin action). Works whether the agent is online or not; the agent loses auth until re-paired.
    pub fn delete_device(&mut self, device_id: &str) -> Result<(), String> {
        if !self.file.devices.contains_key(device_id) {
            return Err("unknown device_id".to_string());
        }
        self.file.devices.remove(device_id);
        self.file.worker_configs.remove(device_id);
        self.file.terminal_inventories.remove(device_id);
        self.file.commands.retain(|c| {
            c.device_id != device_id || (c.status != "pending" && c.status != "in_flight")
        });
        self.save().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Invalidate the stored agent token (agent gets 401 until it pairs again with a new code).
    /// Keeps the device row, label, and worker settings; disables the remote worker; clears cached terminals.
    pub fn revoke_device_credentials(&mut self, device_id: &str) -> Result<(), String> {
        let Some(dev) = self.file.devices.get_mut(device_id) else {
            return Err("unknown device_id".to_string());
        };
        let new_plain = Uuid::new_v4().simple().to_string();
        dev.token = hash_agent_token(&new_plain);
        dev.last_heartbeat_unix = 0;
        dev.last_mt5_connected = false;
        self.file.terminal_inventories.remove(device_id);
        if let Some(w) = self.file.worker_configs.get_mut(device_id) {
            w.enabled = false;
            w.next_run_unix = 0;
        }
        self.file.commands.retain(|c| {
            c.device_id != device_id || (c.status != "pending" && c.status != "in_flight")
        });
        self.save().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn next_worker_delay_sec(cfg: &RemoteWorkerConfig) -> i64 {
        let min_sec = (cfg.min_interval_minutes.max(0.5) * 60.0) as i64;
        let max_sec = (cfg.max_interval_minutes.max(cfg.min_interval_minutes.max(0.5)) * 60.0) as i64;
        if max_sec <= min_sec {
            return min_sec.max(30);
        }
        let mut rng = rand::thread_rng();
        let v = rng.gen_range(min_sec..=max_sec);
        v.max(30)
    }

    fn random_volume(min: f64, max: f64) -> f64 {
        let lo = min.min(max).max(0.01);
        let hi = max.max(min).max(0.01);
        let mut rng = rand::thread_rng();
        let raw = lo + rng.gen_range(0.0..1.0) * (hi - lo);
        (raw * 100.0).round() / 100.0
    }

    fn set_worker_config(&mut self, device_id: &str, mut cfg: RemoteWorkerConfig) -> Result<(), String> {
        if !self.file.devices.contains_key(device_id) {
            return Err("unknown device_id".to_string());
        }
        if cfg.account_ids.is_empty() {
            cfg.account_ids = vec!["default".to_string()];
        }
        if cfg.min_volume <= 0.0 {
            cfg.min_volume = 0.01;
        }
        if cfg.max_volume <= 0.0 {
            cfg.max_volume = cfg.min_volume.max(0.01);
        }
        if cfg.min_interval_minutes < 0.5 {
            cfg.min_interval_minutes = 0.5;
        }
        if cfg.max_interval_minutes < cfg.min_interval_minutes {
            cfg.max_interval_minutes = cfg.min_interval_minutes;
        }
        if cfg.enabled && cfg.next_run_unix <= 0 {
            cfg.next_run_unix = chrono::Utc::now().timestamp() + Self::next_worker_delay_sec(&cfg);
        }
        self.file.worker_configs.insert(device_id.to_string(), cfg);
        self.save().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_worker_config(&self, device_id: &str) -> Option<serde_json::Value> {
        self.file.worker_configs.get(device_id).map(|w| {
            json!({
                "enabled": w.enabled,
                "account_ids": w.account_ids,
                "symbols": w.symbols,
                "min_volume": w.min_volume,
                "max_volume": w.max_volume,
                "min_interval_minutes": w.min_interval_minutes,
                "max_interval_minutes": w.max_interval_minutes,
                "max_open_positions": w.max_open_positions,
                "sl_pips": w.sl_pips,
                "tp_pips": w.tp_pips,
                "max_spread_pips": w.max_spread_pips,
                "next_run_unix": w.next_run_unix,
                "last_direction": w.last_direction,
            })
        })
    }

    /// Returns `(commands_queued, worker_config_changed)` — emit hub refresh when either is non-zero / true.
    pub fn scheduler_tick(&mut self) -> (usize, bool) {
        let now = chrono::Utc::now().timestamp();
        let mut queued = 0usize;
        let mut config_changed = false;
        let mut to_enqueue: Vec<(String, serde_json::Value)> = Vec::new();
        let device_ids: Vec<String> = self.file.worker_configs.keys().cloned().collect();
        for device_id in device_ids {
            let Some(cfg) = self.file.worker_configs.get_mut(&device_id) else {
                continue;
            };
            if !cfg.enabled {
                continue;
            }
            let sl_ok = cfg.sl_pips.map(|s| s.is_finite() && s > 0.0).unwrap_or(false);
            let tp_ok = cfg.tp_pips.map(|t| t.is_finite() && t > 0.0).unwrap_or(false);
            if !sl_ok || !tp_ok {
                // Legacy or tampered configs: never open without both stops.
                cfg.enabled = false;
                cfg.next_run_unix = 0;
                config_changed = true;
                continue;
            }
            if cfg.next_run_unix > now {
                continue;
            }
            if cfg.account_ids.is_empty() || cfg.symbols.is_empty() {
                cfg.next_run_unix = now + Self::next_worker_delay_sec(cfg);
                continue;
            }
            let mut rng = rand::thread_rng();
            let sym_idx = rng.gen_range(0..cfg.symbols.len());
            let symbol = cfg.symbols[sym_idx].clone();
            let order_type = match cfg.last_direction.as_deref() {
                Some("buy") => "sell".to_string(),
                Some("sell") => "buy".to_string(),
                _ => {
                    if rng.gen_bool(0.5) {
                        "buy".to_string()
                    } else {
                        "sell".to_string()
                    }
                }
            };
            cfg.last_direction = Some(order_type.clone());
            let volume = Self::random_volume(cfg.min_volume, cfg.max_volume);
            let mut payload = json!({
                "account_ids": cfg.account_ids.clone(),
                "symbol": symbol,
                "order_type": order_type,
                "volume": volume,
                "comment": "remote-fixedlot",
                "max_open_positions": cfg.max_open_positions
            });
            if let Some(s) = cfg.sl_pips {
                if s.is_finite() && s > 0.0 {
                    payload["sl_pips"] = json!(s);
                }
            }
            if let Some(t) = cfg.tp_pips {
                if t.is_finite() && t > 0.0 {
                    payload["tp_pips"] = json!(t);
                }
            }
            if let Some(m) = cfg.max_spread_pips {
                if m.is_finite() && m > 0.0 {
                    payload["max_spread_pips"] = json!(m);
                }
            }
            to_enqueue.push((device_id.clone(), payload));
            cfg.next_run_unix = now + Self::next_worker_delay_sec(cfg);
            queued += 1;
        }
        for (device_id, payload) in to_enqueue {
            let _ = self.enqueue_command(&device_id, "fixed_lot_tick", payload, 120);
        }
        if queued > 0 || config_changed {
            let _ = self.save();
        }
        (queued, config_changed)
    }
}

fn save_agent_admin_key_to_disk(path: &Path, key: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, format!("{}\n", key.trim()))
}

/// GET — public within normal API auth (panel/JWT when enabled). Does not expose the key.
pub async fn agent_admin_key_status(State(state): State<AppState>) -> impl IntoResponse {
    let persisted = state.agent_admin_key_file.is_file();
    let key = state.agent_admin_key.lock().unwrap();
    let using_dev_default = key.as_str() == "dev-admin-change-me";
    Json(json!({
        "ok": true,
        "persisted": persisted,
        "using_dev_default": using_dev_default
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AgentAdminKeyUpdateBody {
    pub current_key: String,
    pub new_key: String,
}

pub async fn agent_admin_key_update(
    State(state): State<AppState>,
    Json(body): Json<AgentAdminKeyUpdateBody>,
) -> impl IntoResponse {
    let new_key = body.new_key.trim().to_string();
    if new_key.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "new_key must be at least 8 characters"})),
        )
            .into_response();
    }
    {
        let g = state.agent_admin_key.lock().unwrap();
        if body.current_key.trim() != *g {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"ok": false, "error": "current_key does not match server admin key"})),
            )
                .into_response();
        }
    }
    if let Err(e) = save_agent_admin_key_to_disk(&state.agent_admin_key_file, &new_key) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": format!("could not save: {}", e)})),
        )
            .into_response();
    }
    *state.agent_admin_key.lock().unwrap() = new_key;
    Json(json!({"ok": true})).into_response()
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(str::to_string)
}

#[derive(Deserialize)]
pub struct PairingCreateBody {
    pub admin_key: String,
}

pub async fn agent_create_pairing_code(
    State(state): State<AppState>,
    Json(body): Json<PairingCreateBody>,
) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let mut store = state.agent.lock().unwrap();
    let (code, expires_unix) = store.create_pairing_code(3600);
    drop(store);
    state.emit_agent_hub_refresh();
    Json(json!({ "ok": true, "code": code, "expires_unix": expires_unix })).into_response()
}

#[derive(Deserialize)]
pub struct RegisterBody {
    pub code: String,
    #[serde(default)]
    pub label: String,
}

pub async fn agent_register(State(state): State<AppState>, Json(body): Json<RegisterBody>) -> impl IntoResponse {
    let label = if body.label.is_empty() { "device" } else { body.label.as_str() };
    let mut store = state.agent.lock().unwrap();
    match store.register_device(&body.code, label) {
        Ok((device_id, token)) => {
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true, "device_id": device_id, "token": token})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct HeartbeatBody {
    #[serde(default)]
    pub agent_version: String,
    #[serde(default)]
    pub mt5_connected: bool,
}

pub async fn agent_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<HeartbeatBody>,
) -> impl IntoResponse {
    let Some(token) = bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "missing bearer token"}))).into_response();
    };
    let Some(device_id) = headers.get("X-Device-Id").and_then(|v| v.to_str().ok()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": "missing X-Device-Id header"}))).into_response();
    };
    let mut store = state.agent.lock().unwrap();
    match store.heartbeat(device_id, &token, &body.agent_version, body.mt5_connected) {
        Ok(()) => {
            drop(store);
            state.emit_agent_hub_refresh_throttled(std::time::Duration::from_secs(3));
            Json(json!({"ok": true})).into_response()
        }
        Err(_) => (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response(),
    }
}

pub async fn agent_commands_next(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let Some(token) = bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "missing bearer token"}))).into_response();
    };
    let Some(device_id) = headers.get("X-Device-Id").and_then(|v| v.to_str().ok()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": "missing X-Device-Id header"}))).into_response();
    };
    let mut store = state.agent.lock().unwrap();
    match store.next_command(device_id, &token) {
        Ok(Some(cmd)) => {
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true, "command": cmd})).into_response()
        }
        Ok(None) => Json(json!({"ok": true, "command": null})).into_response(),
        Err(_) => (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct CompleteBody {
    pub command_id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: serde_json::Value,
}

pub async fn agent_command_complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CompleteBody>,
) -> impl IntoResponse {
    let Some(token) = bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "missing bearer token"}))).into_response();
    };
    let Some(device_id) = headers.get("X-Device-Id").and_then(|v| v.to_str().ok()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": "missing X-Device-Id header"}))).into_response();
    };
    let mut store = state.agent.lock().unwrap();
    match store.complete_command(device_id, &token, &body.command_id, body.ok, body.result) {
        Ok(()) => {
            store.prune_commands(1000);
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct EnqueueBody {
    pub admin_key: String,
    pub device_id: String,
    #[serde(rename = "type")]
    pub cmd_type: String,
    pub payload: serde_json::Value,
    #[serde(default = "default_ttl")]
    pub ttl_sec: u64,
}

fn default_ttl() -> u64 {
    300
}

pub async fn agent_enqueue_command(
    State(state): State<AppState>,
    Json(body): Json<EnqueueBody>,
) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let mut store = state.agent.lock().unwrap();
    match store.enqueue_command(&body.device_id, &body.cmd_type, body.payload.clone(), body.ttl_sec) {
        Ok(id) => {
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true, "command_id": id})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ListDevicesBody {
    pub admin_key: String,
}

pub async fn agent_list_devices(State(state): State<AppState>, Json(body): Json<ListDevicesBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let store = state.agent.lock().unwrap();
    let devices = store.list_devices();
    Json(json!({"ok": true, "devices": devices})).into_response()
}

/// Same device list as POST `/api/agent/devices/list`, for browsers (JWT or panel key via middleware).
pub async fn agent_list_devices_get(State(state): State<AppState>) -> impl IntoResponse {
    let store = state.agent.lock().unwrap();
    let devices = store.list_devices();
    Json(json!({"ok": true, "devices": devices})).into_response()
}

#[derive(Deserialize)]
pub struct DeleteDeviceBody {
    pub admin_key: String,
    pub device_id: String,
}

pub async fn agent_delete_device(State(state): State<AppState>, Json(body): Json<DeleteDeviceBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let id = body.device_id.trim();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "device_id required"})),
        )
            .into_response();
    }
    let mut store = state.agent.lock().unwrap();
    match store.delete_device(id) {
        Ok(()) => {
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

pub async fn agent_revoke_device(State(state): State<AppState>, Json(body): Json<DeleteDeviceBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let id = body.device_id.trim();
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "device_id required"})),
        )
            .into_response();
    }
    let mut store = state.agent.lock().unwrap();
    match store.revoke_device_credentials(id) {
        Ok(()) => {
            drop(store);
            state.remote_positions_clear_device(id);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct ListCommandsBody {
    pub admin_key: String,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn agent_list_commands(State(state): State<AppState>, Json(body): Json<ListCommandsBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let store = state.agent.lock().unwrap();
    let rows = store.list_commands(body.device_id.as_deref(), body.limit.unwrap_or(50).min(500));
    Json(json!({"ok": true, "commands": rows})).into_response()
}

#[derive(Deserialize)]
pub struct ClearCommandsBody {
    pub admin_key: String,
    /// If set and non-empty, only commands for this device are removed (non–in-flight). If omitted or empty, all devices.
    #[serde(default)]
    pub device_id: Option<String>,
}

pub async fn agent_commands_clear(State(state): State<AppState>, Json(body): Json<ClearCommandsBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let filter = body
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut store = state.agent.lock().unwrap();
    match store.clear_commands_queue(filter) {
        Ok(removed) => {
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true, "removed": removed})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct WorkerSetBody {
    pub admin_key: String,
    pub device_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub account_ids: Vec<String>,
    #[serde(default)]
    pub symbols: Vec<String>,
    pub min_volume: f64,
    pub max_volume: f64,
    pub min_interval_minutes: f64,
    pub max_interval_minutes: f64,
    #[serde(default)]
    pub max_open_positions: u32,
    #[serde(default)]
    pub sl_pips: Option<f64>,
    #[serde(default)]
    pub tp_pips: Option<f64>,
    #[serde(default)]
    pub max_spread_pips: Option<f64>,
}

pub async fn agent_worker_set(State(state): State<AppState>, Json(body): Json<WorkerSetBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let mut store = state.agent.lock().unwrap();
    let sl_pips = body.sl_pips.filter(|x| x.is_finite() && *x > 0.0);
    let tp_pips = body.tp_pips.filter(|x| x.is_finite() && *x > 0.0);
    let max_spread_pips = body.max_spread_pips.filter(|x| x.is_finite() && *x > 0.0);
    if body.enabled && (sl_pips.is_none() || tp_pips.is_none()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "Remote worker requires both SL and TP (pips) when enabled."})),
        )
            .into_response();
    }
    let cfg = RemoteWorkerConfig {
        enabled: body.enabled,
        account_ids: body.account_ids,
        symbols: body.symbols,
        min_volume: body.min_volume,
        max_volume: body.max_volume,
        min_interval_minutes: body.min_interval_minutes,
        max_interval_minutes: body.max_interval_minutes,
        max_open_positions: body.max_open_positions,
        sl_pips,
        tp_pips,
        max_spread_pips,
        ..RemoteWorkerConfig::default()
    };
    match store.set_worker_config(&body.device_id, cfg) {
        Ok(()) => {
            drop(store);
            state.emit_agent_hub_refresh();
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct WorkerGetBody {
    pub admin_key: String,
    pub device_id: String,
}

pub async fn agent_worker_get(State(state): State<AppState>, Json(body): Json<WorkerGetBody>) -> impl IntoResponse {
    if !state.verify_agent_admin_key(Some(body.admin_key.as_str())) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "unauthorized"}))).into_response();
    }
    let store = state.agent.lock().unwrap();
    match store.get_worker_config(&body.device_id) {
        Some(cfg) => Json(json!({"ok": true, "config": cfg})).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"ok": false, "error": "device/config not found"}))).into_response(),
    }
}

/// Remote agent WebSocket: push `terminal_inventory` (Bearer + `X-Device-Id` on upgrade).
pub async fn ws_agent_device(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Some(token) = bearer_token(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"ok": false, "error": "missing bearer"})),
        )
            .into_response();
    };
    let Some(device_id_raw) = headers
        .get("x-device-id")
        .or_else(|| headers.get("X-Device-Id"))
        .and_then(|v| v.to_str().ok())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "missing X-Device-Id"})),
        )
            .into_response();
    };
    let device_id = device_id_raw.to_string();
    {
        let store = state.agent.lock().unwrap();
        if !store.device_auth_ok(&device_id, &token) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"ok": false, "error": "unauthorized"})),
            )
                .into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_agent_device_ws(socket, state, device_id))
}

fn terminals_from_agent_json(v: &serde_json::Value) -> Result<Vec<TerminalInventoryEntry>, String> {
    match v.get("terminals") {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(t) => serde_json::from_value(t.clone())
            .map_err(|e| format!("invalid terminals array: {e}")),
    }
}

async fn handle_agent_device_ws(mut socket: WebSocket, state: AppState, device_id: String) {
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Text(txt)) => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
                    let _ = socket
                        .send(Message::Text(
                            json!({"ok": false, "error": "invalid json"}).to_string().into(),
                        ))
                        .await;
                    continue;
                };
                let Some(msg_type) = v.get("type").and_then(|x| x.as_str()) else {
                    continue;
                };
                match msg_type {
                    "terminal_inventory" => {
                        let entries = match terminals_from_agent_json(&v) {
                            Ok(e) => e,
                            Err(e) => {
                                let _ = socket
                                    .send(Message::Text(json!({"ok": false, "error": e}).to_string().into()))
                                    .await;
                                continue;
                            }
                        };
                        let result = {
                            let mut store = state.agent.lock().unwrap();
                            store.set_terminal_inventory_for_device(&device_id, entries)
                        };
                        match result {
                            Ok(saved) => {
                                state.emit_device_terminals(&device_id, &saved);
                                let _ = socket.send(Message::Text(r#"{"ok":true}"#.into())).await;
                            }
                            Err(e) => {
                                let _ = socket
                                    .send(Message::Text(json!({"ok": false, "error": e}).to_string().into()))
                                    .await;
                            }
                        }
                    }
                    "positions_snapshot" => {
                        let Some(results) = v.get("results").cloned() else {
                            let _ = socket
                                .send(Message::Text(
                                    json!({"ok": false, "error": "missing results"}).to_string().into(),
                                ))
                                .await;
                            continue;
                        };
                        let merge = v.get("merge").and_then(|x| x.as_bool()) == Some(true);
                        let apply_res = if merge {
                            state.remote_positions_merge_snapshot(&device_id, results)
                        } else {
                            state.remote_positions_apply_snapshot(&device_id, results)
                        };
                        match apply_res {
                            Ok(()) => {
                                let _ = socket.send(Message::Text(r#"{"ok":true}"#.into())).await;
                            }
                            Err(e) => {
                                eprintln!(
                                    "mt5-panel-api: positions_snapshot rejected for device_id={}: {}",
                                    device_id, e
                                );
                                let _ = socket
                                    .send(Message::Text(json!({"ok": false, "error": e}).to_string().into()))
                                    .await;
                            }
                        }
                    }
                    "history_deals_snapshot" => {
                        let Some(results) = v.get("results").cloned() else {
                            let _ = socket
                                .send(Message::Text(
                                    json!({"ok": false, "error": "missing results"}).to_string().into(),
                                ))
                                .await;
                            continue;
                        };
                        let merge = v.get("merge").and_then(|x| x.as_bool()) == Some(true);
                        let apply_res = if merge {
                            state.remote_history_merge_snapshot(&device_id, results)
                        } else {
                            state.remote_history_apply_snapshot(&device_id, results)
                        };
                        match apply_res {
                            Ok(()) => {
                                let _ = socket.send(Message::Text(r#"{"ok":true}"#.into())).await;
                            }
                            Err(e) => {
                                eprintln!(
                                    "mt5-panel-api: history_deals_snapshot rejected for device_id={}: {}",
                                    device_id, e
                                );
                                let _ = socket
                                    .send(Message::Text(json!({"ok": false, "error": e}).to_string().into()))
                                    .await;
                            }
                        }
                    }
                    _ => continue,
                }
            }
            Ok(Message::Ping(p)) => {
                let _ = socket.send(Message::Pong(p)).await;
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }
    // Keep last known remote snapshots on transient WS disconnects (tunnel/network blips).
    // Heartbeat still reports online status separately; caches are replaced on next snapshot.
    // This avoids empty Live Positions / History panes during short reconnect windows.
}

pub async fn remote_worker_scheduler_loop(state: AppState) {
    use tokio::time::{sleep, Duration};
    loop {
        sleep(Duration::from_secs(2)).await;
        let (queued, cfg_changed) = {
            let mut store = state.agent.lock().unwrap();
            store.scheduler_tick()
        };
        if queued > 0 || cfg_changed {
            state.emit_agent_hub_refresh();
        }
    }
}

