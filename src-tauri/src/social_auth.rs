use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::database::get_app_data_dir;
use crate::gdrive::{DriveAccountInfo, GoogleTokens};

const DEFAULT_AUTH_SERVER_URL: &str = "https://streamvault-backend-server.onrender.com";

fn resolve_auth_server_url(server_url: Option<&str>) -> String {
    let normalized = server_url
        .map(str::trim)
        .unwrap_or("")
        .trim_end_matches('/');

    if normalized.is_empty() {
        DEFAULT_AUTH_SERVER_URL.to_string()
    } else {
        normalized.to_string()
    }
}

pub struct SocialAuthClient {
    tokens: Arc<Mutex<Option<GoogleTokens>>>,
    http_client: reqwest::Client,
}

impl SocialAuthClient {
    pub fn new() -> Self {
        let tokens = load_tokens().ok();
        Self {
            tokens: Arc::new(Mutex::new(tokens)),
            http_client: reqwest::Client::new(),
        }
    }

    pub fn is_authenticated(&self) -> bool {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub async fn get_access_token(&self, auth_server_url: Option<&str>) -> Result<String, String> {
        let tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner()).clone();

        match tokens {
            Some(t) => {
                if let Some(expires_at) = t.expires_at {
                    let now = chrono::Utc::now().timestamp();
                    if now >= expires_at - 60 {
                        if let Some(refresh_token) = &t.refresh_token {
                            return self
                                .refresh_access_token(refresh_token, auth_server_url)
                                .await;
                        }
                        return Err(
                            "Social token expired and no refresh token is available".to_string()
                        );
                    }
                }
                Ok(t.access_token)
            }
            None => Err("Social auth is not connected".to_string()),
        }
    }

    async fn refresh_access_token(
        &self,
        refresh_token: &str,
        auth_server_url: Option<&str>,
    ) -> Result<String, String> {
        let server_url = resolve_auth_server_url(auth_server_url);
        let response = self
            .http_client
            .post(format!("{}/auth/refresh", server_url))
            .json(&serde_json::json!({
                "refresh_token": refresh_token
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to refresh social token: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Social token refresh failed: {}", error_text));
        }

        let token_response: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse social token response: {}", e))?;

        let access_token = token_response["access_token"]
            .as_str()
            .ok_or("Missing access_token in social refresh response")?
            .to_string();

        let expires_in = token_response["expires_in"].as_i64().unwrap_or(3600);
        let expires_at = chrono::Utc::now().timestamp() + expires_in;

        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut t) = *tokens {
            t.access_token = access_token.clone();
            t.expires_at = Some(expires_at);
            save_tokens(t).ok();
        }

        Ok(access_token)
    }

    pub fn store_tokens(&self, tokens: GoogleTokens) -> Result<(), String> {
        save_tokens(&tokens)?;
        *self.tokens.lock().unwrap_or_else(|e| e.into_inner()) = Some(tokens);
        Ok(())
    }

    pub fn clear_tokens(&self) -> Result<(), String> {
        *self.tokens.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let path = get_tokens_path();
        if path.exists() {
            fs::remove_file(path)
                .map_err(|e| format!("Failed to remove social auth tokens: {}", e))?;
        }
        Ok(())
    }

    pub async fn get_account_info(&self) -> Result<DriveAccountInfo, String> {
        let access_token = self.get_access_token(None).await?;

        let response = self
            .http_client
            .get("https://www.googleapis.com/oauth2/v2/userinfo")
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| format!("Failed to get social user info: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Social user info API error: {}", error_text));
        }

        let user_info: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse social user info: {}", e))?;

        Ok(DriveAccountInfo {
            email: user_info["email"].as_str().unwrap_or("").to_string(),
            display_name: user_info["name"].as_str().map(String::from),
            photo_url: user_info["picture"].as_str().map(String::from),
            storage_used: None,
            storage_limit: None,
        })
    }
}

pub fn get_auth_url(server_url: Option<&str>) -> String {
    format!("{}/auth/google/social", resolve_auth_server_url(server_url))
}

fn get_tokens_path() -> PathBuf {
    get_app_data_dir().join("social_tokens.json")
}

fn obfuscate(data: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    BASE64.encode(data)
}

fn deobfuscate(data: &str) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    let bytes = BASE64.decode(data).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn save_tokens(tokens: &GoogleTokens) -> Result<(), String> {
    let path = get_tokens_path();
    let json = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("Failed to serialize social auth tokens: {}", e))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let encoded = obfuscate(&json);
    fs::write(&path, encoded).map_err(|e| format!("Failed to save social auth tokens: {}", e))
}

fn load_tokens() -> Result<GoogleTokens, String> {
    let path = get_tokens_path();
    let encoded = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read social auth tokens: {}", e))?;

    let json = deobfuscate(&encoded)?;
    serde_json::from_str(&json).map_err(|e| format!("Failed to parse social auth tokens: {}", e))
}
