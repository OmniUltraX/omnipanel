/**
 * Shell Agent 思考正文缓存：归档冻结卡时写入「思考完成」快照，供展开浮窗读取。
 */
const thinkingFullBySession = new Map<string, string>();
const thinkingFullByFrozenId = new Map<string, string>();
let frozenThinkingSeq = 0;

export function stashFrozenThinking(fullText: string): string {
  frozenThinkingSeq += 1;
  const id = `th-${frozenThinkingSeq}`;
  const trimmed = fullText.trim();
  if (trimmed) thinkingFullByFrozenId.set(id, trimmed);
  return id;
}

export function getFrozenThinking(id: string): string {
  return thinkingFullByFrozenId.get(id) ?? "";
}

export function readFrozenThinkingFromCard(card: Element): string {
  const id = card.getAttribute("data-thinking-id") ?? "";
  const fromNode =
    card.querySelector<HTMLTextAreaElement>(".term-shell-agent-thinking-src")
      ?.value ??
    card.querySelector(".term-shell-agent-thinking-src")?.textContent ??
    "";
  const fromAttr = card.getAttribute("data-thinking-full") ?? "";
  return (
    fromNode.trim() ||
    (id ? getFrozenThinking(id) : "") ||
    fromAttr.trim()
  );
}

function glueFrozenThinkingFragment(prev: string, fragment: string): string {
  const a = prev.trimEnd();
  const f = fragment.trim();
  if (!a) return f;
  if (!f) return a;
  if (a.endsWith(f) || a.includes(f)) return a;
  if (/[a-zA-Z0-9_]$/.test(a) && /^[a-z0-9]/.test(f)) return `${a}${f}`;
  return `${a}${f}`;
}

function writeFrozenThinkingCard(card: Element, fullText: string): void {
  const full = fullText.trim();
  const id = card.getAttribute("data-thinking-id") ?? "";
  if (id) thinkingFullByFrozenId.set(id, full);
  card.setAttribute("data-thinking-full", full);
  const ta = card.querySelector<HTMLTextAreaElement>(".term-shell-agent-thinking-src");
  if (ta) {
    ta.value = full;
    ta.textContent = full;
  }
}

/** 工具条钉早了时，把后窗开头残片补回上一张已冻结的思考卡 */
export function appendLastFrozenThinkingFragment(
  sessionId: string,
  root: ParentNode,
  fragment: string,
): boolean {
  const f = fragment.trim();
  if (!f) return false;
  const cards = root.querySelectorAll(
    `.term-shell-agent-card[data-shell-agent-frozen-thinking="1"][data-session-id="${sessionId}"]`,
  );
  const card = cards[cards.length - 1];
  if (!card) return false;
  const prev = readFrozenThinkingFromCard(card);
  const merged = glueFrozenThinkingFragment(prev, f);
  if (merged === prev) return false;
  writeFrozenThinkingCard(card, merged);
  return true;
}

/**
 * 同一思考窗口只允许正文变长。短碎片（tool 插入后的尾巴）不得覆盖全文。
 * 新窗口（内容不是旧文的子串）则采用新文本。
 */
export function mergeThinkingText(prev: string, next: string): string {
  const a = prev.trim();
  const b = next.trim();
  if (!b) return a;
  if (!a) return b;
  if (b.length >= a.length) return b;
  // 去掉工具前末行残片后，新文本是旧文后缀，应采用较短的干净文本
  if (a.endsWith(b) && b.length >= 8) return b;
  if (a.includes(b)) return a;
  // ni_ssh_exec. 这类短尾巴不是新窗口
  if (b.length <= Math.max(24, Math.floor(a.length * 0.5))) return a;
  return b;
}

export function setShellAgentThinkingFull(sessionId: string, text: string): void {
  const trimmed = text.trim();
  // 窗口切空时禁止清掉上一口正文，否则归档会冻成「正在理解意图」
  if (!trimmed) return;
  const prev = thinkingFullBySession.get(sessionId) ?? "";
  thinkingFullBySession.set(sessionId, mergeThinkingText(prev, trimmed));
}

