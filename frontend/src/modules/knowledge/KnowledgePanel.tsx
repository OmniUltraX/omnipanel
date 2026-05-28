export function KnowledgePanel() {
  return (
    <div className="kb-workspace">
      <div className="kb-sidebar">
        <div className="kb-section-title">分类</div>
        <div className="kb-nav-item active" data-kb="snippets">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>
          命令片段
        </div>
        <div className="kb-nav-item" data-kb="cases">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
          故障案例
        </div>
        <div className="kb-nav-item" data-kb="ai">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z"/><path d="M12 17v4M8 21h8"/></svg>
          AI 总结
        </div>
        <div className="kb-section-title" style={{marginTop: "var(--sp-3)"}}>标签</div>
        <div className="kb-nav-item"><span className="tag" style={{width: "100%", justifyContent: "center"}}>nginx</span></div>
        <div className="kb-nav-item"><span className="tag" style={{width: "100%", justifyContent: "center"}}>docker</span></div>
        <div className="kb-nav-item"><span className="tag" style={{width: "100%", justifyContent: "center"}}>postgresql</span></div>
        <div className="kb-nav-item"><span className="tag" style={{width: "100%", justifyContent: "center"}}>ssh</span></div>
        <div className="kb-nav-item"><span className="tag" style={{width: "100%", justifyContent: "center"}}>security</span></div>
      </div>

      <div className="kb-main">
        <div className="kb-content">
          {/* Command Snippets */}
          <div className="kb-panel active" id="panel-snippets">
            <div style={{marginBottom: "var(--sp-4)"}}>
              <h2 style={{fontSize: "16px", fontWeight: 700, marginBottom: "4px"}}>命令片段</h2>
              <p className="text-muted" style={{fontSize: "12px"}}>{"常用命令、SQL、Docker 操作和说明"}</p>
            </div>

            <div className="snippet-card">
              <div className="snippet-header">
                <h3>查找大文件</h3>
                <span className="tag">linux</span>
                <span className="tag">disk</span>
              </div>
              <div className="snippet-desc">{"快速查找磁盘上大于指定大小的文件，用于磁盘清理"}</div>
              <div className="snippet-code">
<span className="comment">{"# Find files larger than 100MB in /var"}</span>
<span className="cmd">{"find /var -type f -size +100M -exec ls -lh {} \\; 2>/dev/null | sort -k5 -h"}</span>

<span className="comment">{"# Find files larger than 1GB in home directory"}</span>
<span className="cmd">{"find ~ -type f -size +1G -printf '%s %p\\n' | sort -rn | head -20"}</span>
              </div>
              <div className="snippet-meta">
                <span className="badge badge-success">只读</span>
                <span>使用 12 次</span>
                <span>最近：2 天前</span>
              </div>
            </div>

            <div className="snippet-card">
              <div className="snippet-header">
                <h3>Docker 容器资源</h3>
                <span className="tag">docker</span>
                <span className="tag">monitoring</span>
              </div>
              <div className="snippet-desc">{"查看所有运行中容器的资源使用情况"}</div>
              <div className="snippet-code">
<span className="comment">{"# All containers resource usage"}</span>
<span className="cmd">{'docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}\\t{{.BlockIO}}"'}</span>

<span className="comment">{"# Specific container with custom format"}</span>
<span className="cmd">{'docker stats nginx-proxy --no-stream --format "CPU: {{.CPUPerc}} | MEM: {{.MemUsage}}"'}</span>
              </div>
              <div className="snippet-meta">
                <span className="badge badge-success">只读</span>
                <span>使用 28 次</span>
                <span>最近：1 小时前</span>
              </div>
            </div>

            <div className="snippet-card">
              <div className="snippet-header">
                <h3>PostgreSQL 慢查询分析</h3>
                <span className="tag">postgresql</span>
                <span className="tag">performance</span>
              </div>
              <div className="snippet-desc">{"分析 PostgreSQL 慢查询，找出需要优化的 SQL"}</div>
              <div className="snippet-code">
<span className="comment">{"-- Enable pg_stat_statements extension first"}</span>
<span className="cmd">{"SELECT query, calls, mean_exec_time, total_exec_time, rows"}</span>
<span className="cmd">{"FROM pg_stat_statements"}</span>
<span className="cmd">{"ORDER BY mean_exec_time DESC LIMIT 20;"}</span>

<span className="comment">{"-- Check current running queries"}</span>
<span className="cmd">{"SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state"}</span>
<span className="cmd">{"FROM pg_stat_activity WHERE state != 'idle' ORDER BY duration DESC;"}</span>
              </div>
              <div className="snippet-meta">
                <span className="badge badge-success">只读</span>
                <span>使用 15 次</span>
                <span>最近：3 天前</span>
              </div>
            </div>

            <div className="snippet-card">
              <div className="snippet-header">
                <h3>Nginx Config Test &amp; Reload</h3>
                <span className="tag">nginx</span>
                <span className="tag">deploy</span>
              </div>
              <div className="snippet-desc">{"安全地测试和重载 Nginx 配置"}</div>
              <div className="snippet-code">
<span className="comment">{"# Test config syntax"}</span>
<span className="cmd">{'nginx -t && echo "Config OK" || echo "Config ERROR"'}</span>

<span className="comment">{"# Graceful reload (no downtime)"}</span>
<span className="cmd">{"nginx -s reload"}</span>

<span className="comment">{"# Check which sites are enabled"}</span>
<span className="cmd">{"ls -la /etc/nginx/sites-enabled/"}</span>
              </div>
              <div className="snippet-meta">
                <span className="badge badge-warn">中风险</span>
                <span>使用 8 次</span>
                <span>最近：1 周前</span>
              </div>
            </div>
          </div>

          {/* Incident Cases */}
          <div className="kb-panel" id="panel-cases">
            <div style={{marginBottom: "var(--sp-4)"}}>
              <h2 style={{fontSize: "16px", fontWeight: 700, marginBottom: "4px"}}>Incident Cases</h2>
              <p className="text-muted" style={{fontSize: "12px"}}>{"故障案例：现象、原因、处理、预防"}</p>
            </div>

            <div className="case-card">
              <div className="case-header">
                <h3>Nginx CPU Spike Due to Rate Limit Flood</h3>
                <span className="badge badge-danger">Production</span>
                <span className="text-muted text-sm">2026-05-26</span>
              </div>
              <div className="case-section">
                <h4>Symptom</h4>
                <p>{"nginx-proxy 容器 CPU 使用率从正常的 5% 突然飙升到 85%，上游连接超时日志大量出现，API 响应时间从 12ms 增长到 2000ms+。"}</p>
              </div>
              <div className="case-section">
                <h4>Root Cause</h4>
                <p>{"45.33.32.0/24 子网在 5 分钟内发送 2,847 次请求，触发 rate-limiting。TLS 握手开销导致 CPU 飙升，上游连接排队导致超时。"}</p>
              </div>
              <div className="case-section">
                <h4>Resolution</h4>
                <p>{"在 nginx.conf 中添加 "}<code>{"deny 45.33.32.0/24;"}</code>{" 封禁该子网，重启 nginx-proxy 容器。CPU 在 30 秒内恢复正常。"}</p>
              </div>
              <div className="case-section">
                <h4>Prevention</h4>
                <p>{"配置 fail2ban 自动封禁高频请求 IP，在 Cloudflare 层添加 WAF 规则过滤异常流量。"}</p>
              </div>
              <div className="case-tags">
                <span className="case-tag">nginx</span>
                <span className="case-tag">security</span>
                <span className="case-tag">rate-limit</span>
                <span className="case-tag">production</span>
              </div>
            </div>

            <div className="case-card">
              <div className="case-header">
                <h3>Disk Space Exhaustion on Database Server</h3>
                <span className="badge badge-warn">Staging</span>
                <span className="text-muted text-sm">2026-05-20</span>
              </div>
              <div className="case-section">
                <h4>Symptom</h4>
                <p>{"staging-worker 磁盘使用率达到 98%，PostgreSQL WAL 日志堆积导致写入失败，应用报错 \"could not write to file\"。"}</p>
              </div>
              <div className="case-section">
                <h4>Root Cause</h4>
                <p>{"pg_repack 大表操作产生了大量 WAL 日志，归档进程未能及时清理。同时 Docker 日志文件未配置轮转，占用了 15GB。"}</p>
              </div>
              <div className="case-section">
                <h4>Resolution</h4>
                <p>{"手动清理 Docker 日志、配置 logrotate、执行 pg_archivecleanup 清理 WAL，磁盘降至 62%。"}</p>
              </div>
              <div className="case-tags">
                <span className="case-tag">postgresql</span>
                <span className="case-tag">disk</span>
                <span className="case-tag">docker</span>
              </div>
            </div>
          </div>

          {/* AI Summaries */}
          <div className="kb-panel" id="panel-ai">
            <div style={{marginBottom: "var(--sp-4)"}}>
              <h2 style={{fontSize: "16px", fontWeight: 700, marginBottom: "4px"}}>AI Summaries</h2>
              <p className="text-muted" style={{fontSize: "12px"}}>{"AI 对终端输出、日志分析、SQL 查询结果的总结"}</p>
            </div>
            <div className="snippet-card">
              <div className="snippet-header"><h3>prod-web-01 日志分析</h3><span className="badge badge-accent">AI 生成</span></div>
              <div className="snippet-desc">{"AI 分析 nginx 错误日志后的摘要"}</div>
              <div className="snippet-code">
<span className="comment">{"Summary: Past 24h nginx error analysis"}</span>
{"- 847 upstream timeout warnings (98% from 45.33.32.x)"}
{"- 12 connection refused errors (redis-cache restart at 03:00)"}
{"- 3 SSL handshake failures (expired intermediate cert)"}
{"- Rate limit triggered 45 times for 3 unique IPs"}
<span className="comment">{"Recommendation: Block 45.33.32.0/24 at firewall level"}</span>
              </div>
              <div className="snippet-meta"><span>Generated 2h ago</span><span>From: terminal.html AI panel</span></div>
            </div>
            <div className="snippet-card">
              <div className="snippet-header"><h3>数据库结构解释</h3><span className="badge badge-accent">AI 生成</span></div>
              <div className="snippet-desc">{"AI 解释 orders 表结构设计"}</div>
              <div className="snippet-code">
<span className="comment">{"The orders table uses a denormalized design with:"}</span>
{"- id: UUID primary key (distributed-friendly)"}
{"- user_id: FK to users (indexed)"}
{"- status: enum (pending, paid, shipped, completed, cancelled)"}
{"- items: JSONB array (flexible schema for order items)"}
{"- total_amount: DECIMAL(10,2) (precise currency)"}
{"- created_at/updated_at: timestamps with timezone"}
<span className="comment">{"Missing indexes: consider adding (status, created_at) for dashboard queries"}</span>
              </div>
              <div className="snippet-meta"><span>Generated 1d ago</span><span>From: database.html</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
