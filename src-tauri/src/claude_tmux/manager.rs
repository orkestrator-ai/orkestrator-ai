//! Process-wide registry of running tmux Claude sessions, keyed by `tab_id`.
//!
//! Each tab in the UI maps to its own `TmuxSession`. Multiple tabs can live
//! inside the same workspace (env); the manager exposes a count of active
//! sessions per env so callers can decide when it's safe to uninstall the
//! workspace-level hook artifacts.

use super::session::{TmuxSession, TmuxSessionStatus};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

pub struct TmuxSessionManager {
    /// Keyed by `tab_id`.
    sessions: Mutex<HashMap<String, Arc<TmuxSession>>>,
}

impl TmuxSessionManager {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, tab_id: String, session: Arc<TmuxSession>) {
        let mut map = self.sessions.lock().await;
        map.insert(tab_id, session);
    }

    pub async fn get(&self, tab_id: &str) -> Option<Arc<TmuxSession>> {
        let map = self.sessions.lock().await;
        map.get(tab_id).cloned()
    }

    pub async fn remove(&self, tab_id: &str) -> Option<Arc<TmuxSession>> {
        let mut map = self.sessions.lock().await;
        map.remove(tab_id)
    }

    /// Number of active sessions in the given workspace (env). Used to gate
    /// uninstalling workspace-level hook artifacts on the *last* tab to stop.
    pub async fn sessions_in_env(&self, environment_id: &str) -> usize {
        let map = self.sessions.lock().await;
        map.values()
            .filter(|s| s.environment_id == environment_id)
            .count()
    }

    pub async fn status(&self, tab_id: &str) -> Option<TmuxSessionStatus> {
        let session = self.get(tab_id).await?;
        let alive = session.tmux_alive().await.unwrap_or(false);
        Some(session.status(alive))
    }
}

static MANAGER: OnceLock<TmuxSessionManager> = OnceLock::new();

pub fn init_manager() {
    let _ = MANAGER.set(TmuxSessionManager::new());
}

pub fn get_manager() -> &'static TmuxSessionManager {
    MANAGER.get_or_init(TmuxSessionManager::new)
}