/** 从活卡 / 冻结卡 HTML 捞思考正文，供归档兜底 */
export function extractThinkingFromLiveHtml(liveHtml: string): string {
  const area = liveHtml.match(
    /<textarea[^>]*class="[^"]*term-shell-agent-thinking-src[^"]*"[^>]*>([\s\S]*?)<\/textarea>/i,
  );
  if (area?.[1]?.trim()) {
    return area[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .trim();
  }
  const attr = liveHtml.match(/data-thinking-full="([^"]*)"/i);
  if (attr?.[1]?.trim()) {
    return attr[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
  }
  return "";
}

export function getShellAgentThinkingFull(sessionId: string): string {
  return thinkingFullBySession.get(sessionId) ?? "";
}

export function clearShellAgentThinkingFull(sessionId: string): void {
  thinkingFullBySession.delete(sessionId);
}

const archivedDisplayToolIds = new Map<string, Set<string>>();
const EMPTY_ARCHIVED_TOOL_IDS: ReadonlySet<string> = new Set();

export function collectDisplayToolIdsFromHtml(html: string): string[] {
  const ids: string[] = [];
  const re = /data-tool-id="([^"]+)"/g;
  let m: RegExpExecArray | null = re.exec(html);
  while (m) {
    if (m[1]) ids.push(m[1]);
    m = re.exec(html);
  }
  return ids;
}

export function markArchivedDisplayToolIds(sessionId: string, ids: string[]): void {
  if (ids.length === 0) return;
  let set = archivedDisplayToolIds.get(sessionId);
  if (!set) {
    set = new Set();
    archivedDisplayToolIds.set(sessionId, set);
  }
  for (const id of ids) {
    if (id) set.add(id);
  }
}

export function getArchivedDisplayToolIds(sessionId: string): ReadonlySet<string> {
  return archivedDisplayToolIds.get(sessionId) ?? EMPTY_ARCHIVED_TOOL_IDS;
}

export function clearArchivedDisplayToolIds(sessionId: string): void {
  archivedDisplayToolIds.delete(sessionId);
}

/** 卡面流式预览：只取最后一行非空文本。展开必须用全文，禁止拿这一行当 fullText。 */
export function lastThinkingLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function thinkingDoneCopy(): { doneLabel: string; expandLabel: string } {
  const lang =
    typeof document !== "undefined" ? document.documentElement.lang || "zh-CN" : "zh-CN";
  if (lang.toLowerCase().startsWith("en")) {
    return { doneLabel: "Thinking complete", expandLabel: "Expand" };
  }
  return { doneLabel: "思考完成", expandLabel: "展开" };
}

/** 归档用：思考完成固定卡 HTML（可点展开） */
export function buildThinkingDoneFrozenHtml(opts: {
  fullText: string;
  sessionId: string;
  doneLabel?: string;
  expandLabel?: string;
}): string {
  const copy = thinkingDoneCopy();
  const doneLabel = opts.doneLabel ?? copy.doneLabel;
  const expandLabel = opts.expandLabel ?? copy.expandLabel;
  const full = opts.fullText.trim();
  const thinkingId = stashFrozenThinking(full);
  return (
    `<div class="term-shell-agent-card term-shell-agent-card--note is-done is-fixed is-expandable"` +
    ` data-session-id="${escapeHtmlAttr(opts.sessionId)}"` +
    ` data-shell-agent-frozen-thinking="1"` +
    ` data-thinking-id="${escapeHtmlAttr(thinkingId)}"` +
    ` data-thinking-full="${escapeHtmlAttr(full)}"` +
    ` role="button" tabindex="0">` +
    `<span class="term-shell-agent-ico term-shell-agent-ico--check" aria-hidden>✓</span>` +
    `<div class="term-shell-agent-card__note">${escapeHtmlText(doneLabel)}</div>` +
    `<div class="term-shell-agent-card__note-actions">` +
    `<button type="button" class="term-shell-agent-btn term-shell-agent-btn--ghost" data-shell-agent-frozen-expand="1">${escapeHtmlText(expandLabel)}</button>` +
    `</div>` +
    `<textarea class="term-shell-agent-thinking-src" hidden readonly>${escapeHtmlText(full)}</textarea>` +
    `</div>`
  );
}

