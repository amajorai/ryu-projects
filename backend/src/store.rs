use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;

use crate::seal_keys::PluginKeys;
use crate::seal_sql::{collect_readable, open_store, opened, SqlSeal};

/// This app's own data dir: `<data dir>/plugin-data/@ryu+projects`
/// (`RYU_PLUGIN_DATA_DIR` when Core spawned the process).
pub fn data_dir() -> PathBuf {
    ryu_sidecar_runtime::plugin_data_dir("@ryu/projects")
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub const LOCAL_TENANT_ID: &str = "local";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub due_date: String,
    pub id: String,
    pub owner: String,
    pub status: String,
    pub title: String,
}

/// Member kinds a project can hold. Bots and Groups get their own main
/// (coordinator) thread inside the project; humans collaborate on the threads.
pub const MEMBER_KINDS: &[&str] = &["agent", "group", "user"];

/// A bot, a Group, or a human that joined a project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMember {
    /// `agent`, `group`, or `user`.
    pub kind: String,
    /// The agent id, the Group (team) id, or the user id.
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The member's own main thread inside this project (bots and groups).
    #[serde(default)]
    pub main_thread_id: Option<String>,
    #[serde(default)]
    pub joined_at: i64,
    /// Optional: what this bot is working toward in this project. Mirrored
    /// from Core's `project:<p>/agent:<a>` guidance, which is what turns read.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub goal: String,
}

/// The project's model defaults, mirrored from Core's `project:<id>` scope so the
/// UI can render them without a second round trip. Core is the authority.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDefaults {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

