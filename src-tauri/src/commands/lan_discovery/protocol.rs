//! 局域网发现协议：JSON over UDP（probe / announce）。

use std::collections::HashMap;
use std::net::IpAddr;

use serde::{Deserialize, Serialize};

pub const CANDIDATE_PORTS: [u16; 3] = [38451, 38452, 38453];
pub const PROBE_INTERVAL_MS: u64 = 2000;
pub const PEER_TTL_MS: u64 = 6000;
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum DiscoveryMessage {
    #[serde(rename = "probe")]
    Probe { v: u32, id: String },
    #[serde(rename = "announce")]
    Announce {
        v: u32,
        id: String,
        name: String,
        version: String,
        os: String,
    },
    /// 分享自定义面板快照（panel_json 为前端序列化的 JSON 字符串）。
    #[serde(rename = "share-panel")]
    SharePanel {
        v: u32,
        id: String,
        panel_json: String,
    },
}

impl DiscoveryMessage {
    pub fn encode(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

pub fn parse_message(bytes: &[u8]) -> Option<DiscoveryMessage> {
    let msg: DiscoveryMessage = serde_json::from_slice(bytes).ok()?;
    match &msg {
        DiscoveryMessage::Probe { v, id } => {
            if *v != PROTOCOL_VERSION || id.trim().is_empty() {
                return None;
            }
        }
        DiscoveryMessage::Announce {
            v,
            id,
            name,
            version,
            os,
        } => {
            if *v != PROTOCOL_VERSION
                || id.trim().is_empty()
                || name.trim().is_empty()
                || version.trim().is_empty()
                || os.trim().is_empty()
            {
                return None;
            }
        }
        DiscoveryMessage::SharePanel {
            v,
            id,
            panel_json,
        } => {
            if *v != PROTOCOL_VERSION || id.trim().is_empty() || panel_json.trim().is_empty() {
                return None;
            }
            // 防止异常大包拖垮解析侧
            if panel_json.len() > 512 * 1024 {
                return None;
            }
        }
    }
    Some(msg)
}

pub fn encode_probe(id: &str) -> Result<Vec<u8>, serde_json::Error> {
    DiscoveryMessage::Probe {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
    }
    .encode()
}

pub fn encode_announce(
    id: &str,
    name: &str,
    version: &str,
    os: &str,
) -> Result<Vec<u8>, serde_json::Error> {
    DiscoveryMessage::Announce {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        os: os.to_string(),
    }
    .encode()
}

pub fn encode_share_panel(id: &str, panel_json: &str) -> Result<Vec<u8>, serde_json::Error> {
    DiscoveryMessage::SharePanel {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        panel_json: panel_json.to_string(),
    }
    .encode()
}

pub fn should_ignore_announce(
    local_id: &str,
    local_ips: &[IpAddr],
    peer_id: &str,
    src_ip: IpAddr,
) -> bool {
    if peer_id == local_id {
        return true;
    }
    if src_ip.is_loopback() {
        return true;
    }
    local_ips.iter().any(|ip| *ip == src_ip)
}

#[derive(Debug, Clone)]
pub struct PeerRecord {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub version: String,
    pub os: String,
    pub last_seen_ms: u64,
}

pub fn upsert_peer(map: &mut HashMap<String, PeerRecord>, peer: PeerRecord) {
    map.insert(peer.id.clone(), peer);
}

/// 移除超过 TTL 的 peer；若有删除返回 true。
pub fn prune_stale(map: &mut HashMap<String, PeerRecord>, now_ms: u64, ttl_ms: u64) -> bool {
    let before = map.len();
    map.retain(|_, p| now_ms.saturating_sub(p.last_seen_ms) <= ttl_ms);
    map.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn parse_probe_ok() {
        let raw = br#"{"v":1,"t":"probe","id":"abc"}"#;
        let msg = parse_message(raw).expect("probe");
        assert_eq!(
            msg,
            DiscoveryMessage::Probe {
                v: 1,
                id: "abc".into()
            }
        );
    }

    #[test]
    fn parse_announce_ok() {
        let raw =
            br#"{"v":1,"t":"announce","id":"x","name":"PC","version":"1.0.0","os":"windows"}"#;
        let msg = parse_message(raw).expect("announce");
        match msg {
            DiscoveryMessage::Announce {
                id,
                name,
                version,
                os,
                ..
            } => {
                assert_eq!(id, "x");
                assert_eq!(name, "PC");
                assert_eq!(version, "1.0.0");
                assert_eq!(os, "windows");
            }
            _ => panic!("expected announce"),
        }
    }

    #[test]
    fn reject_bad_json_and_wrong_version() {
        assert!(parse_message(b"not-json").is_none());
        assert!(parse_message(br#"{"v":2,"t":"probe","id":"a"}"#).is_none());
        assert!(parse_message(br#"{"v":1,"t":"probe","id":""}"#).is_none());
    }

    #[test]
    fn encode_roundtrip_probe() {
        let bytes = encode_probe("id1").unwrap();
        let msg = parse_message(&bytes).unwrap();
        assert_eq!(
            msg,
            DiscoveryMessage::Probe {
                v: 1,
                id: "id1".into()
            }
        );
    }

    #[test]
    fn ignore_self_id_and_local_ip() {
        let local = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10));
        assert!(should_ignore_announce(
            "me",
            &[local],
            "me",
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))
        ));
        assert!(should_ignore_announce(
            "me",
            &[local],
            "other",
            local
        ));
        assert!(!should_ignore_announce(
            "me",
            &[local],
            "other",
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))
        ));
    }

    #[test]
    fn prune_stale_removes_old() {
        let mut map = HashMap::new();
        upsert_peer(
            &mut map,
            PeerRecord {
                id: "a".into(),
                name: "A".into(),
                ip: "1.1.1.1".into(),
                version: "1".into(),
                os: "linux".into(),
                last_seen_ms: 1000,
            },
        );
        upsert_peer(
            &mut map,
            PeerRecord {
                id: "b".into(),
                name: "B".into(),
                ip: "2.2.2.2".into(),
                version: "1".into(),
                os: "linux".into(),
                last_seen_ms: 5000,
            },
        );
        assert!(prune_stale(&mut map, 8000, 6000));
        assert!(!map.contains_key("a"));
        assert!(map.contains_key("b"));
    }
}
