//! Operator accounts: Argon2 passwords, JWT session cookie, optional TOTP, roles `admin` | `viewer`.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
use axum::http::header::{self, HeaderMap, SET_COOKIE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::Rng;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use totp_rs::{Algorithm, Secret, TOTP};

use crate::AppState;

const COOKIE_NAME: &str = "mt5_operator";
const JWT_EXPIRY_SECS: i64 = 8 * 3600;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OperatorRole {
    Admin,
    Viewer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperatorRecord {
    pub username: String,
    pub password_hash: String,
    pub role: OperatorRole,
    #[serde(default)]
    pub totp_secret_b32: Option<String>,
    /// TOTP secret waiting for first successful code (enrollment).
    #[serde(default)]
    pub totp_pending_b32: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct OperatorsFile {
    #[serde(default)]
    pub users: Vec<OperatorRecord>,
}

pub struct OperatorStore {
    path: PathBuf,
    pub data: Mutex<OperatorsFile>,
}

impl OperatorStore {
    pub fn load(path: PathBuf) -> Self {
        let file = if let Ok(s) = std::fs::read_to_string(&path) {
            serde_json::from_str(&s).unwrap_or_default()
        } else {
            OperatorsFile::default()
        };
        Self {
            path,
            data: Mutex::new(file),
        }
    }

    pub fn persist(&self, file: &OperatorsFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let s = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, s).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn user_count(&self) -> usize {
        self.data.lock().unwrap().users.len()
    }

    pub fn hash_password(password: &str) -> Result<String, String> {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| e.to_string())
    }

    pub fn create_bootstrap_admin(username: &str, password: &str) -> Result<OperatorRecord, String> {
        let password_hash = Self::hash_password(password)?;
        Ok(OperatorRecord {
            username: username.to_string(),
            password_hash,
            role: OperatorRole::Admin,
            totp_secret_b32: None,
            totp_pending_b32: None,
        })
    }

    pub fn verify_password(record: &OperatorRecord, password: &str) -> bool {
        let Ok(parsed) = PasswordHash::new(&record.password_hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    pub fn verify_totp(secret_b32: &str, code: &str) -> bool {
        let code = code.trim();
        if code.len() < 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        let Ok(secret_bytes) = Secret::Encoded(secret_b32.to_uppercase()).to_bytes() else {
            return false;
        };
        let Ok(totp) = TOTP::new(
            Algorithm::SHA1,
            6,
            1,
            30,
            secret_bytes,
            None,
            String::new(),
        ) else {
            return false;
        };
        totp.check_current(code).is_ok()
    }

    pub fn login(&self, username: &str, password: &str, totp: Option<&str>) -> Result<OperatorRecord, String> {
        let rec = {
            let file = self.data.lock().unwrap();
            file.users
                .iter()
                .find(|u| u.username == username)
                .cloned()
        };
        let Some(rec) = rec else {
            return Err("invalid username or password".into());
        };
        if !Self::verify_password(&rec, password) {
            return Err("invalid username or password".into());
        }
        if let Some(ref active) = rec.totp_secret_b32 {
            let Some(tc) = totp.filter(|s| !s.is_empty()) else {
                return Err("totp_required".into());
            };
            if !Self::verify_totp(active, tc) {
                return Err("invalid totp code".into());
            }
        }
        Ok(rec)
    }

    pub fn add_or_replace_user(&self, record: OperatorRecord) -> Result<(), String> {
        let mut file = self.data.lock().unwrap();
        file.users.retain(|u| u.username != record.username);
        file.users.push(record);
        self.persist(&file)
    }
}

pub fn operator_jwt_secret() -> Option<String> {
    std::env::var("OPERATOR_JWT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Operators file is non-empty and JWT secret is configured.
pub fn operator_auth_active(store: &OperatorStore) -> bool {
    operator_jwt_secret().map(|s| s.len() >= 16).unwrap_or(false) && store.user_count() > 0
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OperatorClaims {
    pub sub: String,
    pub role: String,
    pub exp: u64,
}

pub fn issue_operator_jwt(username: &str, role: &OperatorRole, secret: &str) -> Result<String, String> {
    let exp = (chrono::Utc::now().timestamp() + JWT_EXPIRY_SECS) as u64;
    let role_s = match role {
        OperatorRole::Admin => "admin",
        OperatorRole::Viewer => "viewer",
    };
    let claims = OperatorClaims {
        sub: username.to_string(),
        role: role_s.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

pub fn decode_operator_jwt(token: &str, secret: &str) -> Result<OperatorClaims, String> {
    let mut val = Validation::default();
    val.leeway = 60;
    decode::<OperatorClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &val,
    )
    .map(|d| d.claims)
    .map_err(|e| e.to_string())
}

pub fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie.split(';') {
        let part = part.trim();
        let (k, v) = part.split_once('=')?;
        if k == name {
            return Some(v);
        }
    }
    None
}

pub fn extract_jwt_claims(headers: &HeaderMap) -> Option<OperatorClaims> {
    let secret = operator_jwt_secret()?;
    if let Some(bearer) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
    {
        if bearer.starts_with("eyJ") {
            return decode_operator_jwt(bearer, &secret).ok();
        }
    }
    let tok = cookie_value(headers, COOKIE_NAME)?;
    decode_operator_jwt(tok, &secret).ok()
}

pub fn maybe_bootstrap_operators(path: &Path) {
    if path.exists() {
        return;
    }
    let Ok(pw) = std::env::var("OPERATOR_BOOTSTRAP_PASSWORD") else {
        return;
    };
    let pw = pw.trim();
    if pw.is_empty() {
        return;
    }
    if operator_jwt_secret().is_none() {
        eprintln!(
            "mt5-panel-api: OPERATOR_BOOTSTRAP_PASSWORD set but OPERATOR_JWT_SECRET is missing — not creating operators.json"
        );
        return;
    }
    let user = std::env::var("OPERATOR_BOOTSTRAP_ADMIN_USER").unwrap_or_else(|_| "admin".to_string());
    let user = user.trim();
    if user.is_empty() {
        return;
    }
    let Ok(admin) = OperatorStore::create_bootstrap_admin(user, pw) else {
        return;
    };
    let file = OperatorsFile {
        users: vec![admin],
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(&file) {
        if std::fs::write(path, s).is_ok() {
            eprintln!(
                "mt5-panel-api: created operators.json with admin {:?} from OPERATOR_BOOTSTRAP_PASSWORD (change password after first login)",
                user
            );
        }
    }
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub totp: Option<String>,
}

pub async fn auth_login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> impl IntoResponse {
    let Some(secret) = operator_jwt_secret() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "operator_auth_not_configured"})),
        )
            .into_response();
    };
    if !operator_auth_active(&state.operators) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "no_operators_defined"})),
        )
            .into_response();
    }
    let totp = body.totp.as_deref();
    let rec = match state.operators.login(body.username.trim(), body.password.trim(), totp) {
        Ok(r) => r,
        Err(e) if e == "totp_required" => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"ok": false, "error": "totp_required"})),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"ok": false, "error": "invalid_credentials"})),
            )
                .into_response();
        }
    };
    let token = match issue_operator_jwt(&rec.username, &rec.role, &secret) {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": "token_failed"})),
            )
                .into_response();
        }
    };
    let cookie = format!(
        "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        COOKIE_NAME,
        token,
        JWT_EXPIRY_SECS
    );
    let mut res = Json(serde_json::json!({
        "ok": true,
        "user": { "username": rec.username, "role": match rec.role { OperatorRole::Admin => "admin", OperatorRole::Viewer => "viewer" } }
    }))
    .into_response();
    res.headers_mut().append(SET_COOKIE, cookie.parse().unwrap());
    res
}

