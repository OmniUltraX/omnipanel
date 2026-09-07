// 模块秒切回 A/B 实测（经 dev-mcp 桥 execute_js 驱动真机）。
//
// 用法（应用须以 `cargo tauri dev --features dev-mcp` 运行中）：
//   node scripts/e2e/module-switch-perf.mjs phase-a   # 全保留：清开关→reload→走一遍切换→打印
//   node scripts/e2e/module-switch-perf.mjs phase-b   # LRU：开关置 0→reload→同样一遍→打印
//   node scripts/e2e/module-switch-perf.mjs phase-c   # 还原：删开关→reload（恢复新行为）
//
// 原理：pushState+popstate 触发应用内路由；页内的 moduleSwitchPerf 探针
// （effect→双 rAF）采集每次切换耗时 + performance.memory 堆 MB。

const url = "ws://127.0.0.1:9223";
// 真实侧栏点击（title 即 i18n 名）：含 pointerdown→effect 全链路
const CLICK_TITLES = ["数据库", "终端", "数据库", "终端", "容器", "终端"];
const SETTLE_MS = 1500;
const BOOT_WAIT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let stepNo = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("WS connect timeout"));
    }, 15000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        close() { try { ws.close(); } catch {} },
        call(command, args) {
          return new Promise((res) => {
            const id = "m" + ++stepNo;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, command, args: args ?? {} }));
          });
        },
      });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const fn = pending.get(msg.id);
      if (!fn) return;
      pending.delete(msg.id);
      fn(msg);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WS error"));
    };
  });
}

async function connectRetry(label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = await connect();
      console.log(`[bridge] connected (${label})`);
      return c;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error("bridge unreachable after retries");
}

async function evalJs(conn, script) {
  const msg = await conn.call("execute_js", { script });
  if (msg.success === false) throw new Error(`execute_js: ${msg.error}`);
  return msg.data;
}

async function waitForProbe(conn) {
  for (let i = 0; i < 90; i++) {
    const v = await evalJs(conn, "String(typeof window.__omniSwitchPerf)");
    if (v === "object") return;
    await sleep(1000);
  }
  throw new Error("probe not ready (frontend booting?)");
}

async function measure(label) {
  const conn = await connectRetry("measure");
  await waitForProbe(conn);
  await evalJs(conn, "window.__omniSwitchPerf.reset(); window.__omniSwitchPerf.samples().length");
  // LongTask 归因：抓切换窗口内的长任务（脚本/布局耗时 + 归因容器）
  await evalJs(
    conn,
    `(function(){window.__omniLongtasks=[];if(window.__omniLongtaskObs){try{window.__omniLongtaskObs.disconnect()}catch{}}try{var o=new PerformanceObserver(function(l){for(var e of l.getEntries()){window.__omniLongtasks.push({d:Math.round(e.duration*10)/10,s:Math.round(e.startTime),n:(e.name||'').slice(0,80)});if(window.__omniLongtasks.length>60)window.__omniLongtasks.shift()}});o.observe({entryTypes:['longtask']});window.__omniLongtaskObs=o;return 'obs-armed'}catch(e){return 'obs-fail:'+e}})()`,
  );
  const heap0 = await evalJs(
    conn,
    "Math.round(performance.memory.usedJSHeapSize/1048576*10)/10",
  );
  for (const title of CLICK_TITLES) {
    // 先 pointerdown（探针打点）再 click（与真实点击一致）
    const clicked = await evalJs(
      conn,
      `(function(){var btns=[...document.querySelectorAll('.sidebar-item[title]')];var b=btns.find(x=>x.title==${JSON.stringify(title)});if(!b)return 'missing:'+[ ...document.querySelectorAll('.sidebar-item[title]')].map(x=>x.title).join('|');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));b.click();return location.pathname})()`,
    );
    void clicked;
    await sleep(SETTLE_MS);
  }
  await sleep(1000);
  const summary = await evalJs(conn, "JSON.stringify(window.__omniSwitchPerf.summary())");
  const longtasks = await evalJs(conn, "JSON.stringify(window.__omniLongtasks||[])");
  const heap1 = await evalJs(
    conn,
    "Math.round(performance.memory.usedJSHeapSize/1048576*10)/10",
  );
  conn.close();
  const rows = JSON.parse(summary);
  const tasks = JSON.parse(longtasks);
  console.log(`\n=== ${label} ===`);
  console.log(`heap: ${heap0}MB -> ${heap1}MB (delta ${(Math.round((heap1 - heap0) * 10) / 10)}MB)`);
  console.log("pair | count | avgMs | p95Ms | avgInputToEffectMs | avgInputToLayoutMs | lastHeapMB");
  for (const r of rows) {
    console.log(
      `${r.pair} | ${r.count} | ${r.avgMs} | ${r.p95Ms} | ${r.avgInputToEffectMs ?? "?"} | ${r.avgInputToLayoutMs ?? "?"} | ${r.lastHeapMB}`,
    );
  }
  console.log("longtasks (>50ms, duration|start):");
  const big = tasks.filter((t) => t.d > 50).slice(-15);
  for (const t of big) console.log(`  ${t.d}ms @${t.s} ${t.n}`);
  if (big.length === 0) console.log("  (none >50ms)");
  console.log(`JSON:${JSON.stringify({ label, heap0, heap1, rows })}`);
}

async function reloadAndWait() {
  // fire-and-forget：reload 后页面上下文销毁，不会有响应
  const conn = await connectRetry("reload");
  conn.call("execute_js", { script: "location.reload()" }).catch(() => {});
  await sleep(1000);
  conn.close();
  console.log("[reload] sent, waiting for boot...");
  await sleep(BOOT_WAIT_MS);
}

async function main() {
  const phase = process.argv[2];
  if (phase === "phase-a") {
    const conn = await connectRetry("flag");
    await evalJs(conn, "localStorage.removeItem('omnipanel.keepAlive.retainAll'); 'cleared'");
    conn.close();
    await reloadAndWait();
    await measure("phase-a retain-all");
  } else if (phase === "phase-b") {
    const conn = await connectRetry("flag");
    await evalJs(conn, "localStorage.setItem('omnipanel.keepAlive.retainAll','0'); 'set0'");
    conn.close();
    await reloadAndWait();
    await measure("phase-b lru");
  } else if (phase === "phase-c") {
    const conn = await connectRetry("flag");
    await evalJs(conn, "localStorage.removeItem('omnipanel.keepAlive.retainAll'); 'cleared'");
    conn.close();
    await reloadAndWait();
    console.log("[cleanup] flag removed, app rebooted with retain-all");
  } else if (phase === "measure") {
    await measure("manual (no reload, current flag)");
  } else {
    console.error("usage: node scripts/e2e/module-switch-perf.mjs <phase-a|phase-b|phase-c>");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("RUNNER ERR", e.message);
  process.exit(1);
});
