//! control mode 字节流的行装配。
//!
//! SSH channel 送来的是任意切分的字节块，一行 control 协议可能跨多个块到达，
//! 一个块也可能含多行。此外远端跑在 PTY 上，`ONLCR` 会把 `\n` 变成 `\r\n`，
//! 需要在交给解析器前剥掉行尾的 `\r`。

/// 单行长度上限。超出则强制切出，避免异常输入把内存吃光。
///
/// tmux 的 `%output` 行受其内部缓冲约束，正常远不会到这个量级。
const DEFAULT_MAX_LINE: usize = 1024 * 1024;

/// 把字节块装配成完整的行。
pub struct LineAssembler {
    buf: Vec<u8>,
    max_line: usize,
}

impl Default for LineAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl LineAssembler {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            max_line: DEFAULT_MAX_LINE,
        }
    }

    pub fn with_limit(max_line: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_line: max_line.max(1),
        }
    }

    /// 喂入一个字节块，对其中每个完整行调用 `on_line`（行尾 `\r\n` 已剥离）。
    pub fn push(&mut self, data: &[u8], mut on_line: impl FnMut(&[u8])) {
        let mut rest = data;
        while let Some(pos) = rest.iter().position(|b| *b == b'\n') {
            let (head, tail) = rest.split_at(pos);
            if self.buf.is_empty() {
                // 整行落在同一个块内，免去一次拷贝
                on_line(trim_cr(head));
            } else {
                self.buf.extend_from_slice(head);
                let line = trim_cr(&self.buf).to_vec();
                self.buf.clear();
                on_line(&line);
            }
            rest = &tail[1..];
        }
        self.buf.extend_from_slice(rest);

        if self.buf.len() > self.max_line {
            tracing::warn!(
                target: "tmux",
                "control 行超过 {} 字节上限，强制切分",
                self.max_line
            );
            let line = std::mem::take(&mut self.buf);
            on_line(&line);
        }
    }

    /// 残留的未完成数据长度，用于诊断。
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

fn trim_cr(line: &[u8]) -> &[u8] {
    match line.last() {
        Some(b'\r') => &line[..line.len() - 1],
        _ => line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(chunks: &[&[u8]]) -> Vec<String> {
        let mut asm = LineAssembler::new();
        let mut lines = Vec::new();
        for chunk in chunks {
            asm.push(chunk, |l| {
                lines.push(String::from_utf8_lossy(l).into_owned())
            });
        }
        lines
    }

    #[test]
    fn splits_multiple_lines_in_one_chunk() {
        assert_eq!(collect(&[b"a\nb\nc\n"]), vec!["a", "b", "c"]);
    }

    #[test]
    fn strips_cr_from_pty_line_endings() {
        assert_eq!(
            collect(&[b"%begin 1 1 1\r\n%end 1 1 1\r\n"]),
            vec!["%begin 1 1 1", "%end 1 1 1"]
        );
    }

    #[test]
    fn reassembles_line_split_across_chunks() {
        assert_eq!(
            collect(&[b"%output %0 he", b"llo\r\n"]),
            vec!["%output %0 hello"]
        );
    }

    #[test]
    fn reassembles_line_split_at_cr_lf_boundary() {
        // \r 与 \n 落在不同块，仍须正确剥离
        assert_eq!(collect(&[b"line\r", b"\nnext\r\n"]), vec!["line", "next"]);
    }

    #[test]
    fn holds_incomplete_trailing_data() {
        let mut asm = LineAssembler::new();
        let mut lines: Vec<String> = Vec::new();
        asm.push(b"complete\npartial", |l| {
            lines.push(String::from_utf8_lossy(l).into_owned())
        });
        assert_eq!(lines, vec!["complete"]);
        assert_eq!(asm.pending(), "partial".len());

        asm.push(b"-rest\n", |l| {
            lines.push(String::from_utf8_lossy(l).into_owned())
        });
        assert_eq!(lines, vec!["complete", "partial-rest"]);
        assert_eq!(asm.pending(), 0);
    }

    #[test]
    fn emits_empty_lines() {
        assert_eq!(collect(&[b"\n\na\n"]), vec!["", "", "a"]);
    }

    #[test]
    fn preserves_binary_payload_bytes() {
        let mut asm = LineAssembler::new();
        let mut lines: Vec<Vec<u8>> = Vec::new();
        // \r 只在行尾被剥离，行中的 \r 必须保留
        asm.push(b"a\rb\r\n", |l| lines.push(l.to_vec()));
        assert_eq!(lines, vec![b"a\rb".to_vec()]);
    }

    #[test]
    fn byte_at_a_time_feeding_works() {
        let input = b"%output %0 x\r\n%end 1 1 1\r\n";
        let mut asm = LineAssembler::new();
        let mut lines = Vec::new();
        for b in input {
            asm.push(&[*b], |l| {
                lines.push(String::from_utf8_lossy(l).into_owned())
            });
        }
        assert_eq!(lines, vec!["%output %0 x", "%end 1 1 1"]);
    }

    #[test]
    fn oversized_line_is_force_flushed() {
        let mut asm = LineAssembler::with_limit(8);
        let mut lines: Vec<Vec<u8>> = Vec::new();
        asm.push(b"0123456789", |l| lines.push(l.to_vec()));
        assert_eq!(lines.len(), 1, "超限行应被强制切出以保护内存");
        assert_eq!(lines[0], b"0123456789".to_vec());
        assert_eq!(asm.pending(), 0);
    }
}
