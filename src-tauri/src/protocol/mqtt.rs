use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

/// MQTT broker connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    pub broker_url: String,
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub keep_alive_secs: Option<u64>,
    pub clean_session: Option<bool>,
    pub use_tls: Option<bool>,
}

/// MQTT subscription request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttSubscription {
    pub topic: String,
    pub qos: u8,
}

/// MQTT message for IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttMessage {
    pub topic: String,
    pub payload: String,
    pub qos: u8,
    pub retain: bool,
    pub timestamp: String,
}

/// MQTT publish request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttPublish {
    pub topic: String,
    pub payload: String,
    pub qos: u8,
    pub retain: bool,
}

/// A connected MQTT session.
pub struct MqttSession {
    client: rumqttc::AsyncClient,
    _event_task: tokio::task::JoinHandle<()>,
}

impl MqttSession {
    /// Connect to an MQTT broker and return a session handle.
    pub async fn connect(
        config: MqttConfig,
        on_message: mpsc::UnboundedSender<MqttMessage>,
    ) -> Result<Self, String> {
        // Parse broker URL to extract host and port
        // Accepts formats: "mqtt://host:port", "mqtts://host:port", "host:port", "host"
        let default_port = if config.use_tls.unwrap_or(false) {
            8883u16
        } else {
            1883u16
        };
        let url_str = config.broker_url.trim();
        let cleaned = url_str
            .strip_prefix("mqtt://")
            .or_else(|| url_str.strip_prefix("mqtts://"))
            .unwrap_or(url_str);
        let (host, port) = if let Some((h, p)) = cleaned.rsplit_once(':') {
            (h.to_string(), p.parse::<u16>().unwrap_or(default_port))
        } else {
            (cleaned.to_string(), default_port)
        };

        let mut mqttoptions = rumqttc::MqttOptions::new(&config.client_id, &host, port);

        mqttoptions.set_keep_alive(std::time::Duration::from_secs(
            config.keep_alive_secs.unwrap_or(60),
        ));

        if let Some(clean) = config.clean_session {
            mqttoptions.set_clean_session(clean);
        }

        if let (Some(user), Some(pass)) = (&config.username, &config.password) {
            mqttoptions.set_credentials(user, pass);
        }

        let (client, mut eventloop) = rumqttc::AsyncClient::new(mqttoptions, 100);

        // Task: process incoming MQTT events
        let event_task = tokio::spawn(async move {
            loop {
                match eventloop.poll().await {
                    Ok(rumqttc::Event::Incoming(rumqttc::Packet::Publish(msg))) => {
                        let payload = String::from_utf8_lossy(&msg.payload).to_string();
                        let mqtt_msg = MqttMessage {
                            topic: msg.topic.clone(),
                            payload,
                            qos: msg.qos as u8,
                            retain: msg.retain,
                            timestamp: chrono_now(),
                        };
                        let _ = on_message.send(mqtt_msg);
                    }
                    Ok(_) => {} // Other events (ConnAck, SubAck, PubAck, etc.)
                    Err(_) => {
                        // Connection error (including disconnect)
                        break;
                    }
                }
            }
        });

        Ok(Self {
            client,
            _event_task: event_task,
        })
    }

    /// Subscribe to a topic.
    pub async fn subscribe(&self, topic: &str, qos: u8) -> Result<(), String> {
        let qos = match qos {
            0 => rumqttc::QoS::AtMostOnce,
            1 => rumqttc::QoS::AtLeastOnce,
            2 => rumqttc::QoS::ExactlyOnce,
            _ => return Err(format!("Invalid QoS: {qos}")),
        };
        self.client
            .subscribe(topic, qos)
            .await
            .map_err(|e| format!("Subscribe failed: {e}"))
    }

    /// Unsubscribe from a topic.
    pub async fn unsubscribe(&self, topic: &str) -> Result<(), String> {
        self.client
            .unsubscribe(topic)
            .await
            .map_err(|e| format!("Unsubscribe failed: {e}"))
    }

    /// Publish a message.
    pub async fn publish(&self, msg: MqttPublish) -> Result<(), String> {
        let qos = match msg.qos {
            0 => rumqttc::QoS::AtMostOnce,
            1 => rumqttc::QoS::AtLeastOnce,
            2 => rumqttc::QoS::ExactlyOnce,
            _ => return Err(format!("Invalid QoS: {}", msg.qos)),
        };
        self.client
            .publish(msg.topic, qos, msg.retain, msg.payload.as_bytes())
            .await
            .map_err(|e| format!("Publish failed: {e}"))
    }

    /// Disconnect from the broker.
    pub async fn disconnect(&self) -> Result<(), String> {
        self.client
            .disconnect()
            .await
            .map_err(|e| format!("Disconnect failed: {e}"))
    }
}

/// Shared state for all MQTT sessions.
pub type MqttSessions = Arc<Mutex<HashMap<String, MqttSession>>>;

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