/** 同意执行前缓存命令，归档时封成「已同意」卡（避免被工具条同槽顶替） */
export type ShellAgentLastCmd = {
  command: string;
  toolName?: string;
  toolId?: string;
  /** 待确认卡旁注，冻结时保留 */
  description?: string;
};

const lastCmdBySession = new Map<string, ShellAgentLastCmd>();

export function setShellAgentLastCmd(
  sessionId: string,
  cmd: ShellAgentLastCmd,
): void {
  const command = cmd.command.trim();
  if (!command && !cmd.toolId) return;
  const prev = lastCmdBySession.get(sessionId);
  const toolChanged = Boolean(cmd.toolId) && cmd.toolId !== prev?.toolId;
  lastCmdBySession.set(sessionId, {
    command,
    toolName: cmd.toolName,
    toolId: cmd.toolId,
    description:
      cmd.description !== undefined
        ? cmd.description.trim()
        : toolChanged
          ? undefined
          : prev?.description,
  });
}

export function getShellAgentLastCmd(sessionId: string): ShellAgentLastCmd | null {
  return lastCmdBySession.get(sessionId) ?? null;
}

/** 把命令工具的 outputJson 收成可展示的执行结果 */
export function formatShellAgentToolResult(raw: string | undefined): string {
  const text = raw?.trim() ?? "";
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { output?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.output === "string") {
      return parsed.output.trim();
    }
  } catch {
    // 不是 payload JSON，原样展示
  }
  return text;
}