impl ProjectDefaults {
    pub fn is_empty(&self) -> bool {
        self.provider.trim().is_empty()
            && self.model.trim().is_empty()
            && self.effort.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub client: String,
    pub coordinator_agent: Option<String>,
    pub coordinator_conversation_id: Option<String>,
    pub created_at: i64,
    pub cwd: Option<String>,
    pub description: String,
    pub due_date: String,
    pub execution_mode: String,
    pub id: String,
    pub name: String,
    pub owner: String,
    pub status: String,
    pub tasks: Vec<ProjectTask>,
    pub updated_at: i64,
    /// Optional glyph (`GlyphValue` JSON from `@ryu/ui`) drawn as the project's avatar.
    #[serde(default)]
    pub icon: Option<serde_json::Value>,
    /// Project knowledge: standing instructions every member thread's system
    /// prompt carries (mirrors Core's `project:<id>` guidance `instructions`).
    #[serde(default)]
    pub instructions: String,
    /// Bots, Groups and humans working on the project.
    #[serde(default)]
    pub members: Vec<ProjectMember>,
    /// Model defaults for every thread in the project (mirrors Core).
    #[serde(default)]
    pub defaults: ProjectDefaults,
    /// Optional: what the project is for. Every member thread's system prompt
    /// carries it (mirrors Core's `project:<id>` guidance).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub goal: String,
    /// Optional: whether the project's main threads answer briefly. `None`
    /// inherits Core's default (on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_replies: Option<bool>,
    /// Core-derived tenant key. It is never accepted from or returned to the UI.
    #[serde(skip)]
    pub tenant_id: String,
}

impl Project {
    /// The member entry for `(kind, id)`, if present.
    pub fn member(&self, kind: &str, id: &str) -> Option<&ProjectMember> {
        self.members.iter().find(|m| m.kind == kind && m.id == id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub content: String,
    pub id: String,
    pub kind: String,
    pub project_id: String,
    pub title: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub agent_id: Option<String>,
    pub conversation_id: Option<String>,
    pub created_at: i64,
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub task: String,
    pub title: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub enabled: bool,
    pub id: String,
    pub kind: String,
    pub last_run_at: Option<i64>,
    pub last_status: Option<String>,
    pub name: String,
    pub next_run_at: Option<i64>,
    pub project_id: String,
    pub schedule: Option<String>,
    pub updated_at: i64,
    /// Core-derived tenant key used by the background scheduler and store ACL.
    #[serde(skip)]
    pub tenant_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub context: Vec<ContextItem>,
    pub project: Project,
    pub subscriptions: Vec<Subscription>,
    pub workers: Vec<Worker>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    #[serde(default)]
    pub client: String,
    #[serde(default)]
    pub coordinator_agent: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub due_date: String,
    #[serde(default = "default_execution_mode")]
    pub execution_mode: String,
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub icon: Option<serde_json::Value>,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub defaults: ProjectDefaults,
    #[serde(default)]
    pub goal: String,
}

fn default_execution_mode() -> String {
    "auto".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub client: Option<String>,
    pub coordinator_agent: Option<String>,
    pub cwd: Option<String>,
    pub description: Option<String>,
    pub due_date: Option<String>,
    pub execution_mode: Option<String>,
    pub name: Option<String>,
    pub owner: Option<String>,
    pub status: Option<String>,
    pub tasks: Option<Vec<ProjectTask>>,
    /// `Some(null)` clears the icon.
    #[serde(default, with = "double_option")]
    pub icon: Option<Option<serde_json::Value>>,
    pub instructions: Option<String>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewContextItem {
    #[serde(default = "default_context_kind")]
    pub kind: String,
    pub content: String,
    pub title: String,
}

fn default_context_kind() -> String {
    "note".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSubscription {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub kind: String,
    pub name: String,
    pub schedule: Option<String>,
}

fn default_true() -> bool {
    true
}

pub struct Store {
    conn: Mutex<Connection>,
    seal: SqlSeal,
}

/// The plugin id (the sealing key's scope).
pub const PLUGIN_ID: &str = "@ryu/projects";
/// The registered content-store name (part of every key derivation; never rename).
pub const STORE: &str = "projects.db";

/// The sealed columns: every record body (`encb:v1:`, bound to
/// `<table>.body` and the row id). Tenant, project ids, schedule state and
/// timestamps stay plaintext for the tenant filter and the due-schedule claim.
pub fn column_plans() -> Result<Vec<ColumnPlan>> {
    ["projects", "context", "workers", "subscriptions"]
        .iter()
        .map(|table| ColumnPlan::text(table, "body", "id", KeyKind::Text))
        .collect()
}

impl Store {
    /// Open `<dir>/projects.db`, resolving this process's sealing key with
    /// `dir` as the plugin data dir (see [`crate::seal_keys`]).
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let keys = PluginKeys::resolve(PLUGIN_ID, dir.as_ref())?;
        Self::open_with_keys(dir, &keys)
    }

    /// [`Self::open`] with explicit keys.
    pub fn open_with_keys(dir: impl AsRef<Path>, keys: &PluginKeys) -> Result<Self> {
        std::fs::create_dir_all(dir.as_ref())
            .with_context(|| format!("creating {}", dir.as_ref().display()))?;
        let path = dir.as_ref().join(STORE);
        Self::from_connection(Connection::open(&path)?, keys, Some(&path))
    }

    /// An in-memory store sealing under a random key (tests).
    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        use base64::Engine as _;
        use rand::RngCore as _;
        let mut root = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut root);
        let keys = PluginKeys::sealing(
            ryu_crypto::PluginCipher::from_subkey_b64(
                PLUGIN_ID,
                &base64::engine::general_purpose::STANDARD.encode(root),
            )?,
            crate::seal_keys::KeySource::Delivered,
        );
        Self::from_connection(Connection::open_in_memory()?, &keys, None)
    }

    /// The sealing health item: `{state, detail?, unreadable_rows}`.
    pub fn seal_health(&self) -> serde_json::Value {
        self.seal.health()
    }

    fn from_connection(
        mut conn: Connection,
        keys: &PluginKeys,
        path: Option<&Path>,
    ) -> Result<Self> {
        // Before any statement that could rewrite a cell.
        ryu_crypto::content_sqlite::enable_secure_delete(&conn)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS projects (
               id TEXT PRIMARY KEY,
               tenant_id TEXT NOT NULL DEFAULT 'local',
               body TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS context (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               body TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS context_project ON context(project_id, updated_at DESC);
             CREATE TABLE IF NOT EXISTS workers (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               body TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS workers_project ON workers(project_id, updated_at DESC);
             CREATE TABLE IF NOT EXISTS subscriptions (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               tenant_id TEXT NOT NULL DEFAULT 'local',
               body TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1,
               next_run_at INTEGER,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS subscriptions_project ON subscriptions(project_id, updated_at DESC);",
        )?;
        let _ = conn.execute(
            "ALTER TABLE projects ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE subscriptions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'",
            [],
        );
        conn.execute(
            "CREATE INDEX IF NOT EXISTS projects_tenant ON projects(tenant_id, updated_at DESC)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS subscriptions_tenant ON subscriptions(tenant_id, updated_at DESC)",
            [],
        )?;
        let _ = conn.execute(
            "ALTER TABLE subscriptions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            [],
        );
        conn.execute(
            "CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions(enabled, next_run_at)",
            [],
        )?;
        let seal = open_store(&mut conn, keys, STORE, &column_plans()?, path)
            .context("sealing projects.db")?;
        Ok(Self {
            conn: Mutex::new(conn),
            seal,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("projects store lock poisoned"))
    }

    fn decode<T: DeserializeOwned>(value: String) -> Result<T> {
        serde_json::from_str(&value).context("decoding projects state")
    }

    pub fn list_projects(&self, tenant_id: &str) -> Result<Vec<Project>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT tenant_id, ryu_open('projects.body', id, body) FROM projects
             WHERE tenant_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |row| {
            let tenant: String = row.get(0)?;
            let mut project: Project = Self::decode(opened(row, 1)?)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            project.tenant_id = tenant;
            Ok(project)
        })?;
        collect_readable(rows).map_err(Into::into)
    }

    /// Every tenant's projects, for node-wide maintenance passes (the startup
    /// sync of project instructions to Core). Requests stay tenant-scoped.
    pub fn list_all_projects(&self) -> Result<Vec<Project>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT tenant_id, ryu_open('projects.body', id, body) FROM projects
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let tenant: String = row.get(0)?;
            let mut project: Project = Self::decode(opened(row, 1)?)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            project.tenant_id = tenant;
            Ok(project)
        })?;
        collect_readable(rows).map_err(Into::into)
    }

