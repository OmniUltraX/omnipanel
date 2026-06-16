use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};

/// 待办列表中的单项。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeTodoItem {
    pub id: String,
    pub text: String,
    pub done: bool,
}

/// 知识库待办列表。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeTodoList {
    pub id: String,
    pub title: String,
    pub items: Vec<KnowledgeTodoItem>,
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

impl Storage {
    /// 列出全部待办列表（按 sort_order、更新时间排序）。
    pub fn list_knowledge_todos(&self) -> OmniResult<Vec<KnowledgeTodoList>> {
        self.query_knowledge_todos(
            "SELECT id, title, items, sort_order, created_at, updated_at
             FROM knowledge_todo_lists
             ORDER BY sort_order ASC, updated_at DESC",
            [],
        )
    }

    /// 按 id 获取待办列表。
    pub fn get_knowledge_todo(&self, id: &str) -> OmniResult<Option<KnowledgeTodoList>> {
        Ok(self
            .query_knowledge_todos(
                "SELECT id, title, items, sort_order, created_at, updated_at
                 FROM knowledge_todo_lists WHERE id = ?1",
                [id],
            )?
            .into_iter()
            .next())
    }

    /// 插入或更新待办列表。
    pub fn save_knowledge_todo(&self, list: &KnowledgeTodoList) -> OmniResult<()> {
        let items_json = serde_json::to_string(&list.items).map_err(|e| {
            OmniError::new(ErrorCode::InvalidInput, "items 序列化失败").with_cause(e.to_string())
        })?;
        self.conn()
            .execute(
                "INSERT INTO knowledge_todo_lists (id, title, items, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                items = excluded.items,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at",
                rusqlite::params![
                    list.id,
                    list.title,
                    items_json,
                    list.sort_order,
                    list.created_at,
                    list.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 删除待办列表。
    pub fn delete_knowledge_todo(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM knowledge_todo_lists WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    fn query_knowledge_todos<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> OmniResult<Vec<KnowledgeTodoList>> {
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params, |row| {
                let items_json: String = row.get(2)?;
                let items: Vec<KnowledgeTodoItem> =
                    serde_json::from_str(&items_json).unwrap_or_default();
                Ok(KnowledgeTodoList {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    items,
                    sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for list in rows {
            out.push(list.map_err(map_sqlite)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn sample_list(id: &str, title: &str) -> KnowledgeTodoList {
        KnowledgeTodoList {
            id: id.to_string(),
            title: title.to_string(),
            items: vec![
                KnowledgeTodoItem {
                    id: "i1".to_string(),
                    text: "任务一".to_string(),
                    done: false,
                },
                KnowledgeTodoItem {
                    id: "i2".to_string(),
                    text: "任务二".to_string(),
                    done: true,
                },
            ],
            sort_order: 0,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn save_and_list_knowledge_todos() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_knowledge_todo(&sample_list("t1", "列表 A"))
            .unwrap();
        storage
            .save_knowledge_todo(&sample_list("t2", "列表 B"))
            .unwrap();
        let all = storage.list_knowledge_todos().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "列表 A");
        assert_eq!(all[0].items.len(), 2);
    }

    #[test]
    fn get_knowledge_todo_roundtrip() {
        let storage = Storage::open_in_memory().unwrap();
        let list = sample_list("t1", "我的待办");
        storage.save_knowledge_todo(&list).unwrap();
        let got = storage.get_knowledge_todo("t1").unwrap().unwrap();
        assert_eq!(got.title, "我的待办");
        assert_eq!(got.items[1].done, true);
    }

    #[test]
    fn delete_knowledge_todo() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_knowledge_todo(&sample_list("t1", "待删除"))
            .unwrap();
        storage.delete_knowledge_todo("t1").unwrap();
        assert!(storage.get_knowledge_todo("t1").unwrap().is_none());
    }
}
