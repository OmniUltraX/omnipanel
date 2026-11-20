use std::{net::SocketAddr, sync::Arc, time::Duration};

use kameo::{
    actor::ActorRef,
    message::{Context, Message},
};
use tokio::time::MissedTickBehavior;
use ts_derp::IpUsage;

use crate::env::Env;

/// Actor that sends STUN requests to DERP servers to get this node's public IPv4.
pub struct Stunner {
    env: Env,
    servers: Vec<SocketAddr>,
}

impl Stunner {
    #[tracing::instrument(skip_all, fields(n_server = self.servers.len()), level = "trace")]
    async fn publish_servers(&self) {
        if self.servers.is_empty() {
            tracing::debug!("skipping stun, servers not populated yet");
            return;
        }

        self.env
            .publish(StunServers(Arc::from(self.servers.as_slice())))
            .await
            .unwrap();
    }
}

/// STUN servers the direct UDP socket should probe. The mapped address is only
/// valid for the socket that sends the request.
#[derive(Clone)]
pub struct StunServers(pub Arc<[SocketAddr]>);

#[derive(Copy, Clone)]
struct Tick;

impl kameo::Actor for Stunner {
    type Args = Env;
    type Error = crate::Error;

    async fn on_start(env: Self::Args, slf: ActorRef<Self>) -> Result<Self, Self::Error> {
        env.subscribe::<Arc<ts_control::StateUpdate>>(&slf).await?;

        env.scheduler
            .tell(
                kameo_actors::scheduler::SetInterval::new(
                    slf.downgrade(),
                    Duration::from_secs(20),
                    Tick,
                )
                .set_missed_tick_behaviour(MissedTickBehavior::Skip),
            )
            .await?;

        env.register(None, &slf).await?;

        Ok(Self {
            env,
            servers: vec![],
        })
    }
}

impl Message<Tick> for Stunner {
    type Reply = ();

    async fn handle(&mut self, _: Tick, _ctx: &mut Context<Self, Self::Reply>) {
        self.publish_servers().await;
    }
}

impl Message<Arc<ts_control::StateUpdate>> for Stunner {
    type Reply = ();

    async fn handle(
        &mut self,
        state_update: Arc<ts_control::StateUpdate>,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let Some(derp_map) = &state_update.derp else {
            return;
        };

        let was_empty = self.servers.is_empty();
        self.servers.clear();

        for region in derp_map.values() {
            for server in &region.servers {
                let Some(stun_port) = server.stun_port else {
                    continue;
                };

                let addr = match server.ipv4 {
                    IpUsage::FixedAddr(a) => (a, stun_port).into(),
                    IpUsage::UseDns => {
                        let Some(addr) =
                            resolve_prefer_v4(server.hostname.as_str(), stun_port).await
                        else {
                            continue;
                        };
                        addr
                    }
                    _ => continue,
                };

                tracing::trace!(%addr, "identified stun server");
                self.servers.push(addr);
            }
        }

        // Try a public IPv4 STUN server before the DERP list. A long DERP list of
        // unresponsive ports would otherwise use up the probe budget.
        let mut preferred = Vec::new();
        for (host, port) in [
            ("stun.cloudflare.com", 3478u16),
            ("stun.l.google.com", 19302),
        ] {
            let Some(addr) = resolve_prefer_v4(host, port).await else {
                continue;
            };
            if !preferred.contains(&addr) && !self.servers.contains(&addr) {
                preferred.push(addr);
            }
        }
        preferred.append(&mut self.servers);
        self.servers = preferred;

        tracing::debug!(n_server = self.servers.len(), "updated stun servers");

        if was_empty && !self.servers.is_empty() {
            tracing::trace!("stun server set became populated, trying stun now");
            self.publish_servers().await;
        }
    }
}

/// IPv4 first. Windows `lookup_host` often yields IPv6 first, and the data socket
/// that must own the mapping is the IPv4 one.
async fn resolve_prefer_v4(host: &str, port: u16) -> Option<SocketAddr> {
    let mut v4 = None;
    let mut v6 = None;
    let Ok(iter) = tokio::net::lookup_host((host, port)).await else {
        return None;
    };
    for addr in iter {
        if addr.is_ipv4() {
            v4.get_or_insert(addr);
        } else if addr.is_ipv6() {
            v6.get_or_insert(addr);
        }
    }
    v4.or(v6)
}
