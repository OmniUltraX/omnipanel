use redis::aio::MultiplexedConnection;
use redis::{AsyncCommands, Client};
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::time::Duration;
use tokio::sync::mpsc as tokio_mpsc;

/// Redis Pub/Sub 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisPubSubConfig {
    pub host: String,
    pub port: u16,
    pub database: u8,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// 收到的 Pub/Sub 消息（IPC）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisPubSubMessage {
    pub channel: String,
    pub payload: String,
    pub timestamp: String,
}

/// 发布消息请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisPubSubPublish {
    pub channel: String,
    pub message: String,
}

enum PubSubCommand {
    Subscribe(String),
    Unsubscribe(String),
    Shutdown,
}

/// 已连接的 Redis Pub/Sub 会话（订阅与发布使用独立连接）。
pub struct RedisPubSubSession {
    cmd_tx: mpsc::Sender<PubSubCommand>,
    publish_conn: MultiplexedConnection,
    _reader_thread: std::thread::JoinHandle<()>,
}

impl RedisPubSubSession {
    pub async fn connect(
        config: RedisPubSubConfig,
        on_message: tokio_mpsc::UnboundedSender<RedisPubSubMessage>,
    ) -> Result<Self, String> {
        let url = build_redis_url(&config);
        let client = Client::open(url.as_str()).map_err(|e| format!("Invalid Redis URL: {e}"))?;

        let publish_conn = client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| format!("Redis connect failed: {e}"))?;

        let (cmd_tx, cmd_rx) = mpsc::channel::<PubSubCommand>();
        let reader_client = client.clone();

        let reader_thread = std::thread::spawn(move || {
            let Ok(mut conn) = reader_client.get_connection() else {
                return;
            };
            let mut pubsub = conn.as_pubsub();
            let _ = pubsub.set_read_timeout(Some(Duration::from_millis(200)));

            loop {
                while let Ok(cmd) = cmd_rx.try_recv() {
                    match cmd {
                        PubSubCommand::Subscribe(ch) => {
                            if pubsub.subscribe(ch).is_err() {
                                return;
                            }
                        }
                        PubSubCommand::Unsubscribe(ch) => {
                            if pubsub.unsubscribe(ch).is_err() {
                                return;
                            }
                        }
                        PubSubCommand::Shutdown => return,
                    }
                }

                match pubsub.get_message() {
                    Ok(msg) => {
                        let channel = msg.get_channel_name().to_string();
                        let payload: String = msg
                            .get_payload()
                            .unwrap_or_else(|_| "<invalid payload>".to_string());
                        if on_message
                            .send(RedisPubSubMessage {
                                channel,
                                payload,
                                timestamp: chrono_now(),
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(e) => {
                        if e.is_timeout() {
                            continue;
                        }
                        break;
                    }
                }
            }
        });

        Ok(Self {
            cmd_tx,
            publish_conn,
            _reader_thread: reader_thread,
        })
    }

    pub fn subscribe(&self, channel: &str) -> Result<(), String> {
        self.cmd_tx
            .send(PubSubCommand::Subscribe(channel.to_string()))
            .map_err(|e| format!("Subscribe failed: {e}"))
    }

    pub fn unsubscribe(&self, channel: &str) -> Result<(), String> {
        self.cmd_tx
            .send(PubSubCommand::Unsubscribe(channel.to_string()))
            .map_err(|e| format!("Unsubscribe failed: {e}"))
    }

    pub async fn publish(&self, msg: RedisPubSubPublish) -> Result<u64, String> {
        let mut conn = self.publish_conn.clone();
        conn.publish::<_, _, u64>(&msg.channel, &msg.message)
            .await
            .map_err(|e| format!("Publish failed: {e}"))
    }

    pub fn disconnect(&self) {
        let _ = self.cmd_tx.send(PubSubCommand::Shutdown);
    }
}

fn build_redis_url(config: &RedisPubSubConfig) -> String {
    let port = if config.port == 0 { 6379 } else { config.port };
    let db = config.database.min(15);

    match (&config.username, &config.password) {
        (Some(user), Some(pass)) if !user.is_empty() && !pass.is_empty() => {
            format!(
                "redis://{}:{}@{}:{}/{}",
                percent_encode(user),
                percent_encode(pass),
                config.host,
                port,
                db
            )
        }
        (_, Some(pass)) if !pass.is_empty() => format!(
            "redis://:{}@{}:{}/{}",
            percent_encode(pass),
            config.host,
            port,
            db
        ),
        _ => format!("redis://{}:{}/{}", config.host, port, db),
    }
}

fn percent_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '%' => "%25".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '[' => "%5B".to_string(),
            ']' => "%5D".to_string(),
            _ => c.to_string(),
        })
        .collect()
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() % 86400;
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}
