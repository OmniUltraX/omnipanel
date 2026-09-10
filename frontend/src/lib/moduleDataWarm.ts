import type { OverlayModuleKey } from "./routePanels";

/**
 * 模块数据静默预热（后台自动，无需 hover）。
 *
 * 定位：chunk 预拉（moduleWarmup）+ 壳悬挂载之后，live 之前，把“本地安全”
 * 的数据提前灌进 store。首点时数据已在，骨架屏直接跳过。
 *
 * 安全合同（注册回调 MUST 遵守，逐条是红线）：
 * 1. 只读本地：persisted store、本地后端 DB/文件读（如 schema 快照、任务历史）。
 *    禁止触碰 env_tag=prod 目标、禁止解包 Vault 凭据、禁止建连/执行查询。
 * 2. 静默：不翻 isLoading、不弹 toast、不写审计、不启轮询/订阅。
 * 3. 幂等：store 自带 hydrated 守卫；重复调用无害。
 * 4. 新鲜度归 live：预热只填缓存，live 侧正常刷新（stale-while-revalidate
 *    由各面板自行决定；预热绝不代替 live 刷新）。
 *
 * 调度：空闲错峰逐个跑（与 shell 预热错开时段），会话内每个模块只跑一次，
 * 单模块失败隔离。localStorage `omnipanel.warm.datawarm` 置 "0" 可关。
 */

export type ModuleDataWarmFn = () => Promise<void>;

const warmers = new Map<OverlayModuleKey, ModuleDataWarmFn>();
const warmDone = new Set<OverlayModuleKey>();
const warmInflight = new Set<OverlayModuleKey>();

/** 注册模块数据预热回调；同 key 后注册覆盖先注册（便于测试与覆盖）。 */
export function registerModuleDataWarm(key: OverlayModuleKey, warm: ModuleDataWarmFn): void {
  warmers.set(key, warm);
}

/** 仅测试：清空注册与完成态。 */
export function resetModuleDataWarmForTests(): void {
  warmers.clear();
  warmDone.clear();
  warmInflight.clear();
}

export function isModuleDataWarmDone(key: OverlayModuleKey): boolean {
  return warmDone.has(key);
}

export function listModuleDataWarmKeys(): OverlayModuleKey[] {
  return [...warmers.keys()];
}

const DATAWARM_FLAG = "omnipanel.warm.datawarm";

export function shouldSilentDataWarm(): boolean {
  try {
    return window.localStorage.getItem(DATAWARM_FLAG) !== "0";
  } catch {
    return true;
  }
}

/**
 * 真实延迟 + 空闲对齐（与 moduleWarmup 同语义）：先睡足 timeoutMs，
 * 到点后再要空闲槽。禁止裸 requestIdleCallback——其 timeout 只是 deadline，
 * 首屏空闲会立刻开火，多个预热调度同时 stampede 主线程。
 */
function scheduleIdleOrTimeout(run: () => void, timeoutMs: number): () => void {
  let settled = false;
  let timer: number | null = null;
  let cancelIdle: (() => void) | null = null;
  const fire = () => {
    if (settled) return;
    settled = true;
    run();
  };
  timer = window.setTimeout(() => {
    timer = null;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(fire, { timeout: 2000 });
      cancelIdle = () => {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
      };
      return;
    }
    fire();
  }, Math.max(0, timeoutMs));
  return () => {
    settled = true;
    if (timer) window.clearTimeout(timer);
    timer = null;
    cancelIdle?.();
    cancelIdle = null;
  };
}

export interface IdleModuleDataWarmOptions {
  keys?: readonly OverlayModuleKey[];
  initialTimeoutMs?: number;
  stepTimeoutMs?: number;
}

/**
 * 空闲错峰跑数据预热：一次一个，会话去重，失败隔离。
 * 默认在 shell 预热之后起跑（initial 8s），避免与首屏交互/壳挂载抢主线程。
 */
export function scheduleIdleModuleDataWarm(
  options?: IdleModuleDataWarmOptions,
): () => void {
  const keys = options?.keys ?? ([...warmers.keys()] as OverlayModuleKey[]);
  const initialTimeoutMs = options?.initialTimeoutMs ?? 8000;
  const stepTimeoutMs = options?.stepTimeoutMs ?? 900;
  let cancelled = false;
  let cancelScheduled: (() => void) | null = null;
  let index = 0;

  const warmNext = () => {
    if (cancelled) return;
    if (!shouldSilentDataWarm()) return;
    while (index < keys.length && (warmDone.has(keys[index]!) || !warmers.has(keys[index]!))) {
      index += 1;
    }
    if (index >= keys.length) return;
    const key = keys[index]!;
    index += 1;
    if (warmInflight.has(key)) {
      cancelScheduled = scheduleIdleOrTimeout(warmNext, stepTimeoutMs);
      return;
    }
    warmInflight.add(key);
    const run = async () => {
      try {
        await warmers.get(key)?.();
        warmDone.add(key);
      } catch {
        /* 单模块失败隔离：记 done 避免反复重试，live 侧正常拉取 */
        warmDone.add(key);
      } finally {
        warmInflight.delete(key);
      }
    };
    void run().finally(() => {
      if (cancelled) return;
      cancelScheduled = scheduleIdleOrTimeout(warmNext, stepTimeoutMs);
    });
  };

  cancelScheduled = scheduleIdleOrTimeout(warmNext, initialTimeoutMs);

  return () => {
    cancelled = true;
    cancelScheduled?.();
    cancelScheduled = null;
  };
}