#[derive(Deserialize)]
pub struct AddUserBody {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub role: String,
}

/// Create or replace an operator account (admin JWT only). Password minimum 8 characters enforced loosely.
pub async fn auth_add_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AddUserBody>,
) -> impl IntoResponse {
    if operator_jwt_secret().is_none() {
        return bad("operator_auth_not_configured");
    }
    let Some(claims) = extract_jwt_claims(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"ok": false, "error": "unauthorized"}))).into_response();
    };
    if claims.role != "admin" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"ok": false, "error": "forbidden"}))).into_response();
    }
    let user = body.username.trim();
    if user.is_empty() || body.password.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "invalid_username_or_password"})),
        )
            .into_response();
    }
    let role = match body.role.to_lowercase().as_str() {
        "viewer" => OperatorRole::Viewer,
        _ => OperatorRole::Admin,
    };
    let password_hash = match OperatorStore::hash_password(body.password.trim()) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": "hash_failed"})),
            )
                .into_response();
        }
    };
    let rec = OperatorRecord {
        username: user.to_string(),
        password_hash,
        role,
        totp_secret_b32: None,
        totp_pending_b32: None,
    };
    if let Err(e) = state.operators.add_or_replace_user(rec) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": e})),
        )
            .into_response();
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

pub async fn auth_logout() -> impl IntoResponse {
    let cookie = format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        COOKIE_NAME
    );
    let mut res = Json(serde_json::json!({"ok": true})).into_response();
    res.headers_mut().append(SET_COOKIE, cookie.parse().unwrap());
    res
}

