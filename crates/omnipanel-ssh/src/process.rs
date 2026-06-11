use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 进程关联的监听端口。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshProcessPort {
    pub protocol: String,
    pub local_address: String,
    pub local_port: u16,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_port: Option<u16>,
}

/// 远程进程信息。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshProcessInfo {
    pub user: String,
    pub pid: u32,
    pub cpu: f64,
    pub mem: f64,
    #[specta(type = f64)]
    pub vsz: u64,
    #[specta(type = f64)]
    pub rss: u64,
    pub stat: String,
    pub start: String,
    pub time: String,
    pub command: String,
    #[serde(default)]
    pub ports: Vec<SshProcessPort>,
}

/// 通过 `/proc/<pid>` 深入采集的进程详情。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshProcessDetail {
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_line: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default)]
    pub open_files: Vec<String>,
}

pub const PS_EO_CMD: &str = "COLUMNS=4096 ps -eo user=,pid=,pcpu=,pmem=,vsz=,rss=,stat=,start=,time=,args --no-headers 2>/dev/null";
pub const PS_AUX_CMD: &str =
    "COLUMNS=4096 ps aux --no-headers 2>/dev/null || COLUMNS=4096 ps aux | tail -n +2";
pub const SS_CMD: &str = "ss -H -lntipe 2>/dev/null";
pub const SS_CMD_NO_HEADER: &str = "ss -lntipe 2>/dev/null | tail -n +2";
pub const NETSTAT_CMD: &str = "netstat -tunlp 2>/dev/null || netstat -anp 2>/dev/null";
/// 统一采集监听端口：lsof → ss（含 inode 反查 PID）→ /proc 回退，输出 `P pid proto addr port LISTEN`。
pub const COLLECT_PORTS_CMD: &str = r#"/bin/bash -lc '
emit() { echo "P $1 $2 $3 $4 LISTEN"; }
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '"'"'NR>1 {
    name=$9; gsub(/\(LISTEN\)/,"",name);
    n=split(name,a,":"); port=a[n]; gsub(/[^0-9]/,"",port);
    if(port+0>0) printf "P %s tcp listen %s LISTEN\n", $2, port
  }'"'"'