/** 执行结束后把结果写进已冻结的确认卡，展开不依赖当前轮 thread */
export function stampFrozenCmdResultInRoot(
  root: ParentNode,
  sessionId: string,
  toolId: string,
  result: string,
): void {
  const trimmed = result.trim();
  if (!trimmed) return;
  const sid = sessionId.replace(/"/g, "");
  const cards = root.querySelectorAll(
    `.term-shell-agent-card[data-shell-agent-frozen-cmd="1"][data-session-id="${sid}"]`,
  );
  for (const card of cards) {
    if (!(card instanceof HTMLElement)) continue;
    const id = card.getAttribute("data-tool-id") || "";
    if (toolId && id && id !== toolId) continue;
    card.setAttribute("data-tool-result", trimmed);
  }
}

export function clearShellAgentLastCmd(sessionId: string): void {
  lastCmdBySession.delete(sessionId);
  confirmFreezeIntent.delete(sessionId);
}

/** 同意/拒绝后下一次 archive 必须冻成对应确认卡（勿被已切到工具条的 liveHtml 抢走） */
type ConfirmFreezeKind = "agreed" | "rejected";
const confirmFreezeIntent = new Map<string, ConfirmFreezeKind>();

export function markShellAgentConfirmFreeze(
  sessionId: string,
  kind: ConfirmFreezeKind,
): void {
  confirmFreezeIntent.set(sessionId, kind);
}

export function consumeShellAgentConfirmFreeze(
  sessionId: string,
): ConfirmFreezeKind | null {
  const kind = confirmFreezeIntent.get(sessionId) ?? null;
  if (kind) confirmFreezeIntent.delete(sessionId);
  return kind;
}

/** 丢弃过期同意/拒绝冻结意图（新待确认到达时调用，防误冻） */
export function clearShellAgentConfirmFreeze(sessionId: string): void {
  confirmFreezeIntent.delete(sessionId);
}

/** @deprecated 用 markShellAgentConfirmFreeze(sessionId, "agreed") */
export function markShellAgentAgreedFreeze(sessionId: string): void {
  markShellAgentConfirmFreeze(sessionId, "agreed");
}

/** @deprecated 用 consumeShellAgentConfirmFreeze */
export function consumeShellAgentAgreedFreeze(sessionId: string): boolean {
  return consumeShellAgentConfirmFreeze(sessionId) === "agreed";
}


export function agreedCmdCopy(): {
  agreedLabel: string;
  viewLabel: string;
  willExecute: string;
} {
  const lang =
    typeof document !== "undefined" ? document.documentElement.lang || "zh-CN" : "zh-CN";
  if (lang.toLowerCase().startsWith("en")) {
    return {
      agreedLabel: "Agreed",
      viewLabel: "View",
      willExecute: "Will run on host",
    };
  }
  return {
    agreedLabel: "已同意",
    viewLabel: "查看",
    willExecute: "将在主机执行",
  };
}

export function rejectedCmdCopy(): {
  rejectedLabel: string;
  notExecuted: string;
} {
  const lang =
    typeof document !== "undefined" ? document.documentElement.lang || "zh-CN" : "zh-CN";
  if (lang.toLowerCase().startsWith("en")) {
    return {
      rejectedLabel: "Rejected",
      notExecuted: "Not executed",
    };
  }
  return {
    rejectedLabel: "已拒绝",
    notExecuted: "未执行",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 主按钮文案后可能带 Enter 快捷键徽章 */
const OPTIONAL_ENTER_KBD = `(?:\\s*<kbd[\\s\\S]*?</kbd>)?`;

function ensureAttrClass(attrs: string, token: string): string {
  if (new RegExp(`(?:^|\\s)${token}(?:\\s|$)`).test(attrs)) return attrs;
  if (/class="/.test(attrs)) {
    return attrs.replace(/class="/, `class="${token} `);
  }
  return `${attrs} class="${token}"`;
}

function annotateFrozenConfirmRoot(
  liveHtml: string,
  opts: {
    sessionId: string;
    command?: string;
    toolId?: string;
    stateClass: "is-agreed" | "is-rejected";
  },
): string | null {
  const html = liveHtml.trim();
  if (!html.includes("term-shell-agent-card--cmd")) return null;
  if (
    !html.includes("term-shell-agent-card__actions") &&
    !html.includes("is-pending") &&
    !html.includes("is-danger")
  ) {
    return null;
  }
  if (html.includes("term-shell-agent-tool")) return null;

  return html.replace(
    /<div(\s+)([^>]*class="[^"]*term-shell-agent-card--cmd[^"]*"[^>]*)>/,
    (_full, sp: string, attrs: string) => {
      let a = attrs
        .replace(/\bis-pending\b/g, opts.stateClass)
        .replace(/\bis-danger\b/g, opts.stateClass)
        .replace(/\bis-agreed\b/g, opts.stateClass)
        .replace(/\bis-rejected\b/g, opts.stateClass);
      a = ensureAttrClass(a, opts.stateClass);
      a = ensureAttrClass(a, "is-done");
      a = ensureAttrClass(a, "is-expandable");
      if (!/\bdata-shell-agent-frozen-cmd=/.test(a)) {
        a += ` data-shell-agent-frozen-cmd="1"`;
      }
      if (!/\bdata-session-id=/.test(a)) {
        a += ` data-session-id="${escapeHtmlAttr(opts.sessionId)}"`;
      }
      const toolId = opts.toolId?.trim();
      if (toolId && !/\bdata-tool-id=/.test(a)) {
        a += ` data-tool-id="${escapeHtmlAttr(toolId)}"`;
      }
      const command = opts.command?.trim();
      if (command && !/\bdata-tool-command=/.test(a)) {
        a += ` data-tool-command="${escapeHtmlAttr(command)}"`;
      }
      if (!/\brole=/.test(a)) a += ` role="button" tabindex="0"`;
      return `<div${sp}${a}>`;
    },
  );
}

function replaceConfirmStatusLabel(html: string, label: string): string {
  const statusFrom = [
    "待确认",
    "Pending approval",
    "危险操作",
    "High-risk action",
    "已同意",
    "Agreed",
    "已拒绝",
    "Rejected",
  ];
  let out = html;
  for (const from of statusFrom) {
    out = out.replace(
      new RegExp(
        `(<span class="term-shell-agent-card__status-label[^"]*">)\\s*${escapeRegExp(from)}\\s*(</span>)`,
      ),
      `$1${label}$2`,
    );
  }
  return out;
}

function replaceConfirmMeta(html: string, meta: string): string {
  return html.replace(
    /(<span class="term-shell-agent-card__head-meta">)[\s\S]*?(<\/span>)/,
    `$1${meta}$2`,
  );
}

function stripSecondaryConfirmActions(html: string): string {
  return html.replace(
    /<button\b[^>]*class="[^"]*term-shell-agent-btn(?![^"]*--(?:primary|danger))[^"]*"[^>]*>[\s\S]*?<\/button>/g,
    "",
  );
}

/**
 * 把待确认卡 live HTML 就地改成「已同意」态：保留说明/命令，
 * 顶部状态与主按钮改为已同意，并移除拒绝/编辑。
 */
export function transformPendingConfirmToAgreedHtml(
  liveHtml: string,
  opts: { sessionId: string; command?: string; toolId?: string },
): string | null {
  const copy = agreedCmdCopy();
  let out = annotateFrozenConfirmRoot(liveHtml, {
    ...opts,
    stateClass: "is-agreed",
  });
  if (!out) return null;

  out = replaceConfirmStatusLabel(out, copy.agreedLabel);
  out = out.replace(
    /term-shell-agent-card__status-label\s+(danger|accent)/g,
    "term-shell-agent-card__status-label accent",
  );

  const agreeFrom = [
    "同意并执行",
    "Agree & run",
    "确认执行",
    "Confirm run",
    "已拒绝",
    "Rejected",
  ];
  for (const label of agreeFrom) {
    out = out.replace(
      new RegExp(
        `(class="[^"]*term-shell-agent-btn--(?:primary|danger)[^"]*"[^>]*>)\\s*${escapeRegExp(label)}${OPTIONAL_ENTER_KBD}\\s*(</button>)`,
      ),
      `$1${copy.agreedLabel}$2`,
    );
  }
  out = stripSecondaryConfirmActions(out);
  return out;
}

/**
 * 把待确认卡改成「已拒绝」态：同布局，顶部/主按钮改文案与样式，去掉同意与编辑。
 */
export function transformPendingConfirmToRejectedHtml(
  liveHtml: string,
  opts: { sessionId: string; command?: string; toolId?: string },
): string | null {
  const copy = rejectedCmdCopy();
  let out = annotateFrozenConfirmRoot(liveHtml, {
    ...opts,
    stateClass: "is-rejected",
  });
  if (!out) return null;

  out = replaceConfirmStatusLabel(out, copy.rejectedLabel);
  out = out.replace(
    /term-shell-agent-card__status-label\s+(danger|accent)/g,
    "term-shell-agent-card__status-label muted",
  );
  out = replaceConfirmMeta(out, copy.notExecuted);

  // 先去掉拒绝/编辑，再改主按钮（否则 --muted 会被当成次要按钮清掉）
  out = stripSecondaryConfirmActions(out);

  const primaryFrom = [
    "同意并执行",
    "Agree & run",
    "确认执行",
    "Confirm run",
    "已同意",
    "Agreed",
  ];
  for (const label of primaryFrom) {
    out = out.replace(
      new RegExp(
        `class="([^"]*)term-shell-agent-btn--(?:primary|danger)([^"]*)"([^>]*>)\\s*${escapeRegExp(label)}${OPTIONAL_ENTER_KBD}\\s*(</button>)`,
      ),
      `class="$1term-shell-agent-btn--muted$2"$3${copy.rejectedLabel}$4`,
    );
  }
  return out;
}

/** 归档用：已同意命令卡 —— 布局对齐待确认卡（说明 + 命令 + 操作区） */
export function buildAgreedCmdFrozenHtml(opts: {
  sessionId: string;
  command: string;
  toolId?: string;
  description?: string;
  agreedLabel?: string;
  viewLabel?: string;
}): string {
  const copy = agreedCmdCopy();
  const agreedLabel = opts.agreedLabel ?? copy.agreedLabel;
  const command = opts.command.trim();
  const toolId = opts.toolId?.trim() ?? "";
  const description = (opts.description ?? "").trim();
  return (
    `<div class="term-shell-agent-card term-shell-agent-card--cmd is-agreed is-done is-expandable"` +
    ` data-session-id="${escapeHtmlAttr(opts.sessionId)}"` +
    ` data-shell-agent-frozen-cmd="1"` +
    ` data-tool-id="${escapeHtmlAttr(toolId)}"` +
    ` data-tool-command="${escapeHtmlAttr(command)}"` +
    ` role="button" tabindex="0">` +
    `<div class="term-shell-agent-card__head">` +
    `<span class="term-shell-agent-ico term-shell-agent-ico--ai" aria-hidden>AI</span>` +
    `<span class="term-shell-agent-card__status-label accent">${escapeHtmlText(agreedLabel)}</span>` +
    `<span class="term-shell-agent-card__head-spacer"></span>` +
    `<span class="term-shell-agent-card__head-meta">${escapeHtmlText(copy.willExecute)}</span>` +
    `</div>` +
    `<div class="term-shell-agent-card__body">` +
    (description
      ? `<p class="term-shell-agent-card__desc">${escapeHtmlText(description)}</p>`
      : "") +
    `<pre class="term-shell-agent-card__code"><code>${escapeHtmlText(command)}</code></pre>` +
    `<div class="term-shell-agent-card__actions">` +
    `<button type="button" class="term-shell-agent-btn term-shell-agent-btn--primary" disabled>${escapeHtmlText(agreedLabel)}</button>` +
    `</div>` +
    `</div></div>`
  );
}

/** 归档用：已拒绝命令卡 —— 同待确认布局 */
export function buildRejectedCmdFrozenHtml(opts: {
  sessionId: string;
  command: string;
  toolId?: string;
  description?: string;
  rejectedLabel?: string;
}): string {
  const copy = rejectedCmdCopy();
  const rejectedLabel = opts.rejectedLabel ?? copy.rejectedLabel;
  const command = opts.command.trim();
  const toolId = opts.toolId?.trim() ?? "";
  const description = (opts.description ?? "").trim();
  return (
    `<div class="term-shell-agent-card term-shell-agent-card--cmd is-rejected is-done is-expandable"` +
    ` data-session-id="${escapeHtmlAttr(opts.sessionId)}"` +
    ` data-shell-agent-frozen-cmd="1"` +
    ` data-tool-id="${escapeHtmlAttr(toolId)}"` +
    ` data-tool-command="${escapeHtmlAttr(command)}"` +
    ` role="button" tabindex="0">` +
    `<div class="term-shell-agent-card__head">` +
    `<span class="term-shell-agent-ico term-shell-agent-ico--ai" aria-hidden>AI</span>` +
    `<span class="term-shell-agent-card__status-label muted">${escapeHtmlText(rejectedLabel)}</span>` +
    `<span class="term-shell-agent-card__head-spacer"></span>` +
    `<span class="term-shell-agent-card__head-meta">${escapeHtmlText(copy.notExecuted)}</span>` +
    `</div>` +
    `<div class="term-shell-agent-card__body">` +
    (description
      ? `<p class="term-shell-agent-card__desc">${escapeHtmlText(description)}</p>`
      : "") +
    `<pre class="term-shell-agent-card__code"><code>${escapeHtmlText(command)}</code></pre>` +
    `<div class="term-shell-agent-card__actions">` +
    `<button type="button" class="term-shell-agent-btn term-shell-agent-btn--muted" disabled>${escapeHtmlText(rejectedLabel)}</button>` +
    `</div>` +
    `</div></div>`
  );
}
