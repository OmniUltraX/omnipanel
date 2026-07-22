/**
 * AI 工具风险判定纯函数模块。
 *
 * 从 actionStore 的 enqueueAction 逻辑中抽取，供 actionDraftStore 在 AI 工具审批时复用。
 * 支持两种风险来源：
 * 1. 命令型工具（SSH exec / terminal）：复用 commandGuard.checkCommand 的正则匹配
 * 2. 非命令型工具（Docker action / Files write）：按工具名 + 参数关键字做模式匹配
 */
import { checkCommand, type DangerCheckResult, type DangerLevel } from "../commandGuard";
import { getResourceById, type EnvironmentTag } from "../resourceRegistry";

const DANGER_ORDER: DangerLevel[] = ["low", "medium", "high", "critical"];

function maxDangerLevel(a: DangerLevel, b: DangerLevel): DangerLevel {
  return DANGER_ORDER.indexOf(a) >= DANGER_ORDER.indexOf(b) ? a : b;
}

/** 非命令型工具的危险操作关键字（Docker action / Files write 等） */
const TOOL_DANGER_KEYWORDS: Record<string, { keywords: string[]; level: DangerLevel; desc: string }> = {
  docker_action: {
    keywords: ["kill", "remove", "rm", "prune", "stop", "restart"],
    level: "high",
    desc: "Docker 容器危险操作",
  },
  docker_image_action: {
    keywords: ["rmi", "remove", "prune"],
    level: "high",
    desc: "Docker 镜像删除",
  },
  docker_volume_action: {
    keywords: ["remove", "rm", "prune"],
    level: "critical",
    desc: "Docker 卷删除（数据不可恢复）",
  },
  files_write: {
    keywords: ["/etc/", "/boot/", "/sys/", "/proc/", "C:\\Windows\\", "C:\\Program Files"],
    level: "high",
    desc: "写入系统关键路径",
  },
};

export interface ToolRiskAssessment {
  /** 综合风险等级（命令风险 + 环境风险取最高） */
  risk: DangerLevel;
  /** 命令风险检测结果（命令型工具有值） */
  riskCheck?: DangerCheckResult;
  /** 资源环境标签 */
  environment: EnvironmentTag;
  /** 是否需要审批（risk !== "low" 即需审批） */
  needsApproval: boolean;
}

/**
 * 评估 AI 工具调用的风险等级。
 *
 * @param toolName 工具名（如 omni_ssh_exec / omni_docker_container_action / omni_files_write）
 * @param args 工具参数 JSON 字符串
 * @param resourceId 可选的资源 ID（用于解析环境标签）
 * @returns 风险评估结果
 */
export function evaluateToolRisk(
  toolName: string,
  args: string,
  resourceId?: string,
): ToolRiskAssessment {
  const resource = resourceId ? getResourceById(resourceId) : undefined;
  const environment = resource?.environment ?? "unknown";
  const envRisk: DangerLevel = environment === "prod" ? "high" : environment === "staging" ? "medium" : "low";

  let riskCheck: DangerCheckResult | undefined;
  let toolRisk: DangerLevel = "low";

  // 命令型工具：提取 command 字段，走 commandGuard
  let command: string | undefined;
  let parsedArgs: Record<string, unknown> = {};
  try {
    parsedArgs = args ? JSON.parse(args) : {};
  } catch {
    // JSON 解析失败时回退为原始字符串
    parsedArgs = { command: args };
  }

  if (typeof parsedArgs.command === "string") {
    command = parsedArgs.command;
  } else if (typeof parsedArgs.sql === "string") {
    command = parsedArgs.sql;
  } else if (typeof parsedArgs.action === "string") {
    command = parsedArgs.action;
  } else if (typeof parsedArgs.path === "string") {
    command = parsedArgs.path;
  }

  // 命令型工具走 commandGuard
  if (command) {
    riskCheck = checkCommand(command, environment);
    toolRisk = riskCheck.level;
  }

  // 非命令型工具按工具名 + 关键字匹配
  if (toolName.includes("docker_container_action") && typeof parsedArgs.action === "string") {
    const rule = TOOL_DANGER_KEYWORDS.docker_action;
    if (rule.keywords.some((kw) => parsedArgs.action.toLowerCase().includes(kw))) {
      toolRisk = maxDangerLevel(toolRisk, rule.level);
      riskCheck = riskCheck ?? {
        safe: false,
        level: rule.level,
        matches: [{ desc: rule.desc, level: rule.level }],
      };
    }
  } else if (toolName.includes("docker_image") && typeof parsedArgs.action === "string") {
    const rule = TOOL_DANGER_KEYWORDS.docker_image_action;
    if (rule.keywords.some((kw) => parsedArgs.action.toLowerCase().includes(kw))) {
      toolRisk = maxDangerLevel(toolRisk, rule.level);
      riskCheck = riskCheck ?? {
        safe: false,
        level: rule.level,
        matches: [{ desc: rule.desc, level: rule.level }],
      };
    }
  } else if (toolName.includes("docker_volume") && typeof parsedArgs.action === "string") {
    const rule = TOOL_DANGER_KEYWORDS.docker_volume_action;
    if (rule.keywords.some((kw) => parsedArgs.action.toLowerCase().includes(kw))) {
      toolRisk = maxDangerLevel(toolRisk, rule.level);
      riskCheck = riskCheck ?? {
        safe: false,
        level: rule.level,
        matches: [{ desc: rule.desc, level: rule.level }],
      };
    }
  } else if (toolName.includes("files_write") && typeof parsedArgs.path === "string") {
    const rule = TOOL_DANGER_KEYWORDS.files_write;
    if (rule.keywords.some((kw) => parsedArgs.path.includes(kw))) {
      toolRisk = maxDangerLevel(toolRisk, rule.level);
      riskCheck = riskCheck ?? {
        safe: false,
        level: rule.level,
        matches: [{ desc: rule.desc, level: rule.level }],
      };
    }
  }

  const risk = maxDangerLevel(toolRisk, envRisk);
  return {
    risk,
    riskCheck,
    environment,
    needsApproval: risk !== "low",
  };
}
