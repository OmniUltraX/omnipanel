use std::collections::BTreeSet;

use async_trait::async_trait;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{ClientOptions, ServerAddress};
use mongodb::{Client, Collection};
use omnipanel_error::{OmniError, OmniResult};
use serde_json::{Map, Value};

use crate::{DbDriver, DbParams, QueryResult, is_query};

const DEFAULT_MONGO_PORT: u16 = 27017;
const DEFAULT_SAMPLE_LIMIT: i64 = 200;

pub struct MongoDriver {
    client: Client,
    database: String,
}

impl MongoDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let options = build_client_options(params)?;
        let client = Client::with_options(options)
            .map_err(|e| OmniError::connection("MongoDB 连接失败").with_cause(e.to_string()))?;
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| OmniError::connection("MongoDB 连接失败").with_cause(e.to_string()))?;

        let database = params.database.trim();
        if database.is_empty() {
            return Err(OmniError::invalid_input("未指定数据库"));
        }

        Ok(Self {
            client,
            database: database.to_string(),
        })
    }

    pub async fn list_databases(params: &DbParams) -> OmniResult<Vec<String>> {
        let options = build_client_options(params)?;
        let client = Client::with_options(options)
            .map_err(|e| OmniError::connection("MongoDB 连接失败").with_cause(e.to_string()))?;
        let names = client
            .list_database_names()
            .await
            .map_err(map_mongo_err)?;
        Ok(names.into_iter().filter(|name| !name.is_empty()).collect())
    }

    pub async fn infer_column_names(&self, collection: &str, sample_limit: i64) -> OmniResult<Vec<String>> {
        let limit = sample_limit.clamp(1, DEFAULT_SAMPLE_LIMIT);
        let result = self.preview(collection, limit, 0, None, None).await?;
        Ok(result.columns)
    }

    fn collection(&self, name: &str) -> Collection<Document> {
        self.client.database(&self.database).collection(name)
    }
}

#[async_trait]
impl DbDriver for MongoDriver {
    async fn version(&self) -> OmniResult<String> {
        let admin = self.client.database("admin");
        let info = admin
            .run_command(doc! { "buildInfo": 1 })
            .await
            .map_err(map_mongo_err)?;
        Ok(info
            .get_str("version")
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "MongoDB".to_string()))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let db = self.client.database(&self.database);
        let mut names = db
            .list_collection_names()
            .await
            .map_err(map_mongo_err)?;
        names.sort_by(|a, b| a.cmp(b));
        Ok(names)
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            return Err(OmniError::invalid_input("SQL 不能为空"));
        }
        if is_query(trimmed) {
            return Err(OmniError::invalid_input(
                "MongoDB 暂不支持 SQL 查询，请使用集合预览浏览数据",
            ));
        }
        Err(OmniError::invalid_input(
            "MongoDB 暂不支持通过 SQL 执行写入，请使用专用 API",
        ))
    }

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        if where_clause.is_some_and(|clause| !clause.trim().is_empty()) {
            return Err(OmniError::invalid_input(
                "MongoDB 集合预览暂不支持 WHERE 过滤",
            ));
        }

        let limit = limit.clamp(1, DEFAULT_SAMPLE_LIMIT);
        let offset = offset.max(0);
        let collection = self.collection(table);
        let mut options = mongodb::options::FindOptions::builder()
            .limit(limit)
            .skip(u64::try_from(offset).unwrap_or(0))
            .build();
        if let Some(order) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
            let field = order
                .split_whitespace()
                .next()
                .unwrap_or(order)
                .trim_matches('"')
                .trim_matches('`');
            options.sort = Some(doc! { field: 1 });
        }

        let mut cursor = collection
            .find(doc! {})
            .with_options(options)
            .await
            .map_err(map_mongo_err)?;

        let mut docs = Vec::new();
        while cursor.advance().await.map_err(map_mongo_err)? {
            docs.push(cursor.deserialize_current().map_err(map_mongo_err)?);
        }

        let columns = collect_document_columns(&docs);
        let rows = docs
            .into_iter()
            .map(|doc| document_to_row(&doc, &columns))
            .collect();

        Ok(QueryResult {
            columns,
            rows,
            rows_affected: 0,
        })
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        if where_clause.is_some_and(|clause| !clause.trim().is_empty()) {
            return Err(OmniError::invalid_input(
                "MongoDB 集合计数暂不支持 WHERE 过滤",
            ));
        }
        let count = self
            .collection(table)
            .count_documents(doc! {})
            .await
            .map_err(map_mongo_err)?;
        Ok(i64::try_from(count).unwrap_or(i64::MAX))
    }
}