pub async fn auth_me(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let enabled = operator_auth_active(&state.operators);
    let claims = extract_jwt_claims(&headers);
    let body = if let Some(c) = claims {
        serde_json::json!({
            "ok": true,
            "operator_auth_enabled": enabled,
            "authenticated": true,
            "user": { "username": c.sub, "role": c.role }
        })
    } else {
        serde_json::json!({
            "ok": true,
            "operator_auth_enabled": enabled,
            "authenticated": false
        })
    };
    Json(body)
}

#[derive(Deserialize)]
pub struct MfaConfirmBody {
    pub code: String,
}

/// POST with valid JWT. Generates pending TOTP secret; client confirms with /auth/mfa/confirm.
pub async fn auth_mfa_setup(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if operator_jwt_secret().is_none() {
        return bad("operator_auth_not_configured");
    }
    let Some(claims) = extract_jwt_claims(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"ok": false, "error": "unauthorized"}))).into_response();
    };
    if claims.role != "admin" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"ok": false, "error": "forbidden"}))).into_response();
    }
    let secret_bytes: Vec<u8> = (0..20).map(|_| rand::thread_rng().gen()).collect();
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret_bytes,
        Some("MT5 Panel".to_string()),
        claims.sub.clone(),
    )
    .expect("totp");
    let b32_small = totp.get_secret_base32().to_uppercase();
    let url = totp.get_url();

    {
        let mut file = state.operators.data.lock().unwrap();
        let Some(u) = file.users.iter_mut().find(|u| u.username == claims.sub) else {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"ok": false, "error": "user_not_found"}))).into_response();
        };
        u.totp_pending_b32 = Some(b32_small.clone());
        if state.operators.persist(&file).is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"ok": false, "error": "save_failed"}))).into_response();
        }
    }

    Json(serde_json::json!({
        "ok": true,
        "otpauth_url": url,
        "secret_base32": b32_small,
    }))
    .into_response()
}

fn bad(msg: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"ok": false, "error": msg}))).into_response()
}

/// Finalize enrollment after scanning QR.
pub async fn auth_mfa_confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MfaConfirmBody>,
) -> impl IntoResponse {
    let Some(_) = operator_jwt_secret() else {
        return bad("operator_auth_not_configured");
    };
    let Some(claims) = extract_jwt_claims(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"ok": false, "error": "unauthorized"}))).into_response();
    };
    if claims.role != "admin" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"ok": false, "error": "forbidden"}))).into_response();
    }
    let mut file = state.operators.data.lock().unwrap();
    let Some(u) = file.users.iter_mut().find(|u| u.username == claims.sub) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"ok": false, "error": "user_not_found"}))).into_response();
    };
    let Some(ref pending) = u.totp_pending_b32.clone() else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"ok": false, "error": "mfa_setup_not_started"}))).into_response();
    };
    if !OperatorStore::verify_totp(pending, &body.code) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "invalid_totp"})),
        )
            .into_response();
    }
    u.totp_secret_b32 = Some(pending.clone());
    u.totp_pending_b32 = None;
    if state.operators.persist(&file).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": "save_failed"})),
        )
            .into_response();
    }
    Json(serde_json::json!({"ok": true})).into_response()
}
