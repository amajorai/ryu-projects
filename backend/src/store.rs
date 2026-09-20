use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;

pub fn data_dir() -> PathBuf {
    ryu_sidecar_runtime::ryu_dir().join("projects")
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
    /// Core-derived tenant key. It is never accepted from or returned to the UI.
    #[serde(skip)]
    pub tenant_id: String,
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
}

impl Store {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        std::fs::create_dir_all(dir.as_ref())
            .with_context(|| format!("creating {}", dir.as_ref().display()))?;
        Self::from_connection(Connection::open(dir.as_ref().join("projects.db"))?)
    }

    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
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
        Ok(Self {
            conn: Mutex::new(conn),
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
            "SELECT tenant_id, body FROM projects WHERE tenant_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |row| {
            let tenant: String = row.get(0)?;
            let mut project: Project = Self::decode(row.get(1)?)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            project.tenant_id = tenant;
            Ok(project)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_project(&self, tenant_id: &str, id: &str) -> Result<Option<Project>> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT tenant_id, body FROM projects WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
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
            "INSERT INTO projects (id, tenant_id, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
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
            "INSERT INTO projects (id, tenant_id, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
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
            "SELECT c.body FROM context c
             INNER JOIN projects p ON p.id = c.project_id AND p.tenant_id = ?1
             WHERE c.project_id = ?2 ORDER BY c.updated_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map(params![tenant_id, project_id], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| row.map_err(Into::into).and_then(Self::decode))
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
            "INSERT INTO context (id, project_id, body, updated_at) VALUES (?1, ?2, ?3, ?4)
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
            "INSERT INTO context (id, project_id, body, updated_at) VALUES (?1, ?2, ?3, ?4)
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
            "SELECT w.body FROM workers w
             INNER JOIN projects p ON p.id = w.project_id AND p.tenant_id = ?1
             WHERE w.project_id = ?2 ORDER BY w.updated_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map(params![tenant_id, project_id], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| row.map_err(Into::into).and_then(Self::decode))
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
            "INSERT INTO workers (id, project_id, body, updated_at) VALUES (?1, ?2, ?3, ?4)
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
            "SELECT s.tenant_id, s.body FROM subscriptions s
             INNER JOIN projects p ON p.id = s.project_id AND p.tenant_id = ?1
             WHERE s.project_id = ?2 ORDER BY s.updated_at DESC LIMIT 100",
        )?;
        let rows = stmt.query_map(params![tenant_id, project_id], |row| {
            let tenant: String = row.get(0)?;
            let mut subscription: Subscription = Self::decode(row.get(1)?)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            subscription.tenant_id = tenant;
            Ok(subscription)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
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
            "INSERT INTO subscriptions (id, project_id, tenant_id, body, enabled, next_run_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
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
            "SELECT tenant_id, body FROM subscriptions WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1 LIMIT 20",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
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
                "UPDATE subscriptions SET body = ?3, next_run_at = ?4, updated_at = ?5 WHERE tenant_id = ?1 AND id = ?2 AND next_run_at <= ?6",
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
                "SELECT body FROM subscriptions WHERE tenant_id = ?1 AND id = ?2",
                params![tenant_id, id],
                |row| row.get(0),
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
            "UPDATE subscriptions SET body = ?3, updated_at = ?4 WHERE tenant_id = ?1 AND id = ?2",
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
            },
            "org:two",
        );
        store.save_project(&first).expect("first project");
        store.save_project(&second).expect("second project");

        assert_eq!(store.list_projects("org:one").unwrap().len(), 1);
        assert_eq!(store.list_projects("org:two").unwrap().len(), 1);
        assert!(store.get_project("org:two", &first.id).unwrap().is_none());
        assert!(store.get_project("org:one", &second.id).unwrap().is_none());
    }
}
