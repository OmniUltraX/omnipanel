//! SSH 交互 PTY 的 UTF-8 约定。
//!
//! 远端 `LANG`/`LC_CTYPE` 为 POSIX（常见于未跑过 `locale-gen` 的新装系统）时，
//! bash/readline 会打开 `convert-meta`：汉字 UTF-8 的高位字节被当成 Meta 前缀。
//! 「间」的第三字节是 `0xB4`，即 Meta-4，屏幕上出现 `(arg: 4)`。

use russh::{Channel, Pty, client};

/// glibc 内置 UTF-8 locale，不依赖 `locale-gen` / `zh_CN.UTF-8`。
pub const SSH_UTF8_LOCALE: &str = "C.UTF-8";

/// 只改字符分类，不覆盖主机已有的 `LANG`（避免把 `zh_CN` 提示改成英文）。
pub const SSH_UTF8_ENV: &[(&str, &str)] = &[("LC_CTYPE", SSH_UTF8_LOCALE)];

pub fn ssh_utf8_pty_modes() -> Vec<(Pty, u32)> {
    vec![(Pty::IUTF8, 1), (Pty::ISTRIP, 0), (Pty::CS8, 1)]
}

/// `AcceptEnv` 未放行时 sshd 会丢弃，不能因此让会话失败。
pub async fn apply_ssh_utf8_env(channel: &Channel<client::Msg>) {
    for (name, value) in SSH_UTF8_ENV {
        let _ = channel.set_env(false, *name, *value).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_modes_enable_utf8_and_keep_8bit() {
        let modes = ssh_utf8_pty_modes();
        assert!(modes.contains(&(Pty::IUTF8, 1)));
        assert!(modes.contains(&(Pty::ISTRIP, 0)));
        assert!(modes.contains(&(Pty::CS8, 1)));
    }

    #[test]
    fn only_sets_lc_ctype() {
        assert_eq!(SSH_UTF8_ENV, &[("LC_CTYPE", "C.UTF-8")]);
    }

    #[test]
    fn jian_utf8_maps_to_readline_arg_4() {
        let bytes = "间".as_bytes();
        assert_eq!(bytes, &[0xe9, 0x97, 0xb4]);
        // convert-meta: 高位字节 → ESC + (byte & 0x7f)；0xB4 → '4'
        assert_eq!(0xb4 & 0x7f, b'4');
    }
}
