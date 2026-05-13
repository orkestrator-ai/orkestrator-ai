//! Process-wide registry of running tmux Claude sessions.

use super::session::{TmuxSession, TmuxSessionStatus};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

pub struct TmuxSessionManager {
    sessions: Mutex<HashMap<String, Arc<TmuxSession>>>,
}

impl TmuxSessionManager {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, env_id: String, session: Arc<TmuxSession>) {
        let mut map = self.sessions.lock().await;
        map.insert(env_id, session);
    }

    pub async fn get(&self, env_id: &str) -> Option<Arc<TmuxSession>> {
        let map = self.sessions.lock().await;
        map.get(env_id).cloned()
    }

    pub async fn remove(&self, env_id: &str) -> Option<Arc<TmuxSession>> {
        let mut map = self.sessions.lock().await;
        map.remove(env_id)
    }

    pub async fn status(&self, env_id: &str) -> Option<TmuxSessionStatus> {
        let session = self.get(env_id).await?;
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
