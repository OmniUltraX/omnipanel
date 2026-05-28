import { DockLayout, DockPanel, DockHandle } from "../../components/dock";

export function WorkflowPanel() {
  return (
    <DockLayout>
      <DockPanel defaultSize={14} minSize={10} collapsible>
        <div className="wf-section-title" style={{fontSize:"10px", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--meta)", padding:"var(--sp-3) var(--sp-4)"}}>脚本</div>
        <div className="wf-nav-item active" data-wf="scripts" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", padding:"var(--sp-2) var(--sp-3)", fontSize:"12px", cursor:"pointer", color:"var(--fg)", background:"var(--accent-soft)"}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>
          快捷脚本
        </div>
        <div className="wf-nav-item" data-wf="templates" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", padding:"var(--sp-2) var(--sp-3)", fontSize:"12px", cursor:"pointer", color:"var(--meta)"}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
          命令模板
        </div>
        <div className="wf-section-title" style={{fontSize:"10px", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--meta)", padding:"var(--sp-3) var(--sp-4)", marginTop:"var(--sp-3)"}}>工作流</div>
        <div className="wf-nav-item" data-wf="deploy" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", padding:"var(--sp-2) var(--sp-3)", fontSize:"12px", cursor:"pointer", color:"var(--meta)"}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          部署流程
        </div>
        <div className="wf-nav-item" data-wf="patrol" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", padding:"var(--sp-2) var(--sp-3)", fontSize:"12px", cursor:"pointer", color:"var(--meta)"}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          巡检模板
        </div>
        <div className="wf-nav-item" data-wf="data" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", padding:"var(--sp-2) var(--sp-3)", fontSize:"12px", cursor:"pointer", color:"var(--meta)"}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>
          数据工作流
        </div>
        <div className="wf-section-title" style={{fontSize:"10px", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--meta)", padding:"var(--sp-3) var(--sp-4)", marginTop:"var(--sp-3)"}}>历史</div>
        <div className="wf-nav-item" data-wf="history" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", padding:"var(--sp-2) var(--sp-3)", fontSize:"12px", cursor:"pointer", color:"var(--meta)"}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
          执行日志
        </div>
      </DockPanel>
      <DockHandle />
      <DockPanel>
        <div className="wf-content" style={{flex:1, overflowY:"auto", padding:"var(--sp-4)"}}>
          <div className="wf-panel active" id="panel-scripts">
            <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"var(--sp-4)"}}>
              <div>
                <h2 style={{fontSize:"16px", fontWeight:700, marginBottom:"4px"}}>快捷脚本</h2>
                <p className="text-muted" style={{fontSize:"12px", color:"var(--meta)"}}>{"高频操作封装为一键脚本，支持参数化和批量执行"}</p>
              </div>
              <input className="input input-search" placeholder="搜索脚本..." style={{width:"200px", padding:"6px 10px", background:"var(--bg-deeper)", border:"1px solid var(--border)", borderRadius:"var(--r-sm)", color:"var(--fg)", fontSize:"12px"}} />
            </div>
            <div className="script-grid" style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:"var(--sp-3)"}}>
              {[
                {name:"Deploy to Production",desc:"拉取最新代码、构建镜像、更新 Compose、检查健康状态并输出部署摘要。",type:"Shell",risk:"High Risk",riskColor:"danger",color:"var(--success)",target:"prod-web-01, prod-web-02"},
                {name:"DB Backup & Verify",desc:"备份生产数据库、校验完整性、上传至远程存储并发送通知。",type:"SQL",risk:"Medium",riskColor:"warn",color:"var(--accent)",target:"prod-db-master"},
                {name:"Docker Cleanup",desc:"清理悬空镜像、停止的容器、未使用的卷和网络，释放磁盘空间。",type:"Docker",risk:"Low",riskColor:"success",color:"var(--warn)",target:"All Servers"},
                {name:"服务器健康检查",desc:"批量检查 CPU、内存、磁盘、服务状态、证书有效期和安全更新。",type:"Shell",risk:"只读",riskColor:"success",color:"var(--danger)",target:"全部服务器"},
                {name:"Log Rotation",desc:"压缩归档超过 7 天的日志文件，清理 30 天前的归档，报告释放空间。",type:"Shell",risk:"Low",riskColor:"success",color:"var(--accent)",target:"prod-web-01"},
                {name:"SSL Cert Renew",desc:"检查证书到期时间、自动续期 Let's Encrypt 证书并重载 Nginx。",type:"Shell",risk:"Medium",riskColor:"warn",color:"var(--success)",target:"prod-web-01, prod-web-02"},
              ].map((s) => (
                <div key={s.name} className="script-card" style={{background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--r-md)", padding:"var(--sp-3)", cursor:"pointer", transition:"border-color 0.12s"}}>
                  <div className="sc-header" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", marginBottom:"var(--sp-2)"}}>
                    <div className="sc-icon" style={{width:"28px", height:"28px", display:"grid", placeItems:"center", borderRadius:"var(--r-sm)", background:s.color+"20", color:s.color}}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                    </div>
                    <div className="sc-name" style={{fontSize:"13px", fontWeight:600}}>{s.name}</div>
                  </div>
                  <div className="sc-desc" style={{fontSize:"11px", color:"var(--meta)", marginBottom:"var(--sp-2)", lineHeight:1.5}}>{s.desc}</div>
                  <div className="sc-meta" style={{display:"flex", alignItems:"center", gap:"var(--sp-2)", fontSize:"10px"}}>
                    <span className={`sc-type badge-${s.riskColor}`} style={{padding:"1px 5px", borderRadius:"3px", background:s.riskColor==="danger"?"var(--danger-soft)":s.riskColor==="warn"?"var(--warn-soft)":"var(--success-soft)", color:s.riskColor==="danger"?"var(--danger)":s.riskColor==="warn"?"var(--warn)":"var(--success)"}}>{s.type}</span>
                    <span className={`sc-risk badge-${s.riskColor}`} style={{padding:"1px 5px", borderRadius:"3px", background:s.riskColor==="danger"?"var(--danger-soft)":s.riskColor==="warn"?"var(--warn-soft)":"var(--success-soft)", color:s.riskColor==="danger"?"var(--danger)":s.riskColor==="warn"?"var(--warn)":"var(--success)"}}>{s.risk}</span>
                    <span style={{color:"var(--meta)"}}>{s.target}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="wf-panel" id="panel-deploy" style={{display:"none"}}>
            <div style={{marginBottom:"var(--sp-4)"}}>
              <h2 style={{fontSize:"16px", fontWeight:700, marginBottom:"4px"}}>Deploy Flows</h2>
              <p className="text-muted" style={{fontSize:"12px", color:"var(--meta)"}}>{"将拉代码、构建、部署、检查串成可复用的流程"}</p>
            </div>
          </div>
          <div className="wf-panel" id="panel-history" style={{display:"none"}}>
            <div style={{marginBottom:"var(--sp-4)"}}>
              <h2 style={{fontSize:"16px", fontWeight:700, marginBottom:"4px"}}>执行历史</h2>
              <p className="text-muted" style={{fontSize:"12px", color:"var(--meta)"}}>{"所有脚本和工作流的执行记录"}</p>
            </div>
          </div>
          <div className="wf-panel" id="panel-templates" style={{display:"none"}}>
            <div style={{marginBottom:"var(--sp-4)"}}>
              <h2 style={{fontSize:"16px", fontWeight:700, marginBottom:"4px"}}>Command Templates</h2>
              <p className="text-muted" style={{fontSize:"12px", color:"var(--meta)"}}>{"带变量的命令模板，支持参数化执行"}</p>
            </div>
          </div>
          <div className="wf-panel" id="panel-patrol" style={{display:"none"}}>
            <div style={{marginBottom:"var(--sp-4)"}}>
              <h2 style={{fontSize:"16px", fontWeight:700, marginBottom:"4px"}}>Patrol Templates</h2>
              <p className="text-muted" style={{fontSize:"12px", color:"var(--meta)"}}>{"定期巡检模板，自动检查服务器健康状态"}</p>
            </div>
          </div>
          <div className="wf-panel" id="panel-data" style={{display:"none"}}>
            <div style={{marginBottom:"var(--sp-4)"}}>
              <h2 style={{fontSize:"16px", fontWeight:700, marginBottom:"4px"}}>Data Workflows</h2>
              <p className="text-muted" style={{fontSize:"12px", color:"var(--meta)"}}>{"数据库数据排查、修复、同步和导出工作流"}</p>
            </div>
          </div>
        </div>
      </DockPanel>
    </DockLayout>
  );
}