    pub fn get_project(&self, tenant_id: &str, id: &str) -> Result<Option<Project>> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT tenant_id, ryu_open('projects.body', id, body) FROM projects
                 WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, id],
                |row| Ok((row.get::<_, String>(0)?, opened(row, 1)?)),
            )
            .optional()?;
        row.map(|(tenant, body)| {
            let mut project: Project = Self::decode(body)?;
            project.tenant_id = tenant;
            Ok(project)
        })
        .transpose()
    }

    pub fn save_project(&self, project: &Project) -> Result<()> {
        let body = serde_json::to_string(project)?;
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO projects (id, tenant_id, body, created_at, updated_at)
             VALUES (?1, ?2, ryu_seal('projects.body', ?1, ?3), ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
             WHERE projects.tenant_id = excluded.tenant_id",
            params![
                project.id,
                project.tenant_id,
                body,
                project.created_at,
                project.updated_at
            ],
        )?;
        Ok(())
    }

    /// Merge a project imported from another node without allowing an older
    /// shared snapshot to roll back newer local state.
    pub fn import_project_if_newer(&self, project: &Project) -> Result<bool> {
        let body = serde_json::to_string(project)?;
        let conn = self.lock()?;
        let changed = conn.execute(
            "INSERT INTO projects (id, tenant_id, body, created_at, updated_at)
             VALUES (?1, ?2, ryu_seal('projects.body', ?1, ?3), ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
             WHERE excluded.tenant_id = projects.tenant_id
               AND excluded.updated_at > projects.updated_at",
            params![
                project.id,
                project.tenant_id,
                body,
                project.created_at,
                project.updated_at
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn delete_project(&self, tenant_id: &str, id: &str) -> Result<bool> {
        let conn = self.lock()?;
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute(
            "DELETE FROM projects WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, id],
        )?;
        if changed == 0 {
            tx.commit()?;
            return Ok(false);
        }
        tx.execute("DELETE FROM context WHERE project_id = ?1", params![id])?;
        tx.execute("DELETE FROM workers WHERE project_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM subscriptions WHERE project_id = ?1",
            params![id],
        )?;
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn list_context(&self, tenant_id: &str, project_id: &str) -> Result<Vec<ContextItem>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT ryu_open('context.body', c.id, c.body) FROM context c
             INNER JOIN projects p ON p.id = c.project_id AND p.tenant_id = ?1
             WHERE c.project_id = ?2 ORDER BY c.updated_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map(params![tenant_id, project_id], |row| opened(row, 0))?;
        collect_readable(rows)?
            .into_iter()
            .map(Self::decode)
            .collect()
    }

    pub fn save_context(&self, tenant_id: &str, item: &ContextItem) -> Result<()> {
        let body = serde_json::to_string(item)?;
        let conn = self.lock()?;
        let project_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE tenant_id = ?1 AND id = ?2)",
            params![tenant_id, item.project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            anyhow::bail!("project not found");
        }
        conn.execute(
            "INSERT INTO context (id, project_id, body, updated_at)
             VALUES (?1, ?2, ryu_seal('context.body', ?1, ?3), ?4)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![item.id, item.project_id, body, item.updated_at],
        )?;
        Ok(())
    }

    /// Merge one shared context item only when it is newer than the local copy.
    /// A project id mismatch never lets a colliding context id cross projects.
    pub fn import_context_if_newer(&self, tenant_id: &str, item: &ContextItem) -> Result<bool> {
        let body = serde_json::to_string(item)?;
        let conn = self.lock()?;
        let project_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE tenant_id = ?1 AND id = ?2)",
            params![tenant_id, item.project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            return Ok(false);
        }
        let changed = conn.execute(
            "INSERT INTO context (id, project_id, body, updated_at)
             VALUES (?1, ?2, ryu_seal('context.body', ?1, ?3), ?4)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
             WHERE excluded.updated_at > context.updated_at
               AND excluded.project_id = context.project_id",
            params![item.id, item.project_id, body, item.updated_at],
        )?;
        Ok(changed > 0)
    }

    pub fn delete_context(&self, tenant_id: &str, project_id: &str, id: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "DELETE FROM context
             WHERE project_id = ?2 AND id = ?3
               AND EXISTS (SELECT 1 FROM projects WHERE tenant_id = ?1 AND id = ?2)",
            params![tenant_id, project_id, id],
        )? > 0)
    }

    pub fn list_workers(&self, tenant_id: &str, project_id: &str) -> Result<Vec<Worker>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT ryu_open('workers.body', w.id, w.body) FROM workers w
             INNER JOIN projects p ON p.id = w.project_id AND p.tenant_id = ?1
             WHERE w.project_id = ?2 ORDER BY w.updated_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map(params![tenant_id, project_id], |row| opened(row, 0))?;
        collect_readable(rows)?
            .into_iter()
            .map(Self::decode)
            .collect()
    }

    pub fn save_worker(&self, tenant_id: &str, worker: &Worker) -> Result<()> {
        let body = serde_json::to_string(worker)?;
        let conn = self.lock()?;
        let project_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE tenant_id = ?1 AND id = ?2)",
            params![tenant_id, worker.project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            anyhow::bail!("project not found");
        }
        conn.execute(
            "INSERT INTO workers (id, project_id, body, updated_at)
             VALUES (?1, ?2, ryu_seal('workers.body', ?1, ?3), ?4)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![worker.id, worker.project_id, body, worker.updated_at],
        )?;
        Ok(())
    }

    pub fn list_subscriptions(
        &self,
        tenant_id: &str,
        project_id: &str,
    ) -> Result<Vec<Subscription>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT s.tenant_id, ryu_open('subscriptions.body', s.id, s.body) FROM subscriptions s
             INNER JOIN projects p ON p.id = s.project_id AND p.tenant_id = ?1
             WHERE s.project_id = ?2 ORDER BY s.updated_at DESC LIMIT 100",
        )?;
        let rows = stmt.query_map(params![tenant_id, project_id], |row| {
            let tenant: String = row.get(0)?;
            let mut subscription: Subscription = Self::decode(opened(row, 1)?)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            subscription.tenant_id = tenant;
            Ok(subscription)
        })?;
        collect_readable(rows).map_err(Into::into)
    }

    pub fn save_subscription(&self, sub: &Subscription) -> Result<()> {
        let body = serde_json::to_string(sub)?;
        let conn = self.lock()?;
        let project_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE tenant_id = ?1 AND id = ?2)",
            params![sub.tenant_id, sub.project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            anyhow::bail!("project not found");
        }
        conn.execute(
            "INSERT INTO subscriptions (id, project_id, tenant_id, body, enabled, next_run_at, updated_at)
             VALUES (?1, ?2, ?3, ryu_seal('subscriptions.body', ?1, ?4), ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at
             WHERE subscriptions.tenant_id = excluded.tenant_id",
            params![sub.id, sub.project_id, sub.tenant_id, body, sub.enabled, sub.next_run_at, sub.updated_at],
        )?;
        Ok(())
    }

    pub fn delete_subscription(&self, tenant_id: &str, project_id: &str, id: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "DELETE FROM subscriptions WHERE tenant_id = ?1 AND project_id = ?2 AND id = ?3",
            params![tenant_id, project_id, id],
        )? > 0)
    }

    pub fn claim_due_subscriptions(&self, now: i64) -> Result<Vec<Subscription>> {
        let conn = self.lock()?;
        let tx = conn.unchecked_transaction()?;
        let mut stmt = tx.prepare(
            "SELECT tenant_id, ryu_open('subscriptions.body', id, body) FROM subscriptions
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1 LIMIT 20",
        )?;
        let rows = stmt.query_map(params![now], |row| Ok((row.get(0)?, opened(row, 1)?)))?;
        let rows = collect_readable(rows)?;
        drop(stmt);
        let mut claimed = Vec::new();
        for (tenant_id, body) in rows {
            let mut sub: Subscription = Self::decode(body)?;
            sub.tenant_id = tenant_id;
            let interval = sub
                .schedule
                .as_deref()
                .and_then(|raw| humantime::parse_duration(raw).ok())
                .map(|value| value.as_millis().clamp(1_000, 31_536_000_000) as i64)
                .unwrap_or(3_600_000);
            sub.next_run_at = Some(now.saturating_add(interval));
            sub.last_run_at = Some(now);
            sub.last_status = Some("running".to_owned());
            sub.updated_at = now;
            let encoded = serde_json::to_string(&sub)?;
            tx.execute(
                "UPDATE subscriptions SET body = ryu_seal('subscriptions.body', ?2, ?3), next_run_at = ?4,
                 updated_at = ?5 WHERE tenant_id = ?1 AND id = ?2 AND next_run_at <= ?6",
                params![sub.tenant_id, sub.id, encoded, sub.next_run_at, sub.updated_at, now],
            )?;
            claimed.push(sub);
        }
        tx.commit()?;
        Ok(claimed)
    }

    pub fn mark_subscription(&self, tenant_id: &str, id: &str, status: &str) -> Result<()> {
        let conn = self.lock()?;
        let body: Option<String> = conn
            .query_row(
                "SELECT ryu_open('subscriptions.body', id, body) FROM subscriptions
                 WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, id],
                |row| opened(row, 0),
            )
            .optional()?;
        let Some(body) = body else {
            return Ok(());
        };
        let mut sub: Subscription = Self::decode(body)?;
        sub.last_status = Some(status.to_owned());
        sub.tenant_id = tenant_id.to_owned();
        sub.updated_at = now_ms();
        let encoded = serde_json::to_string(&sub)?;
        conn.execute(
            "UPDATE subscriptions SET body = ryu_seal('subscriptions.body', ?2, ?3), updated_at = ?4
             WHERE tenant_id = ?1 AND id = ?2",
            params![tenant_id, id, encoded, sub.updated_at],
        )?;
        Ok(())
    }

    pub fn snapshot(&self, tenant_id: &str, id: &str) -> Result<Option<ProjectSnapshot>> {
        let Some(project) = self.get_project(tenant_id, id)? else {
            return Ok(None);
        };
        Ok(Some(ProjectSnapshot {
            context: self.list_context(tenant_id, id)?,
            project,
            subscriptions: self.list_subscriptions(tenant_id, id)?,
            workers: self.list_workers(tenant_id, id)?,
        }))
    }
}

