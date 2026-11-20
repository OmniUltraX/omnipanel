use alloc::vec;

use smoltcp::socket::tcp;

use crate::Netstack;

mod listener;
mod stream;

pub use listener::{ListenerHandle, TcpListenerState};

impl Netstack {
    fn tcp_buffer(&self) -> tcp::SocketBuffer<'static> {
        tcp::SocketBuffer::new(vec![0; self.config.tcp_buffer_size])
    }

    /// TCP socket with Nagle disabled.
    ///
    /// smoltcp leaves Nagle on. Small writes then wait for the previous ACK, so an
    /// interactive session stalls by a full round trip even after the underlay is direct.
    fn open_tcp_socket(&self) -> tcp::Socket<'static> {
        let mut sock = tcp::Socket::new(self.tcp_buffer(), self.tcp_buffer());
        sock.set_nagle_enabled(false);
        sock
    }
}