fn build_client_options(params: &DbParams) -> OmniResult<ClientOptions> {
    let port = if params.port == 0 {
        DEFAULT_MONGO_PORT
    } else {
        params.port
    };
    let host = if params.host.trim().is_empty() {
        "localhost".to_string()
    } else {
        params.host.trim().to_string()
    };

    let mut options = ClientOptions::builder()
        .hosts(vec![ServerAddress::Tcp {
            host,
            port: Some(port),
        }])
        .app_name("OmniPanel".to_string())
        .build();

    if !params.user.trim().is_empty() {
        options.credential = Some(
            mongodb::options::Credential::builder()
                .username(params.user.trim().to_string())
                .password(params.password.clone())
                .build(),
        );
    } else if !params.password.is_empty() {
        options.credential = Some(
            mongodb::options::Credential::builder()
                .password(params.password.clone())
                .build(),
        );
    }

    if params.ssl {
        options.tls = Some(mongodb::options::Tls::Enabled(
            mongodb::options::TlsOptions::builder().build(),
        ));
    }

    Ok(options)
}

fn collect_document_columns(docs: &[Document]) -> Vec<String> {
    let mut columns = BTreeSet::new();
    columns.insert("_id".to_string());
    for doc in docs {
        for key in doc.keys() {
            columns.insert(key.clone());
        }
    }
    columns.into_iter().collect()
}

fn document_to_row(doc: &Document, columns: &[String]) -> Vec<Value> {
    columns
        .iter()
        .map(|column| bson_field_to_json(doc.get(column)))
        .collect()
}

fn bson_field_to_json(value: Option<&Bson>) -> Value {
    match value {
        None | Some(Bson::Null) => Value::Null,
        Some(other) => bson_to_json(other),
    }
}

fn bson_to_json(value: &Bson) -> Value {
    match value {
        Bson::Null => Value::Null,
        Bson::Boolean(v) => Value::Bool(*v),
        Bson::Int32(v) => Value::Number((*v).into()),
        Bson::Int64(v) => Value::Number((*v).into()),
        Bson::Double(v) => serde_json::Number::from_f64(*v)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(v) => Value::String(v.clone()),
        Bson::ObjectId(v) => Value::String(v.to_hex()),
        Bson::DateTime(v) => Value::String(v.to_string()),
        Bson::Timestamp(v) => Value::String(format!("{}:{}", v.time, v.increment)),
        Bson::Binary(v) => Value::String(format!("<Binary {} bytes>", v.bytes.len())),
        Bson::RegularExpression(v) => Value::String(v.pattern.to_string()),
        Bson::JavaScriptCode(v) => Value::String(v.clone()),
        Bson::JavaScriptCodeWithScope(v) => Value::String(v.code.clone()),
        Bson::Symbol(v) => Value::String(v.clone()),
        Bson::Decimal128(v) => Value::String(v.to_string()),
        Bson::Array(items) => Value::Array(items.iter().map(bson_to_json).collect()),
        Bson::Document(doc) => {
            let mut map = Map::new();
            for (key, item) in doc {
                map.insert(key.clone(), bson_to_json(item));
            }
            Value::Object(map)
        }
        Bson::Undefined | Bson::MaxKey | Bson::MinKey | Bson::DbPointer(_) => Value::Null,
    }
}

fn map_mongo_err(err: mongodb::error::Error) -> OmniError {
    OmniError::database("MongoDB 操作失败").with_cause(err.to_string())
}