pub fn new_project(input: NewProject, tenant_id: &str) -> Project {
    let now = now_ms();
    Project {
        client: input.client.trim().to_owned(),
        coordinator_agent: input
            .coordinator_agent
            .filter(|value| !value.trim().is_empty()),
        coordinator_conversation_id: None,
        created_at: now,
        cwd: input.cwd.filter(|value| !value.trim().is_empty()),
        description: input.description.trim().to_owned(),
        due_date: input.due_date,
        execution_mode: input.execution_mode,
        id: input
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("project_{}", Uuid::new_v4().simple())),
        name: input.name.trim().to_owned(),
        owner: input.owner.trim().to_owned(),
        status: "planned".to_owned(),
        tasks: Vec::new(),
        updated_at: now,
        icon: input.icon.filter(|value| !value.is_null()),
        instructions: input.instructions.trim().to_owned(),
        members: Vec::new(),
        defaults: input.defaults,
        goal: input.goal.trim().to_owned(),
        brief_replies: None,
        tenant_id: tenant_id.to_owned(),
    }
}

pub fn new_context(project_id: &str, input: NewContextItem) -> ContextItem {
    ContextItem {
        content: input.content,
        id: format!("context_{}", Uuid::new_v4().simple()),
        kind: input.kind,
        project_id: project_id.to_owned(),
        title: input.title,
        updated_at: now_ms(),
    }
}