fi
while IFS= read -r line; do
  pid=""; ino=""; local_port=""; local_addr="*"; proto=${line%% *}
  [[ "$line" =~ pid=([0-9]+) ]] && pid=${BASH_REMATCH[1]}
  [[ "$line" =~ ino:([0-9]+) ]] && ino=${BASH_REMATCH[1]}
  for tok in $line; do
    case "$tok" in
      *:*)
        p=${tok##*:}; p=${p//[^0-9]/}
        if [[ -n "$p" && "$p" -gt 0 && "$p" -lt 65536 && -z "$local_port" ]]; then
          local_port=$p
          local_addr=${tok%:*}; local_addr=${local_addr#[}; local_addr=${local_addr%]}
          [[ "$local_addr" == "*" ]] && local_addr="*"
        fi
        ;;
    esac
  done
  [[ -z "$local_port" ]] && continue
  if [[ -z "$pid" && -n "$ino" ]]; then
    f=$(grep -l "socket:\[$ino\]" /proc/[0-9]*/fd/* 2>/dev/null | head -1 || true)
    [[ -n "$f" ]] && pid=$(echo "$f" | cut -d/ -f3)
  fi
  [[ -n "$pid" ]] && emit "$pid" "$proto" "$local_addr" "$local_port"
done < <(ss -H -lntipe 2>/dev/null; ss -lntipe 2>/dev/null | tail -n +2)
hexip() {
  local h=$1
  if [ ${#h} -eq 8 ]; then
    printf "%d.%d.%d.%d" $((16#${h:6:2})) $((16#${h:4:2})) $((16#${h:2:2})) $((16#${h:0:2}))
  else
    echo "*"
  fi
}
declare -A ip port
while read -r _ l _ st i _; do
  [ "$st" = "0A" ] || continue
  ip[$i]=$(hexip ${l%%:*})
  port[$i]=$((16#${l##*:}))
done < /proc/net/tcp
while read -r _ l _ st i _; do
  [ "$st" = "0A" ] || continue
  ip[$i]="::"
  port[$i]=$((16#${l##*:}))
done < /proc/net/tcp6 2>/dev/null
for d in /proc/[0-9]*; do
  pid=${d##*/}
  for fd in "$d"/fd/*; do
    t=$(readlink "$fd" 2>/dev/null) || continue
    case "$t" in
      socket:[*)
        ino=${t#socket:[}; ino=${ino%]}
        if [ -n "${port[$ino]:-}" ]; then
          emit "$pid" "tcp" "${ip[$ino]}" "${port[$ino]}"
        fi
        ;;
    esac
  done
done
'"#;

/// 生成按 PID 深查进程详情的 `/proc` 命令。
pub fn process_detail_cmd(pid: u32) -> String {
    format!(
        r#"/bin/bash -lc '
pid={pid}
proc="/proc/$pid"
[ -d "$proc" ] || exit 2
emit_link() {{
  key="$1"; path="$2"
  target=$(readlink "$path" 2>/dev/null || true)
  [ -n "$target" ] && printf "%s\t%s\n" "$key" "$target"
}}
emit_link CWD "$proc/cwd"
emit_link EXE "$proc/exe"
emit_link ROOT "$proc/root"
if [ -r "$proc/cmdline" ]; then
  cmd=$(tr "\000" " " < "$proc/cmdline" 2>/dev/null | sed "s/[[:space:]]*$//")
  [ -n "$cmd" ] && printf "CMD\t%s\n" "$cmd"
  tr "\000" "\n" < "$proc/cmdline" 2>/dev/null | awk '"'"'length($0)>0 {{print "ARG\t" $0}}'"'"'
fi
count=0
for fd in "$proc"/fd/*; do
  target=$(readlink "$fd" 2>/dev/null || true)
  case "$target" in
    /*)
      printf "FD\t%s\n" "$target"
      count=$((count+1))
      [ "$count" -ge 80 ] && break
      ;;
  esac
done
'"#,
    )
}

pub fn parse_process_detail_output(pid: u32, output: &str) -> SshProcessDetail {
    let mut detail = SshProcessDetail {
        pid,
        ..Default::default()
    };
    let mut seen_files = std::collections::HashSet::new();

    for line in output.lines() {
        let Some((key, value)) = line.split_once('\t') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key {
            "CMD" => detail.command_line = Some(value.to_string()),
            "ARG" => detail.args.push(value.to_string()),
            "CWD" => detail.cwd = Some(value.to_string()),
            "EXE" => detail.exe = Some(value.to_string()),
            "ROOT" => detail.root = Some(value.to_string()),
            "FD" => {
                if seen_files.insert(value.to_string()) {
                    detail.open_files.push(value.to_string());
                }
            }
            _ => {}
        }
    }

    detail
}

/// 解析 `ps -eo user=,...` 单行（`=`` 格式去尾空格，前 9 列按空白分隔，其余为 command）。
pub fn parse_ps_eo_line(line: &str) -> Option<SshProcessInfo> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split_whitespace();
    let user = parts.next()?.to_string();
    let pid: u32 = parts.next()?.parse().ok()?;
    let cpu: f64 = parts.next()?.parse().ok()?;
    let mem: f64 = parts.next()?.parse().ok()?;
    let vsz: u64 = parts.next()?.parse().ok()?;
    let rss: u64 = parts.next()?.parse().ok()?;
    let stat = parts.next()?.to_string();
    let start = parts.next()?.to_string();
    let time = parts.next()?.to_string();
    let command: String = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() || mem > 100.0 || cpu > 6400.0 {
        return None;
    }
    Some(SshProcessInfo {
        user,
        pid,
        cpu,
        mem,
        vsz,
        rss,
        stat,
        start,
        time,
        command,
        ports: Vec::new(),
    })
}

/// 解析 `ps aux` 单行。
pub fn parse_ps_aux_line(line: &str) -> Option<SshProcessInfo> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 11 {
        return None;
    }
    let command = fields[10..].join(" ");
    if command.is_empty() {
        return None;
    }
    let pid: u32 = fields[1].parse().ok()?;
    Some(SshProcessInfo {
        user: fields[0].to_string(),
        pid,
        cpu: fields[2].parse().unwrap_or(0.0),
        mem: fields[3].parse().unwrap_or(0.0),
        vsz: fields[4].parse().unwrap_or(0),
        rss: fields[5].parse().unwrap_or(0),
        stat: fields[7].to_string(),
        start: fields[8].to_string(),
        time: fields[9].to_string(),
        command,
        ports: Vec::new(),
    })
}

pub fn parse_ps_output(output: &str) -> Vec<SshProcessInfo> {
    let non_empty: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    let eo: Vec<SshProcessInfo> = non_empty
        .iter()
        .filter_map(|line| parse_ps_eo_line(line))
        .collect();

    if !eo.is_empty() && eo.len() * 2 >= non_empty.len() {
        return eo;
    }

    non_empty
        .iter()
        .filter_map(|line| parse_ps_aux_line(line))
        .collect()
}

fn parse_host_port(s: &str) -> Option<(String, u16)> {
    let s = s.trim();
    if s.starts_with('[') {
        let end = s.find("]:")?;
        let addr = s[1..end].to_string();
        let port: u16 = s[end + 2..].parse().ok()?;
        return Some((addr, port));
    }
    let (addr, port_str) = s.rsplit_once(':')?;
    let port: u16 = port_str.parse().ok()?;
    Some((addr.to_string(), port))
}

fn extract_pid_from_ss_line(line: &str) -> Option<u32> {
    let mut rest = line;
    while let Some(idx) = rest.find("pid=") {
        rest = &rest[idx + 4..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(pid) = digits.parse() {
            return Some(pid);
        }
    }
    None
}

fn find_local_socket_token(line: &str) -> Option<(String, u16)> {
    for token in line.split_whitespace().skip(1) {
        if token == "*:*" {
            continue;
        }
        if let Some((addr, port)) = parse_host_port(token) {
            if port > 0 {
                return Some((addr, port));
            }
        }
    }
    None
}

/// 解析 `ss -lntipe` 单行。
pub fn parse_ss_line(line: &str) -> Option<(u32, SshProcessPort)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let pid = extract_pid_from_ss_line(line)?;
    let protocol = line.split_whitespace().next()?.to_lowercase();
    let (local_address, local_port) = find_local_socket_token(line)?;
    let state = line
        .split_whitespace()
        .nth(1)
        .unwrap_or("LISTEN")
        .to_string();
    Some((
        pid,
        SshProcessPort {
            protocol,
            local_address,
            local_port,
            state,
            remote_address: None,
            remote_port: None,
        },
    ))
}

/// 解析 `netstat -tunlp` 单行。
pub fn parse_netstat_line(line: &str) -> Option<(u32, SshProcessPort)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 7 {
        return None;
    }
    let protocol = parts[0].to_lowercase();
    let local = parts[3];
    let remote = parts[4];
    let state = parts[5].to_string();
    let pid_prog = parts[6];
    if pid_prog == "-" {
        return None;
    }
    let pid: u32 = pid_prog.split('/').next()?.parse().ok()?;
    let (local_address, local_port) = parse_host_port(local)?;
    let (remote_address, remote_port) = parse_host_port(remote)
        .map(|(a, p)| (Some(a), Some(p)))
        .unwrap_or((None, None));
    Some((
        pid,
        SshProcessPort {
            protocol,
            local_address,
            local_port,
            state,
            remote_address,
            remote_port,
        },
    ))
}

pub fn parse_ss_ports(output: &str) -> HashMap<u32, Vec<SshProcessPort>> {
    let mut map: HashMap<u32, Vec<SshProcessPort>> = HashMap::new();
    for line in output.lines() {
        if let Some((pid, port)) = parse_ss_line(line) {
            map.entry(pid).or_default().push(port);
        }
    }
    map
}

pub fn parse_netstat_ports(output: &str) -> HashMap<u32, Vec<SshProcessPort>> {
    let mut map: HashMap<u32, Vec<SshProcessPort>> = HashMap::new();
    for line in output.lines() {
        if let Some((pid, port)) = parse_netstat_line(line) {
            map.entry(pid).or_default().push(port);
        }
    }
    map
}

/// 解析 `/proc` 回退脚本输出的 `P <pid> <proto> <addr> <port> <state>` 行。
pub fn parse_proc_port_line(line: &str) -> Option<(u32, SshProcessPort)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 5 || parts[0] != "P" {
        return None;
    }
    let pid: u32 = parts[1].parse().ok()?;
    let protocol = parts[2].to_lowercase();
    let local_address = parts[3].to_string();
    let local_port: u16 = parts[4].parse().ok()?;
    let state = parts.get(5).unwrap_or(&"LISTEN").to_string();
    Some((
        pid,
        SshProcessPort {
            protocol,
            local_address,
            local_port,
            state,
            remote_address: None,
            remote_port: None,
        },
    ))
}

pub fn parse_proc_ports(output: &str) -> HashMap<u32, Vec<SshProcessPort>> {
    let mut map: HashMap<u32, Vec<SshProcessPort>> = HashMap::new();
    for line in output.lines() {
        if let Some((pid, port)) = parse_proc_port_line(line) {
            map.entry(pid).or_default().push(port);
        }
    }
    map
}

pub fn merge_ports(
    map: &mut HashMap<u32, Vec<SshProcessPort>>,
    other: HashMap<u32, Vec<SshProcessPort>>,
) {
    for (pid, ports) in other {
        let entry = map.entry(pid).or_default();
        for port in ports {
            if !entry.iter().any(|existing| {
                existing.local_port == port.local_port
                    && existing.protocol == port.protocol
                    && existing.local_address == port.local_address
            }) {
                entry.push(port);
            }
        }
    }
}

pub fn attach_ports(
    processes: &mut [SshProcessInfo],
    ports_by_pid: &HashMap<u32, Vec<SshProcessPort>>,
) {
    for proc in processes.iter_mut() {
        if let Some(ports) = ports_by_pid.get(&proc.pid) {
            proc.ports = ports.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_eo_basic() {
        let line = "root 1 0.0 0.1 169984 12340 Ss 17:30 00:00:01 /sbin/init";
        let info = parse_ps_eo_line(line).expect("parse");
        assert_eq!(info.user, "root");
        assert_eq!(info.pid, 1);
        assert_eq!(info.start, "17:30");
        assert_eq!(info.command, "/sbin/init");
    }

    #[test]
    fn parse_ps_eo_long_command() {
        let line = "root 2954325 800.0 8.0 32768 40832 Ssl 00:00 00:10:00 /usr/bin/java -server -Xms8g -jar app.jar";
        let info = parse_ps_eo_line(line).expect("parse");
        assert_eq!(info.pid, 2954325);
        assert_eq!(info.cpu, 800.0);
        assert!(info.command.contains("-server"));
        assert!(info.command.contains("app.jar"));
    }

    #[test]
    fn parse_ps_output_prefers_eo_when_majority() {
        let output = "root 1 0.0 0.1 169984 12340 Ss 17:30 00:00:01 /sbin/init\nroot 2 0.0 0.0 0 0 S 17:30 00:00:00 [kthreadd]";
        let list = parse_ps_output(output);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].command, "/sbin/init");
    }

    #[test]
    fn parse_ps_aux_basic() {
        let line = "root  1234  0.5  1.2  123456  7890  ?  Ss  Jun10  0:01  /usr/sbin/sshd";
        let info = parse_ps_aux_line(line).expect("parse");
        assert_eq!(info.pid, 1234);
        assert!(info.command.contains("sshd"));
    }

    #[test]
    fn parse_ss_line_ipv6() {
        let line = r#"tcp   LISTEN 0 128 [::]:8080 [::]:* users:(("java",pid=999,fd=4)) ino:12345"#;
        let (pid, port) = parse_ss_line(line).expect("parse");
        assert_eq!(pid, 999);
        assert_eq!(port.local_port, 8080);
        assert_eq!(port.local_address, "::");
    }

    #[test]
    fn parse_ss_line_basic() {
        let line = r#"tcp   LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("nginx",pid=1234,fd=6))"#;
        let (pid, port) = parse_ss_line(line).expect("parse");
        assert_eq!(pid, 1234);
        assert_eq!(port.local_port, 8080);
        assert_eq!(port.local_address, "127.0.0.1");
    }

    #[test]
    fn parse_netstat_line_basic() {
        let line = "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      999/sshd";
        let (pid, port) = parse_netstat_line(line).expect("parse");
        assert_eq!(pid, 999);
        assert_eq!(port.local_port, 22);
    }

    #[test]
    fn parse_proc_port_line_basic() {
        let line = "P 2954325 tcp 127.0.0.1 8080 LISTEN";
        let (pid, port) = parse_proc_port_line(line).expect("parse");
        assert_eq!(pid, 2954325);
        assert_eq!(port.local_port, 8080);
        assert_eq!(port.local_address, "127.0.0.1");
    }

    #[test]
    fn attach_ports_merges_by_pid() {
        let mut processes = vec![SshProcessInfo {
            user: "root".into(),
            pid: 1234,
            cpu: 0.0,
            mem: 0.0,
            vsz: 0,
            rss: 0,
            stat: "S".into(),
            start: "0".into(),
            time: "0:00".into(),
            command: "nginx".into(),
            ports: vec![],
        }];
        let mut map = HashMap::new();
        map.insert(
            1234,
            vec![SshProcessPort {
                protocol: "tcp".into(),
                local_address: "0.0.0.0".into(),
                local_port: 80,
                state: "LISTEN".into(),
                remote_address: None,
                remote_port: None,
            }],
        );
        attach_ports(&mut processes, &map);
        assert_eq!(processes[0].ports.len(), 1);
        assert_eq!(processes[0].ports[0].local_port, 80);
    }

    #[test]
    fn attach_ports_empty_map_leaves_processes_unchanged() {
        let mut processes = vec![SshProcessInfo {
            user: "root".into(),
            pid: 99,
            cpu: 0.0,
            mem: 0.0,
            vsz: 0,
            rss: 0,
            stat: "S".into(),
            start: "0".into(),
            time: "0:00".into(),
            command: "sleep".into(),
            ports: vec![],
        }];
        attach_ports(&mut processes, &HashMap::new());
        assert!(processes[0].ports.is_empty());
    }
}
