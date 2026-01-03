//! Discord Activity API endpoints
//!
//! Handles Discord OAuth2 token exchange and room management for Discord Activities.

use std::collections::HashMap;

use actix_web::{get, post, web::{Data, Json, Query}};
use log::{debug, error, info, warn};
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::app::{App, AppError};
use common::api_bindings::{
    GetDiscordRoomQuery, GetDiscordRoomResponse, PostDiscordRoomRequest, PostDiscordRoomResponse,
    PostDiscordTokenRequest, PostDiscordTokenResponse,
};

/// Maps Discord Activity instance IDs to room IDs
pub struct DiscordInstanceManager {
    /// Map from Discord instance_id to room_id
    instances: RwLock<HashMap<String, String>>,
}

impl DiscordInstanceManager {
    pub fn new() -> Self {
        Self {
            instances: RwLock::new(HashMap::new()),
        }
    }

    /// Register a room for a Discord Activity instance
    pub async fn register_instance(&self, instance_id: String, room_id: String) {
        let mut instances = self.instances.write().await;
        info!(
            "Registering Discord instance {} -> room {}",
            instance_id, room_id
        );
        instances.insert(instance_id, room_id);
    }

    /// Get the room ID for a Discord Activity instance
    pub async fn get_room_id(&self, instance_id: &str) -> Option<String> {
        let instances = self.instances.read().await;
        instances.get(instance_id).cloned()
    }

    /// Remove a Discord Activity instance mapping
    #[allow(dead_code)]
    pub async fn remove_instance(&self, instance_id: &str) {
        let mut instances = self.instances.write().await;
        if instances.remove(instance_id).is_some() {
            info!("Removed Discord instance {}", instance_id);
        }
    }

    /// Remove all instances pointing to a room (when room is closed)
    #[allow(dead_code)]
    pub async fn remove_room(&self, room_id: &str) {
        let mut instances = self.instances.write().await;
        instances.retain(|_, rid| rid != room_id);
    }
}

impl Default for DiscordInstanceManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Response from Discord's OAuth2 token endpoint
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DiscordTokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
    scope: String,
}

/// Error response from Discord API
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DiscordErrorResponse {
    error: String,
    error_description: Option<String>,
}

/// Exchange Discord OAuth2 authorization code for access token
///
/// POST /api/discord/token
/// Body: { "code": "authorization_code" }
/// Response: { "access_token": "..." }
#[post("/discord/token")]
pub async fn discord_token_exchange(
    app: Data<App>,
    Json(request): Json<PostDiscordTokenRequest>,
) -> Result<Json<PostDiscordTokenResponse>, AppError> {
    let config = app.config();

    let discord_config = config.discord.as_ref().ok_or_else(|| {
        warn!("Discord token exchange attempted but Discord is not configured");
        AppError::BadRequest
    })?;

    debug!("Exchanging Discord OAuth2 code for token");

    // Build the token exchange request
    let client = reqwest::Client::new();

    let mut params = HashMap::new();
    params.insert("client_id", discord_config.client_id.as_str());
    params.insert("client_secret", discord_config.client_secret.as_str());
    params.insert("grant_type", "authorization_code");
    params.insert("code", &request.code);

    // Use redirect_uri if configured, otherwise let Discord use the default
    let redirect_uri;
    if let Some(ref uri) = discord_config.redirect_uri {
        redirect_uri = uri.clone();
        params.insert("redirect_uri", &redirect_uri);
    }

    let response = client
        .post("https://discord.com/api/oauth2/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| {
            error!("Failed to contact Discord API: {}", e);
            AppError::ExternalService
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        error!(
            "Discord token exchange failed with status {}: {}",
            status, error_body
        );
        return Err(AppError::ExternalService);
    }

    let token_response: DiscordTokenResponse = response.json().await.map_err(|e| {
        error!("Failed to parse Discord token response: {}", e);
        AppError::ExternalService
    })?;

    debug!("Successfully exchanged Discord OAuth2 code for token");

    Ok(Json(PostDiscordTokenResponse {
        access_token: token_response.access_token,
    }))
}

/// Get room ID for a Discord Activity instance
///
/// GET /api/discord/room?instance_id=...
/// Response: { "room_id": "ABC123" } or { "room_id": null }
#[get("/discord/room")]
pub async fn get_discord_room(
    app: Data<App>,
    Query(query): Query<GetDiscordRoomQuery>,
) -> Result<Json<GetDiscordRoomResponse>, AppError> {
    let room_id = app.discord_instances().get_room_id(&query.instance_id).await;

    debug!(
        "Discord room lookup for instance {}: {:?}",
        query.instance_id, room_id
    );

    Ok(Json(GetDiscordRoomResponse { room_id }))
}

/// Create a room for a Discord Activity instance
///
/// POST /api/discord/room
/// Body: { "instance_id": "...", "host_id": 1, "app_id": 1 }
/// Response: { "room_id": "ABC123" }
///
/// This is called by the host to create a room when starting the Discord Activity.
#[post("/discord/room")]
pub async fn create_discord_room(
    app: Data<App>,
    Json(request): Json<PostDiscordRoomRequest>,
) -> Result<Json<PostDiscordRoomResponse>, AppError> {
    // Check if a room already exists for this instance
    if let Some(existing_room_id) = app
        .discord_instances()
        .get_room_id(&request.instance_id)
        .await
    {
        debug!(
            "Discord instance {} already has room {}",
            request.instance_id, existing_room_id
        );
        return Ok(Json(PostDiscordRoomResponse {
            room_id: existing_room_id,
        }));
    }

    // Create a new room
    let room = app
        .room_manager()
        .create_room(
            request.host_id,
            request.app_id,
            "Discord Activity".to_string(),
        )
        .await;

    let room_id = {
        let room_guard = room.lock().await;
        room_guard.room_id.clone()
    };

    // Register the instance -> room mapping
    app.discord_instances()
        .register_instance(request.instance_id.clone(), room_id.clone())
        .await;

    info!(
        "Created Discord Activity room {} for instance {}",
        room_id, request.instance_id
    );

    Ok(Json(PostDiscordRoomResponse { room_id }))
}
