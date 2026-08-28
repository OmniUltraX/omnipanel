//! 个人待办（Microsoft To Do 对齐）：列表 / 任务 / 步骤。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::knowledge_todo::KnowledgeTodoItem;
use crate::storage::{Storage, map_sqlite};

/// 自定义待办列表。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoList {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    #[specta(type = f64)]
    pub sort_order: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub created_at: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub updated_at: i64,
}

/// 任务步骤。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoStep {
    pub id: String,
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    #[specta(type = f64)]
    pub sort_order: i64,
}

/// 重复规则（JSON 存库）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoRecurrence {
    /// daily | weekdays | weekly | monthly | yearly | custom
    pub freq: String,
    #[serde(default)]
    pub interval: i32,
}

/// 个人待办任务。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoTask {
    pub id: String,
    pub list_id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub important: bool,
    /// 加入「我的一天」的日历日（YYYY-MM-DD）；非今日则智能列表不展示。
    #[serde(default)]
    pub my_day_on: Option<String>,
    #[serde(default)]
    #[specta(type = f64)]
    pub due_at: Option<i64>,
    #[serde(default)]
    #[specta(type = f64)]
    pub remind_at: Option<i64>,
    #[serde(default)]
    pub recurrence: Option<TodoRecurrence>,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    #[specta(type = f64)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    #[specta(type = f64)]
    pub sort_order: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub created_at: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub updated_at: i64,
    /// 列表查询时填充；保存时可一并替换。
    #[serde(default)]
    pub steps: Vec<TodoStep>,
    #[serde(default)]
    #[specta(type = f64)]
    pub steps_total: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub steps_done: i64,
}

/// 任务查询：智能视图或自定义列表。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoTaskQuery {
    /// myDay | important | planned | tasks | list
    pub view: String,
    #[serde(default)]
    pub list_id: Option<String>,
    #[serde(default)]
    pub include_completed: bool,
    /// 本地日历日 YYYY-MM-DD（我的一天过滤用）；缺省则用服务端 UTC 日。
    #[serde(default)]
    pub today: Option<String>,
}