pub fn new_subscription(project_id: &str, tenant_id: &str, input: NewSubscription) -> Subscription {
    let now = now_ms();
    let next_run_at = next_run_at(input.enabled, &input.kind, input.schedule.as_deref(), now);
    Subscription {
        enabled: input.enabled,
        id: format!("sub_{}", Uuid::new_v4().simple()),
        kind: input.kind,
        last_run_at: None,
        last_status: None,
        name: input.name,
        next_run_at,
        project_id: project_id.to_owned(),
        schedule: input.schedule,
        updated_at: now,
        tenant_id: tenant_id.to_owned(),
    }
}

fn schedule_interval_ms(schedule: Option<&str>) -> i64 {
    schedule
        .and_then(|value| humantime::parse_duration(value).ok())
        .map(|value| value.as_millis().clamp(1_000, 31_536_000_000) as i64)
        .unwrap_or(3_600_000)
}

pub fn next_run_at(enabled: bool, kind: &str, schedule: Option<&str>, now: i64) -> Option<i64> {
    (enabled && kind == "schedule").then_some(now.saturating_add(schedule_interval_ms(schedule)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_context_and_subscription_round_trip() {
        let store = Store::memory().expect("store");
        let project = new_project(
            NewProject {
                client: "Northstar".to_owned(),
                coordinator_agent: None,
                cwd: Some("/tmp/project".to_owned()),
                description: "Ship the migration".to_owned(),
                due_date: String::new(),
                execution_mode: "auto".to_owned(),
                id: None,
                name: "Migration".to_owned(),
                owner: "Jiawei".to_owned(),
                icon: None,
                instructions: String::new(),
                defaults: Default::default(),
                goal: String::new(),
            },
            LOCAL_TENANT_ID,
        );
        store.save_project(&project).expect("save project");
        let context = new_context(
            &project.id,
            NewContextItem {
                content: "Prefer small pull requests.".to_owned(),
                kind: "decision".to_owned(),
                title: "Review rule".to_owned(),
            },
        );
        store
            .save_context(LOCAL_TENANT_ID, &context)
            .expect("save context");
        let subscription = new_subscription(
            &project.id,
            LOCAL_TENANT_ID,
            NewSubscription {
                enabled: true,
                kind: "schedule".to_owned(),
                name: "Morning pass".to_owned(),
                schedule: Some("1h".to_owned()),
            },
        );
        store
            .save_subscription(&subscription)
            .expect("save subscription");

        let snapshot = store
            .snapshot(LOCAL_TENANT_ID, &project.id)
            .expect("snapshot")
            .expect("project");
        assert_eq!(snapshot.project.name, "Migration");
        assert_eq!(snapshot.context[0].title, "Review rule");
        assert_eq!(snapshot.subscriptions[0].schedule.as_deref(), Some("1h"));
    }

    #[test]
    fn list_all_projects_spans_tenants() {
        let store = Store::memory().expect("store");
        for tenant in [LOCAL_TENANT_ID, "org:acme"] {
            let project = new_project(
                NewProject {
                    client: String::new(),
                    coordinator_agent: None,
                    cwd: None,
                    description: String::new(),
                    due_date: String::new(),
                    execution_mode: "auto".to_owned(),
                    id: None,
                    name: format!("{tenant} project"),
                    owner: String::new(),
                    icon: None,
                    instructions: "Cite sources.".to_owned(),
                    defaults: Default::default(),
                    goal: String::new(),
                },
                tenant,
            );
            store.save_project(&project).expect("save project");
        }
        let all = store.list_all_projects().expect("list all");
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|project| project.tenant_id == "org:acme"));
        assert_eq!(store.list_projects(LOCAL_TENANT_ID).unwrap().len(), 1);
    }

    #[test]
    fn due_schedule_is_claimed_once_and_advanced() {
        let store = Store::memory().expect("store");
        let project = new_project(
            NewProject {
                client: String::new(),
                coordinator_agent: None,
                cwd: None,
                description: String::new(),
                due_date: String::new(),
                execution_mode: "auto".to_owned(),
                id: None,
                name: "Scheduled".to_owned(),
                owner: String::new(),
                icon: None,
                instructions: String::new(),
                defaults: Default::default(),
                goal: String::new(),
            },
            LOCAL_TENANT_ID,
        );
        store.save_project(&project).expect("save project");
        let mut subscription = new_subscription(
            &project.id,
            LOCAL_TENANT_ID,
            NewSubscription {
                enabled: true,
                kind: "schedule".to_owned(),
                name: "Pass".to_owned(),
                schedule: Some("1s".to_owned()),
            },
        );
        subscription.next_run_at = Some(1);
        store
            .save_subscription(&subscription)
            .expect("save subscription");
        let claimed = store.claim_due_subscriptions(2).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert!(claimed[0].next_run_at.expect("next run") > 2);
        assert!(store
            .claim_due_subscriptions(2)
            .expect("second claim")
            .is_empty());
    }

    #[test]
    fn shared_imports_keep_newer_project_and_context_state() {
        let store = Store::memory().expect("store");
        let mut local = new_project(
            NewProject {
                client: String::new(),
                coordinator_agent: None,
                cwd: None,
                description: "Local".to_owned(),
                due_date: String::new(),
                execution_mode: "auto".to_owned(),
                id: Some("project-shared".to_owned()),
                name: "Local project".to_owned(),
                owner: String::new(),
                icon: None,
                instructions: String::new(),
                defaults: Default::default(),
                goal: String::new(),
            },
            LOCAL_TENANT_ID,
        );
        local.updated_at = 20;
        store.save_project(&local).expect("save local project");

        let mut stale = local.clone();
        stale.name = "Stale remote project".to_owned();
        stale.updated_at = 10;
        assert!(!store
            .import_project_if_newer(&stale)
            .expect("stale project import"));
        assert_eq!(
            store
                .get_project(LOCAL_TENANT_ID, "project-shared")
                .expect("read project")
                .unwrap()
                .name,
            "Local project"
        );

        let mut context = new_context(
            &local.id,
            NewContextItem {
                content: "new decision".to_owned(),
                kind: "decision".to_owned(),
                title: "Decision".to_owned(),
            },
        );
        context.id = "context-shared".to_owned();
        context.updated_at = 30;
        assert!(store
            .import_context_if_newer(LOCAL_TENANT_ID, &context)
            .expect("new context import"));
        context.content = "old decision".to_owned();
        context.updated_at = 25;
        assert!(!store
            .import_context_if_newer(LOCAL_TENANT_ID, &context)
            .expect("stale context import"));
        assert_eq!(
            store
                .list_context(LOCAL_TENANT_ID, &local.id)
                .expect("read context")[0]
                .content,
            "new decision"
        );
    }

    #[test]
    fn schedule_calculation_restarts_when_enabled_or_interval_changes() {
        assert_eq!(next_run_at(false, "schedule", Some("1h"), 100), None);
        assert_eq!(next_run_at(true, "webhook", Some("1h"), 100), None);
        assert_eq!(next_run_at(true, "schedule", Some("1s"), 100), Some(1_100));
        assert_eq!(
            next_run_at(true, "schedule", Some("2m"), 100),
            Some(120_100)
        );
    }

    #[test]
    fn project_records_are_isolated_by_tenant() {
        let store = Store::memory().expect("store");
        let first = new_project(
            NewProject {
                client: String::new(),
                coordinator_agent: None,
                cwd: None,
                description: String::new(),
                due_date: String::new(),
                execution_mode: "auto".to_owned(),
                id: Some("same-visible-id".to_owned()),
                name: "Org one".to_owned(),
                owner: "Alice".to_owned(),
                icon: None,
                instructions: String::new(),
                defaults: Default::default(),
                goal: String::new(),
            },
            "org:one",
        );
        let second = new_project(
            NewProject {
                client: String::new(),
                coordinator_agent: None,
                cwd: None,
                description: String::new(),
                due_date: String::new(),
                execution_mode: "auto".to_owned(),
                id: Some("other-id".to_owned()),
                name: "Org two".to_owned(),
                owner: "Bob".to_owned(),
                icon: None,
                instructions: String::new(),
                defaults: Default::default(),
                goal: String::new(),
            },
            "org:two",
        );
        store.save_project(&first).expect("first project");
        store.save_project(&second).expect("second project");
        let context = new_context(
            &first.id,
            NewContextItem {
                kind: "decision".into(),
                title: "Tenant-owned context".into(),
                content: "Keep this".into(),
            },
        );
        store.save_context("org:one", &context).unwrap();
        let subscription = new_subscription(
            &first.id,
            "org:one",
            NewSubscription {
                enabled: false,
                kind: "webhook".into(),
                name: "Tenant-owned subscription".into(),
                schedule: None,
            },
        );
        store.save_subscription(&subscription).unwrap();
        let worker = Worker {
            agent_id: None,
            conversation_id: None,
            created_at: 1,
            id: "worker-owned".into(),
            project_id: first.id.clone(),
            status: "pending".into(),
            task: "Local stored fixture".into(),
            title: "Tenant-owned worker".into(),
            updated_at: 1,
        };
        store.save_worker("org:one", &worker).unwrap();

        assert!(!store.delete_project("org:two", &first.id).unwrap());
        let snapshot = store.snapshot("org:one", &first.id).unwrap().unwrap();
        assert_eq!(snapshot.context.len(), 1);
        assert_eq!(snapshot.context[0].id, context.id);
        assert_eq!(snapshot.workers.len(), 1);
        assert_eq!(snapshot.workers[0].id, worker.id);
        assert_eq!(snapshot.subscriptions.len(), 1);
        assert_eq!(snapshot.subscriptions[0].id, subscription.id);

        assert_eq!(store.list_projects("org:one").unwrap().len(), 1);
        assert_eq!(store.list_projects("org:two").unwrap().len(), 1);
        assert!(store.get_project("org:two", &first.id).unwrap().is_none());
        assert!(store.get_project("org:one", &second.id).unwrap().is_none());
        assert!(store.delete_project("org:one", &first.id).unwrap());
        let conn = store.lock().unwrap();
        for table in ["context", "workers", "subscriptions"] {
            let remaining: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                    params![first.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(remaining, 0, "owner delete must remove {table}");
        }
    }

    mod at_rest {
        use super::*;
        use crate::seal_keys::KeySource;
        use base64::Engine as _;
        use ryu_crypto::{ContentCipher, PluginCipher};

        const CLIENT: &str = "Zebra Holdings";
        const NOTE: &str = "quokka-context-marker";

        fn keys(n: u8) -> PluginKeys {
            PluginKeys::sealing(
                PluginCipher::from_subkey_b64(
                    PLUGIN_ID,
                    &base64::engine::general_purpose::STANDARD.encode([n; 32]),
                )
                .unwrap(),
                KeySource::Delivered,
            )
        }

        fn dir() -> PathBuf {
            std::env::temp_dir().join(format!("ryu-projects-at-rest-{}", Uuid::new_v4()))
        }

        fn on_disk(dir: &Path, needle: &str) -> bool {
            let mut bytes = std::fs::read(dir.join(STORE)).unwrap_or_default();
            bytes.extend(std::fs::read(dir.join(format!("{STORE}-wal"))).unwrap_or_default());
            bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
        }

        fn seed(store: &Store) -> (String, String) {
            let project = new_project(
                NewProject {
                    client: CLIENT.to_owned(),
                    coordinator_agent: None,
                    cwd: None,
                    description: "Sealed project".to_owned(),
                    due_date: String::new(),
                    execution_mode: "auto".to_owned(),
                    id: None,
                    goal: String::new(),
                    name: "Migration".to_owned(),
                    owner: "Jiawei".to_owned(),
                    icon: None,
                    instructions: String::new(),
                    defaults: Default::default(),
                },
                LOCAL_TENANT_ID,
            );
            store.save_project(&project).unwrap();
            let first = new_context(
                &project.id,
                NewContextItem {
                    content: NOTE.to_owned(),
                    kind: "decision".to_owned(),
                    title: "Rule".to_owned(),
                },
            );
            store.save_context(LOCAL_TENANT_ID, &first).unwrap();
            let second = new_context(
                &project.id,
                NewContextItem {
                    content: "second".to_owned(),
                    kind: "note".to_owned(),
                    title: "Other".to_owned(),
                },
            );
            store.save_context(LOCAL_TENANT_ID, &second).unwrap();
            (project.id, first.id)
        }

        fn raw(dir: &Path) -> Vec<String> {
            let conn = Connection::open(dir.join(STORE)).unwrap();
            let mut stmt = conn
                .prepare("SELECT body FROM projects UNION ALL SELECT body FROM context")
                .unwrap();
            let mut rows: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows.sort();
            rows
        }

        #[test]
        fn bodies_are_sealed_on_disk_and_read_back() {
            let dir = dir();
            let store = Store::open_with_keys(&dir, &keys(1)).unwrap();
            let (project, _) = seed(&store);
            let snapshot = store.snapshot(LOCAL_TENANT_ID, &project).unwrap().unwrap();
            assert_eq!(snapshot.project.client, CLIENT);
            assert!(snapshot.context.iter().any(|item| item.content == NOTE));
            drop(store);
            assert!(!on_disk(&dir, CLIENT));
            assert!(!on_disk(&dir, NOTE));
            let conn = Connection::open(dir.join(STORE)).unwrap();
            let cipher = keys(1).content_cipher(STORE).unwrap();
            ryu_crypto::content_sqlite::assert_all_open(&conn, &cipher, &column_plans().unwrap())
                .unwrap();
        }

        #[test]
        fn legacy_bodies_are_sealed_once_and_still_read() {
            let dir = dir();
            let (project, _) = seed(&Store::open_with_keys(&dir, &PluginKeys::compat()).unwrap());
            assert!(on_disk(&dir, NOTE));
            let store = Store::open_with_keys(&dir, &keys(2)).unwrap();
            assert_eq!(
                store
                    .get_project(LOCAL_TENANT_ID, &project)
                    .unwrap()
                    .unwrap()
                    .client,
                CLIENT
            );
            drop(store);
            assert!(!on_disk(&dir, CLIENT));
            assert!(!on_disk(&dir, NOTE));
            let first = raw(&dir);
            assert!(first.iter().all(|body| ContentCipher::is_sealed_text(body)));
            drop(Store::open_with_keys(&dir, &keys(2)).unwrap());
            assert_eq!(raw(&dir), first);
        }

        #[test]
        fn a_copied_body_is_skipped_and_other_keys_refuse_writes() {
            let dir = dir();
            let store = Store::open_with_keys(&dir, &keys(3)).unwrap();
            let (project, first) = seed(&store);
            store
                .lock()
                .unwrap()
                .execute(
                    "UPDATE context SET body = (SELECT body FROM context WHERE id = ?1) WHERE id != ?1",
                    params![first],
                )
                .unwrap();
            let context = store.list_context(LOCAL_TENANT_ID, &project).unwrap();
            assert_eq!(context.len(), 1);
            assert_eq!(context[0].content, NOTE);
            assert_eq!(store.seal_health()["unreadable_rows"], 1);
            drop(store);
            for other in [keys(4), PluginKeys::compat()] {
                let wrong = Store::open_with_keys(&dir, &other).unwrap();
                assert_eq!(wrong.seal_health()["state"], "unhealthy");
                assert!(seed_project_only(&wrong).is_err());
            }
        }

        fn seed_project_only(store: &Store) -> Result<()> {
            let project = new_project(
                NewProject {
                    client: "x".to_owned(),
                    coordinator_agent: None,
                    cwd: None,
                    description: String::new(),
                    due_date: String::new(),
                    execution_mode: "auto".to_owned(),
                    id: None,
                    goal: String::new(),
                    name: "Refused".to_owned(),
                    owner: "x".to_owned(),
                    icon: None,
                    instructions: String::new(),
                    defaults: Default::default(),
                },
                LOCAL_TENANT_ID,
            );
            store.save_project(&project)
        }
    }
}
