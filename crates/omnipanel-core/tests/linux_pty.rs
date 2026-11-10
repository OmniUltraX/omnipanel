#![cfg(target_os = "linux")]

use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;

use omnipanel_core::terminal::{ShellKind, ShellSpec, Terminal, TerminalConfig};

#[test]
fn linux_bash_pty_executes_input_and_resizes() {
    smoke(Some(ShellSpec {
        kind: ShellKind::Bash,
        path: Some("/bin/bash".into()),
        wsl_distro: None,
    }));
}

#[test]
fn linux_default_ui_null_shell_executes_input_and_resizes() {
    // Same shell=None payload as the default UI create_terminal entry point.
    smoke(None);
}

fn smoke(shell: Option<ShellSpec>) {
    let home = std::env::temp_dir().join(format!(
        "omnipanel-pty-smoke-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos()
    ));
    std::fs::create_dir(&home).expect("isolated shell home");
    let config = TerminalConfig {
        working_dir: Some("/tmp".into()),
        env_vars: vec![("HOME".into(), home.to_string_lossy().into_owned())],
        shell,
        ..TerminalConfig::default()
    };
    let mut terminal = Terminal::new(config).expect("spawn Linux bash PTY");
    assert!(terminal.is_alive());
    terminal.resize(100, 30).expect("resize PTY");
    let mut reader = terminal.take_reader().expect("PTY output reader");
    let (tx, rx) = mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut output = String::new();
        let mut bytes = [0; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            output.push_str(&String::from_utf8_lossy(&bytes[..count]));
            // The input deliberately does not contain this literal marker, so
            // terminal input echo cannot make this test pass without execution.
            if output.contains("OMNI_PTY_OK:/tmp:100 30") {
                let _ = tx.send(output);
                break;
            }
        }
    });
    terminal
        .write(
            b"printf 'OMNI_%s_OK:%s:%s\\n' PTY \"$PWD\" \"$(stty size | awk '{print $2, $1}')\"\n",
        )
        .expect("write shell input");
    let result = rx.recv_timeout(Duration::from_secs(15));
    terminal.kill().expect("close PTY child");
    drop(terminal);
    reading.join().expect("join PTY reader");
    std::fs::remove_dir_all(home).expect("clean isolated shell home");
    assert!(result.is_ok(), "did not receive command output: {result:?}");
}