fn today_ymd() -> String {
    // 本地日历日：用 UTC+偏移近似；前端也会传，此处作服务端过滤兜底。
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    // 不引入 chrono：用简单 UTC 日期；UI 以本地 my_day_on 写入为准。
    let days = secs / 86_400;
    // 1970-01-01 起算的粗略公历（足够用于「今日」过滤一致性测试；生产由前端写本地 YYYY-MM-DD）
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant civil_from_days（UTC）
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn encode_recurrence(r: &Option<TodoRecurrence>) -> OmniResult<String> {
    match r {
        None => Ok(String::new()),
        Some(v) => serde_json::to_string(v).map_err(|e| {
            OmniError::new(ErrorCode::InvalidInput, "recurrence 序列化失败")
                .with_cause(e.to_string())
        }),
    }
}

fn decode_recurrence(raw: &str) -> Option<TodoRecurrence> {
    if raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str(raw).ok()
}

const TASK_SELECT: &str =
    "SELECT t.id, t.list_id, t.title, t.note, t.important, t.my_day_on, t.due_at, t.remind_at,
        t.recurrence, t.completed, t.completed_at, t.sort_order, t.created_at, t.updated_at,
        (SELECT COUNT(*) FROM todo_steps s WHERE s.task_id = t.id),
        (SELECT COUNT(*) FROM todo_steps s WHERE s.task_id = t.id AND s.done = 1)
 FROM todo_tasks t";

impl Storage {
    /// 确保默认任务箱存在；必要时从 knowledge_todo 迁移。
    pub fn ensure_todo_schema_data(&self) -> OmniResult<()> {
        self.migrate_knowledge_todos_into_todo()?;
        self.ensure_default_todo_list()?;
        Ok(())
    }

    fn ensure_default_todo_list(&self) -> OmniResult<()> {
        let count: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM todo_lists WHERE is_default = 1",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        if count > 0 {
            return Ok(());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        self.conn()
            .execute(
                "INSERT INTO todo_lists (id, title, is_default, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, 1, 0, ?3, ?3)",
                rusqlite::params!["todo-default", "任务", now],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 按列表 id 增量迁移旧 knowledge_todo（已存在的 id 跳过）。
    fn migrate_knowledge_todos_into_todo(&self) -> OmniResult<()> {
        let old_exists: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='knowledge_todo_lists'",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        if old_exists == 0 {
            return Ok(());
        }
        let old = self.list_knowledge_todos()?;
        if old.is_empty() {
            return Ok(());
        }
        let has_any_default: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM todo_lists WHERE is_default = 1",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        let tx = self.conn().unchecked_transaction().map_err(map_sqlite)?;
        for (idx, list) in old.iter().enumerate() {
            let exists: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM todo_lists WHERE id = ?1",
                    [&list.id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite)?;
            if exists > 0 {
                continue;
            }
            let is_default = has_any_default == 0 && idx == 0;
            tx.execute(
                "INSERT INTO todo_lists (id, title, is_default, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    list.id,
                    list.title,
                    if is_default { 1 } else { 0 },
                    list.sort_order,
                    list.created_at,
                    list.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
            for (i, item) in list.items.iter().enumerate() {
                let note = migrate_item_note(
                    item,
                    if i == 0 {
                        list.description.as_str()
                    } else {
                        ""
                    },
                );
                let completed = if item.done { 1 } else { 0 };
                let completed_at = if item.done {
                    Some(list.updated_at)
                } else {
                    None
                };
                tx.execute(
                    "INSERT OR IGNORE INTO todo_tasks (
                        id, list_id, title, note, important, my_day_on, due_at, remind_at,
                        recurrence, completed, completed_at, sort_order, created_at, updated_at
                     ) VALUES (?1,?2,?3,?4,0,NULL,NULL,NULL,'',?5,?6,?7,?8,?9)",
                    rusqlite::params![
                        item.id,
                        list.id,
                        if item.name.is_empty() {
                            "未命名任务"
                        } else {
                            &item.name
                        },
                        note,
                        completed,
                        completed_at,
                        i as i64,
                        list.created_at,
                        list.updated_at,
                    ],
                )
                .map_err(map_sqlite)?;
            }
        }
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn list_todo_lists(&self) -> OmniResult<Vec<TodoList>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, title, is_default, sort_order, created_at, updated_at
                 FROM todo_lists
                 ORDER BY is_default DESC, sort_order ASC, updated_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TodoList {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    is_default: row.get::<_, i64>(2)? != 0,
                    sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    pub fn save_todo_list(&self, list: &TodoList) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO todo_lists (id, title, is_default, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    is_default = excluded.is_default,
                    sort_order = excluded.sort_order,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    list.id,
                    list.title,
                    if list.is_default { 1 } else { 0 },
                    list.sort_order,
                    list.created_at,
                    list.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn delete_todo_list(&self, id: &str) -> OmniResult<()> {
        let is_default: i64 = self
            .conn()
            .query_row(
                "SELECT is_default FROM todo_lists WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if is_default != 0 {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "不能删除默认任务箱",
            ));
        }
        let tx = self.conn().unchecked_transaction().map_err(map_sqlite)?;
        tx.execute("DELETE FROM todo_steps WHERE task_id IN (SELECT id FROM todo_tasks WHERE list_id = ?1)", [id])
            .map_err(map_sqlite)?;
        tx.execute("DELETE FROM todo_tasks WHERE list_id = ?1", [id])
            .map_err(map_sqlite)?;
        tx.execute("DELETE FROM todo_lists WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn get_default_todo_list_id(&self) -> OmniResult<String> {
        self.ensure_default_todo_list()?;
        self.conn()
            .query_row(
                "SELECT id FROM todo_lists WHERE is_default = 1 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)
    }

    pub fn list_todo_tasks(&self, query: &TodoTaskQuery) -> OmniResult<Vec<TodoTask>> {
        let today = query
            .today
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(today_ymd);
        let include = query.include_completed;
        match query.view.as_str() {
            "myDay" => {
                let mut sql = String::from(TASK_SELECT);
                sql.push_str(" WHERE t.my_day_on = ?1");
                if !include {
                    sql.push_str(" AND t.completed = 0");
                }
                sql.push_str(" ORDER BY t.completed ASC, t.sort_order ASC, t.updated_at DESC");
                self.query_todo_tasks(&sql, rusqlite::params![today])
            }
            "important" => {
                let mut sql = String::from(TASK_SELECT);
                sql.push_str(" WHERE t.important = 1");
                if !include {
                    sql.push_str(" AND t.completed = 0");
                }
                sql.push_str(" ORDER BY t.completed ASC, t.sort_order ASC, t.updated_at DESC");
                self.query_todo_tasks(&sql, [])
            }
            "planned" => {
                let mut sql = String::from(TASK_SELECT);
                sql.push_str(" WHERE t.due_at IS NOT NULL");
                if !include {
                    sql.push_str(" AND t.completed = 0");
                }
                sql.push_str(" ORDER BY t.completed ASC, t.due_at ASC, t.sort_order ASC");
                self.query_todo_tasks(&sql, [])
            }
            "tasks" => {
                let list_id = self.get_default_todo_list_id()?;
                let mut sql = String::from(TASK_SELECT);
                sql.push_str(" WHERE t.list_id = ?1");
                if !include {
                    sql.push_str(" AND t.completed = 0");
                }
                sql.push_str(" ORDER BY t.completed ASC, t.sort_order ASC, t.updated_at DESC");
                self.query_todo_tasks(&sql, rusqlite::params![list_id])
            }
            "list" => {
                let list_id = query.list_id.clone().ok_or_else(|| {
                    OmniError::new(ErrorCode::InvalidInput, "list 视图需要 listId")
                })?;
                let mut sql = String::from(TASK_SELECT);
                sql.push_str(" WHERE t.list_id = ?1");
                if !include {
                    sql.push_str(" AND t.completed = 0");
                }
                sql.push_str(" ORDER BY t.completed ASC, t.sort_order ASC, t.updated_at DESC");
                self.query_todo_tasks(&sql, rusqlite::params![list_id])
            }
            other => Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知待办视图: {other}"),
            )),
        }
    }

    fn query_todo_tasks<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> OmniResult<Vec<TodoTask>> {
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params, |row| map_task_row(row))
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    pub fn get_todo_task(&self, id: &str) -> OmniResult<Option<TodoTask>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT t.id, t.list_id, t.title, t.note, t.important, t.my_day_on, t.due_at, t.remind_at,
                        t.recurrence, t.completed, t.completed_at, t.sort_order, t.created_at, t.updated_at,
                        (SELECT COUNT(*) FROM todo_steps s WHERE s.task_id = t.id),
                        (SELECT COUNT(*) FROM todo_steps s WHERE s.task_id = t.id AND s.done = 1)
                 FROM todo_tasks t WHERE t.id = ?1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt
            .query_map([id], |row| map_task_row(row))
            .map_err(map_sqlite)?;
        let Some(task) = rows.next() else {
            return Ok(None);
        };
        let mut task = task.map_err(map_sqlite)?;
        task.steps = self.list_todo_steps(id)?;
        Ok(Some(task))
    }

    /// 保存任务。`replace_steps=true` 时用 `task.steps` 整表替换步骤。
    pub fn save_todo_task(&self, task: &TodoTask, replace_steps: bool) -> OmniResult<()> {
        let recurrence = encode_recurrence(&task.recurrence)?;
        let tx = self.conn().unchecked_transaction().map_err(map_sqlite)?;
        tx.execute(
            "INSERT INTO todo_tasks (
                id, list_id, title, note, important, my_day_on, due_at, remind_at,
                recurrence, completed, completed_at, sort_order, created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET
                list_id = excluded.list_id,
                title = excluded.title,
                note = excluded.note,
                important = excluded.important,
                my_day_on = excluded.my_day_on,
                due_at = excluded.due_at,
                remind_at = excluded.remind_at,
                recurrence = excluded.recurrence,
                completed = excluded.completed,
                completed_at = excluded.completed_at,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at",
            rusqlite::params![
                task.id,
                task.list_id,
                task.title,
                task.note,
                if task.important { 1 } else { 0 },
                task.my_day_on,
                task.due_at,
                task.remind_at,
                recurrence,
                if task.completed { 1 } else { 0 },
                task.completed_at,
                task.sort_order,
                task.created_at,
                task.updated_at,
            ],
        )
        .map_err(map_sqlite)?;

        if replace_steps {
            tx.execute("DELETE FROM todo_steps WHERE task_id = ?1", [&task.id])
                .map_err(map_sqlite)?;
            for step in &task.steps {
                tx.execute(
                    "INSERT INTO todo_steps (id, task_id, title, done, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        step.id,
                        task.id,
                        step.title,
                        if step.done { 1 } else { 0 },
                        step.sort_order,
                    ],
                )
                .map_err(map_sqlite)?;
            }
        }
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn delete_todo_task(&self, id: &str) -> OmniResult<()> {
        let tx = self.conn().unchecked_transaction().map_err(map_sqlite)?;
        tx.execute("DELETE FROM todo_steps WHERE task_id = ?1", [id])
            .map_err(map_sqlite)?;
        tx.execute("DELETE FROM todo_tasks WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn list_todo_steps(&self, task_id: &str) -> OmniResult<Vec<TodoStep>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, task_id, title, done, sort_order FROM todo_steps
                 WHERE task_id = ?1 ORDER BY sort_order ASC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([task_id], |row| {
                Ok(TodoStep {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    title: row.get(2)?,
                    done: row.get::<_, i64>(3)? != 0,
                    sort_order: row.get(4)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    pub fn save_todo_step(&self, step: &TodoStep) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO todo_steps (id, task_id, title, done, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    done = excluded.done,
                    sort_order = excluded.sort_order",
                rusqlite::params![
                    step.id,
                    step.task_id,
                    step.title,
                    if step.done { 1 } else { 0 },
                    step.sort_order,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn delete_todo_step(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM todo_steps WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }
}

fn migrate_item_note(item: &KnowledgeTodoItem, list_desc: &str) -> String {
    let mut parts = Vec::new();
    if !list_desc.is_empty() {
        parts.push(list_desc.to_string());
    }
    if !item.description.is_empty() {
        parts.push(item.description.clone());
    }
    if !item.executor.is_empty() {
        parts.push(format!("执行者: {}", item.executor));
    }
    parts.join("\n")
}

fn map_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TodoTask> {
    let recurrence_raw: String = row.get(8)?;
    Ok(TodoTask {
        id: row.get(0)?,
        list_id: row.get(1)?,
        title: row.get(2)?,
        note: row.get(3)?,
        important: row.get::<_, i64>(4)? != 0,
        my_day_on: row.get(5)?,
        due_at: row.get(6)?,
        remind_at: row.get(7)?,
        recurrence: decode_recurrence(&recurrence_raw),
        completed: row.get::<_, i64>(9)? != 0,
        completed_at: row.get(10)?,
        sort_order: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        steps: Vec::new(),
        steps_total: row.get(14)?,
        steps_done: row.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task(id: &str, list_id: &str, title: &str) -> TodoTask {
        TodoTask {
            id: id.into(),
            list_id: list_id.into(),
            title: title.into(),
            note: String::new(),
            important: false,
            my_day_on: None,
            due_at: None,
            remind_at: None,
            recurrence: None,
            completed: false,
            completed_at: None,
            sort_order: 0,
            created_at: 1,
            updated_at: 1,
            steps: vec![],
            steps_total: 0,
            steps_done: 0,
        }
    }

    #[test]
    fn default_list_and_crud() {
        let storage = Storage::open_in_memory().unwrap();
        storage.ensure_todo_schema_data().unwrap();
        let lists = storage.list_todo_lists().unwrap();
        assert_eq!(lists.len(), 1);
        assert!(lists[0].is_default);

        let list_id = lists[0].id.clone();
        let mut task = sample_task("t1", &list_id, "写方案");
        task.important = true;
        task.steps = vec![TodoStep {
            id: "s1".into(),
            task_id: "t1".into(),
            title: "草稿".into(),
            done: false,
            sort_order: 0,
        }];
        storage.save_todo_task(&task, true).unwrap();

        let important = storage
            .list_todo_tasks(&TodoTaskQuery {
                view: "important".into(),
                list_id: None,
                include_completed: false,
                today: None,
            })
            .unwrap();
        assert_eq!(important.len(), 1);
        assert_eq!(important[0].steps_total, 1);

        let got = storage.get_todo_task("t1").unwrap().unwrap();
        assert_eq!(got.steps.len(), 1);
        assert_eq!(got.steps[0].title, "草稿");

        storage.delete_todo_task("t1").unwrap();
        assert!(storage.get_todo_task("t1").unwrap().is_none());
    }

    #[test]
    fn my_day_and_planned_filters() {
        let storage = Storage::open_in_memory().unwrap();
        storage.ensure_todo_schema_data().unwrap();
        let list_id = storage.get_default_todo_list_id().unwrap();
        let today = today_ymd();

        let mut a = sample_task("a", &list_id, "今天");
        a.my_day_on = Some(today.clone());
        storage.save_todo_task(&a, false).unwrap();

        let mut b = sample_task("b", &list_id, "截止");
        b.due_at = Some(1_700_000_000_000);
        storage.save_todo_task(&b, false).unwrap();

        let my_day = storage
            .list_todo_tasks(&TodoTaskQuery {
                view: "myDay".into(),
                list_id: None,
                include_completed: false,
                today: Some(today),
            })
            .unwrap();
        assert_eq!(my_day.len(), 1);
        assert_eq!(my_day[0].id, "a");

        let planned = storage
            .list_todo_tasks(&TodoTaskQuery {
                view: "planned".into(),
                list_id: None,
                include_completed: false,
                today: None,
            })
            .unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].id, "b");
    }

    #[test]
    fn migrates_from_knowledge_todo() {
        let storage = Storage::open_in_memory().unwrap();
        use crate::knowledge_todo::{KnowledgeTodoItem, KnowledgeTodoList};
        storage
            .save_knowledge_todo(&KnowledgeTodoList {
                id: "old-list".into(),
                title: "旧列表".into(),
                description: "列表描述".into(),
                items: vec![KnowledgeTodoItem {
                    id: "old-item".into(),
                    name: "旧任务".into(),
                    executor: "运维".into(),
                    description: "检查磁盘".into(),
                    done: false,
                }],
                sort_order: 0,
                created_at: 10,
                updated_at: 20,
            })
            .unwrap();
        storage.ensure_todo_schema_data().unwrap();
        let lists = storage.list_todo_lists().unwrap();
        assert!(lists.iter().any(|l| l.id == "old-list"));
        let tasks = storage
            .list_todo_tasks(&TodoTaskQuery {
                view: "list".into(),
                list_id: Some("old-list".into()),
                include_completed: true,
                today: None,
            })
            .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "旧任务");
        assert!(tasks[0].note.contains("检查磁盘"));
        assert!(tasks[0].note.contains("执行者"));
    }
}
