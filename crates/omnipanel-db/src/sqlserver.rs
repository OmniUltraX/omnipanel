//! SQL Server 进程内驱动（tiberius + rustls）。
//!
//! Docker / 自签证书环境一律 `trust_cert()`；Windows SSPI、命名实例、AAD 本轮不做。
//! `ssl` 只映射加密传输，不复用成 SYSDBA。

use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::{Value, json};
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::{
    DbDriver, DbParams, QueryResult, decode_text_as_json_or_string, encode_blob_value, is_query,
    safe_int_to_value, sanitize_json_value_for_js, split_statements,
};

const DEFAULT_PORT: u16 = 1433;

pub struct SqlServerDriver {
    client: Mutex<Client<Compat<TcpStream>>>,
}

fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(crate) fn quote_ident(name: &str) -> String {
    name.split('.')
        .map(|part| format!("[{}]", part.replace(']', "]]")))
        .collect::<Vec<_>>()
        .join(".")
}

fn map_tiberius(err: tiberius::error::Error) -> OmniError {
    OmniError::database("SQL Server 查询失败").with_cause(err.to_string())
}

fn cell_to_json(data: &ColumnData<'_>) -> Value {
    let value = match data {
        ColumnData::U8(v) => v
            .map(|n| safe_int_to_value(n as i128))
            .unwrap_or(Value::Null),
        ColumnData::I16(v) => v
            .map(|n| safe_int_to_value(n as i128))
            .unwrap_or(Value::Null),
        ColumnData::I32(v) => v
            .map(|n| safe_int_to_value(n as i128))
            .unwrap_or(Value::Null),
        ColumnData::I64(v) => v
            .map(|n| safe_int_to_value(n as i128))
            .unwrap_or(Value::Null),
        ColumnData::F32(v) => v.map(|n| json!(n)).unwrap_or(Value::Null),
        ColumnData::F64(v) => v.map(|n| json!(n)).unwrap_or(Value::Null),
        ColumnData::Bit(v) => v.map(Value::Bool).unwrap_or(Value::Null),
        ColumnData::String(v) => v
            .as_ref()
            .map(|s| decode_text_as_json_or_string(s.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(v) => v
            .map(|g| Value::String(g.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| encode_blob_value(b.as_ref()))
            .unwrap_or(Value::Null),
        ColumnData::Numeric(v) => v
            .map(|n| Value::String(n.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Xml(v) => v
            .as_ref()
            .map(|x| Value::String(x.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::DateTime(v) => v
            .map(|d| Value::String(format!("{d:?}")))
            .unwrap_or(Value::Null),
        ColumnData::SmallDateTime(v) => v
            .map(|d| Value::String(format!("{d:?}")))
            .unwrap_or(Value::Null),
        ColumnData::DateTime2(v) => v
            .map(|d| Value::String(format!("{d:?}")))
            .unwrap_or(Value::Null),
        ColumnData::DateTimeOffset(v) => v
            .map(|d| Value::String(format!("{d:?}")))
            .unwrap_or(Value::Null),
        ColumnData::Time(v) => v
            .map(|d| Value::String(format!("{d:?}")))
            .unwrap_or(Value::Null),
        ColumnData::Date(v) => v
            .map(|d| Value::String(format!("{d:?}")))
            .unwrap_or(Value::Null),
    };
    sanitize_json_value_for_js(value)
}

fn first_cell_i64(result: &QueryResult) -> i64 {
    match result.rows.first().and_then(|row| row.first()) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

impl SqlServerDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        ensure_crypto_provider();
        let port = if params.port == 0 {
            DEFAULT_PORT
        } else {
            params.port
        };
        let mut config = Config::new();
        config.host(&params.host);
        config.port(port);
        config.authentication(AuthMethod::sql_server(&params.user, &params.password));
        if !params.database.trim().is_empty() {
            config.database(params.database.trim());
        }
        config.trust_cert();
        config.encryption(if params.ssl {
            EncryptionLevel::Required
        } else {
            EncryptionLevel::NotSupported
        });

        let tcp = TcpStream::connect(config.get_addr())
            .await
            .map_err(|e| OmniError::connection("SQL Server 连接失败").with_cause(e.to_string()))?;
        tcp.set_nodelay(true).ok();
        let client = Client::connect(config, tcp.compat_write())
            .await
            .map_err(|e| OmniError::connection("SQL Server 握手失败").with_cause(e.to_string()))?;
        Ok(Self {
            client: Mutex::new(client),
        })
    }

    pub async fn list_databases(params: &DbParams) -> OmniResult<Vec<String>> {
        let driver = Self::connect(params).await?;
        let result = driver
            .execute("SELECT name FROM sys.databases ORDER BY name")
            .await?;
        Ok(result
            .rows
            .into_iter()
            .filter_map(|row| match row.first() {
                Some(Value::String(name)) => Some(name.clone()),
                Some(other) => Some(other.to_string()),
                None => None,
            })
            .collect())
    }

    async fn run_query(
        client: &mut Client<Compat<TcpStream>>,
        sql: &str,
    ) -> OmniResult<QueryResult> {
        let stream = client.query(sql, &[]).await.map_err(map_tiberius)?;
        let rows = stream.into_first_result().await.map_err(map_tiberius)?;
        let columns = rows
            .first()
            .map(|row| {
                row.columns()
                    .iter()
                    .map(|col| col.name().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let data = rows
            .iter()
            .map(|row| row.cells().map(|(_, data)| cell_to_json(data)).collect())
            .collect();
        Ok(QueryResult {
            columns,
            rows: data,
            rows_affected: 0,
        })
    }

    async fn run_execute(
        client: &mut Client<Compat<TcpStream>>,
        sql: &str,
    ) -> OmniResult<QueryResult> {
        let result = client.execute(sql, &[]).await.map_err(map_tiberius)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: result.total(),
        })
    }
}

#[async_trait]
impl DbDriver for SqlServerDriver {
    async fn version(&self) -> OmniResult<String> {
        let mut client = self.client.lock().await;
        let result = Self::run_query(
            &mut client,
            "SELECT CAST(@@VERSION AS nvarchar(256)) AS version",
        )
        .await?;
        match result.rows.first().and_then(|row| row.first()) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(other) => Ok(other.to_string()),
            None => Ok("unknown".into()),
        }
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let mut client = self.client.lock().await;
        let sql = "SELECT TABLE_SCHEMA + N'.' + TABLE_NAME \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_TYPE IN (N'BASE TABLE', N'VIEW') \
             ORDER BY TABLE_SCHEMA, TABLE_NAME";
        let result = Self::run_query(&mut client, sql).await?;
        Ok(result
            .rows
            .into_iter()
            .filter_map(|row| match row.first() {
                Some(Value::String(name)) => Some(name.clone()),
                Some(other) => Some(other.to_string()),
                None => None,
            })
            .collect())
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let statements = split_statements(sql);
        if statements.is_empty() {
            return Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected: 0,
            });
        }
        let mut client = self.client.lock().await;
        let mut last = QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
        };
        for stmt in statements {
            last = if is_query(&stmt) {
                Self::run_query(&mut client, &stmt).await?
            } else {
                Self::run_execute(&mut client, &stmt).await?
            };
        }
        Ok(last)
    }

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        let where_sql = crate::build_where_sql(where_clause)?;
        let order = match order_by.map(str::trim).filter(|s| !s.is_empty()) {
            Some(clause) => clause.to_string(),
            None => "(SELECT NULL)".into(),
        };
        let sql = format!(
            "SELECT * FROM {}{} ORDER BY {} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
            quote_ident(table),
            where_sql,
            order,
            offset.max(0),
            limit.max(0)
        );
        self.execute(&sql).await
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        let where_sql = crate::build_where_sql(where_clause)?;
        let sql = format!(
            "SELECT COUNT_BIG(*) AS cnt FROM {}{}",
            quote_ident(table),
            where_sql
        );
        let result = self.execute(&sql).await?;
        Ok(first_cell_i64(&result))
    }
}

#[cfg(test)]
mod tests {
    use super::quote_ident;

    #[test]
    fn quotes_schema_qualified_names() {
        assert_eq!(quote_ident("dbo.t"), "[dbo].[t]");
        assert_eq!(quote_ident("weird]name"), "[weird]]name]");
    }
}
