//! Underlay selected for each peer: direct UDP, or the DERP relay.
//!
//! The route table lives inside [`RouteUpdater`](crate::route_updater::RouteUpdater). Callers
//! outside the runtime only have a [`tailscale`](https://docs.rs/tailscale) device, so the latest
//! choice is mirrored here, keyed by this node's key.

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

use ts_keys::NodePublicKey;

static PATHS: LazyLock<Mutex<HashMap<NodePublicKey, HashMap<String, PeerPath>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// How packets to a peer leave this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerPath {
    /// A UDP hole-punch probe won. Packets go straight to the peer.
    Direct,
    /// No direct path yet. Packets go through the peer's DERP region.
    Relay,
}

impl PeerPath {
    /// Stable label for the desktop UI.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Relay => "relay",
        }
    }
}

/// Direct wins when a probe has landed. Relay is the fallback while the peer still has a DERP
/// region. Neither means this node has no route to the peer yet.
pub fn classify_underlay(direct: bool, relay: bool) -> Option<PeerPath> {
    if direct {
        Some(PeerPath::Direct)
    } else if relay {
        Some(PeerPath::Relay)
    } else {
        None
    }
}

pub(crate) fn replace(self_key: NodePublicKey, paths: HashMap<String, PeerPath>) {
    let mut guard = PATHS.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(previous) = guard.get(&self_key) {
        for (name, kind) in &paths {
            if previous.get(name).copied() != Some(*kind) {
                tracing::info!(hostname = %name, path = kind.as_str(), "组网路径");
            }
        }
    } else {
        for (name, kind) in &paths {
            tracing::info!(hostname = %name, path = kind.as_str(), "组网路径");
        }
    }
    guard.insert(self_key, paths);
}

/// Path currently selected for `hostname`, as seen from the node that owns `self_key`.
pub fn peer_underlay(self_key: &NodePublicKey, hostname: &str) -> Option<PeerPath> {
    let guard = PATHS.lock().unwrap_or_else(|err| err.into_inner());
    let paths = guard.get(self_key)?;
    let host = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    if let Some(kind) = paths.get(&host) {
        return Some(*kind);
    }
    let short = host.split('.').next().unwrap_or(host.as_str());
    paths.get(short).copied()
}

/// Drop the snapshot for a node that has left the tailnet.
pub fn forget_peer_paths(self_key: &NodePublicKey) {
    let mut guard = PATHS.lock().unwrap_or_else(|err| err.into_inner());
    guard.remove(self_key);
}

fn remember_hostname(paths: &mut HashMap<String, PeerPath>, hostname: &str, kind: PeerPath) {
    let host = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return;
    }
    paths.insert(host.clone(), kind);
    if let Some((short, _)) = host.split_once('.') {
        paths.entry(short.to_string()).or_insert(kind);
    }
}

pub(crate) fn paths_for_peers<'a>(
    peers: impl IntoIterator<Item = (&'a str, bool, bool)>,
) -> HashMap<String, PeerPath> {
    let mut paths = HashMap::new();
    for (hostname, direct, relay) in peers {
        if let Some(kind) = classify_underlay(direct, relay) {
            remember_hostname(&mut paths, hostname, kind);
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_wins_over_relay() {
        assert_eq!(classify_underlay(true, true), Some(PeerPath::Direct));
        assert_eq!(classify_underlay(false, true), Some(PeerPath::Relay));
        assert_eq!(classify_underlay(false, false), None);
    }

    #[test]
    fn lookup_uses_short_hostname() {
        let key = NodePublicKey::from([9u8; 32]);
        replace(
            key,
            paths_for_peers([("OP-Peer.Tailnet.ts.net", true, true)]),
        );
        assert_eq!(peer_underlay(&key, "op-peer"), Some(PeerPath::Direct));
        forget_peer_paths(&key);
        assert_eq!(peer_underlay(&key, "op-peer"), None);
    }
}
