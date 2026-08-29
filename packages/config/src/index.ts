/**
 * Aervox｜思隅 @aervox/config — 运行时配置（缺陷 E）
 *
 * 把散落在 api/worker 的 process.env 直读收敛为单一类型化配置：
 * - 集中默认值：每个键在一个地方给出默认；
 * - 启动期校验：非法值（数字/枚举）fail-fast 抛错，杜绝配置漂移静默失效；
 * - 优先级沿用既定声明：进程环境变量 > .env > mise [env] > 代码内置默认；
 * - 纯函数式 loadXxxConfig(env?)：测试可注入 env，不依赖进程全局状态。
 */
export type LoopProvider =
  | "replay"
  | "scripted"
  | "scripted-write"
  | "scripted-privileged"
  | "scripted-quiz"
  | "llm";

/**
 * Turn 执行模式（AERVOX_TURN_EXECUTION）：
 * - background（默认）：POST /turns 落库后立即返回，Agent Loop 后台执行，
 *   客户端经 SSE 活流（重放 + tail）观察进度——深度思考等长回合不再阻塞 HTTP 响应；
 * - inline：POST 内联等 Loop 跑完再返回（旧语义；测试与排查用）。
 */
export type TurnExecution = "background" | "inline";

/** GPT-Sovits 语音输出 provider 配置（voice 模块） */
export interface GptSovitsConfig {
  modelPath?: string;
  allowedRoots: string[];
  endpoint?: string;
  protocol: "http" | "websocket";
  modelId: string;
  secretRef?: string;
}

/** 本地/远程语音识别 provider 配置（voice 模块） */
export interface AsrConfig {
  senseVoiceBaseUrl: string;
  senseVoiceModelPath?: string;
  senseVoiceAllowedRoots: string[];
  whisperEndpoint?: string;
  whisperApiKey?: string;
  whisperModelId: string;
}

/** 出站 MCP Server 配置（AERVOX_MCP_SERVERS，JSON 数组；CR-029） */
export interface McpServerConfig {
  /** 服务标识（用于工具命名空间 mcp_<id>_<tool>，需匹配 [a-z0-9_-]） */
  id: string;
  /** 展示名（缺省用 id） */
  name?: string;
  /** Streamable HTTP 端点（如 https://mcp.mcd.cn） */
  url: string;
  /** Bearer Token（写入 Authorization: Bearer <token>；缺省表示无鉴权） */
  token?: string;
  /** 是否启用（缺省 true） */
  enabled?: boolean;
}

/** @aervox/api 启动与运行时配置 */
export interface ApiConfig {
  /** HTTP 监听端口（PORT，默认 3000） */
  port: number;
  /** Agent Loop 模型 Provider（AERVOX_LOOP_PROVIDER，默认 llm） */
  loopProvider: LoopProvider;
  /** Turn 执行模式（AERVOX_TURN_EXECUTION，默认 background） */
  turnExecution: TurnExecution;
  /** Context 压缩方式：rule | off（AERVOX_LOOP_COMPACTION，默认 off） */
  loopCompaction: "rule" | "off";
  /** 3b privileged 工具管理员白名单（AERVOX_ADMIN_IDS，逗号分隔，默认空） */
  adminIds: string[];
  gptSovits: GptSovitsConfig;
  asr: AsrConfig;
  /** 出站 MCP Server 清单（AERVOX_MCP_SERVERS JSON；解析失败安全降级为空数组） */
  mcpServers: McpServerConfig[];
}

/** @aervox/worker 运行时配置 */
export interface WorkerConfig {
  workerId: string;
  /** 任务默认节拍（WORKER_TICK_MS，默认 5000） */
  tickMs: number;
  /**
   * 按任务独立节拍覆盖（WORKER_INTERVAL_<NAME>_MS）。
   * 解析失败的 key 回退默认并告警（worker 侧容错语义保留）。
   */
  intervalOverrides: Record<string, number>;
}

/** 拆分逗号/冒号分隔白名单（去空） */
const splitList = (raw: string | undefined, sep: string): string[] =>
  (raw ?? "").split(sep).map((s) => s.trim()).filter((s) => s.length > 0);

/** 启动期校验：数字必须为正整数 */
function requirePositiveInt(name: string, raw: string | undefined, fallback: number, fatal = true): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  if (fatal) throw new Error(`[config] ${name}=${raw} is not a valid positive integer`);
  return fallback;
}

/** 启动期校验：枚举 */
function requireEnum<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = raw?.trim();
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`[config] ${name}=${value} is invalid; expected one of ${allowed.join(" | ")}`);
}

/** 加载 @aervox/api 配置（可注入 env 便于测试；默认读取进程环境变量） */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const gptSovitsProtocol = requireEnum(
    "GPT_SOVITS_PROTOCOL",
    env.GPT_SOVITS_PROTOCOL,
    ["http", "websocket"] as const,
    "http",
  );
  return {
    port: requirePositiveInt("PORT", env.PORT, 3000),
    loopProvider: requireEnum(
      "AERVOX_LOOP_PROVIDER",
      env.AERVOX_LOOP_PROVIDER,
      ["replay", "scripted", "scripted-write", "scripted-privileged", "scripted-quiz", "llm"] as const,
      "llm",
    ),
    turnExecution: requireEnum(
      "AERVOX_TURN_EXECUTION",
      env.AERVOX_TURN_EXECUTION,
      ["background", "inline"] as const,
      "background",
    ),
    loopCompaction: requireEnum(
      "AERVOX_LOOP_COMPACTION",
      env.AERVOX_LOOP_COMPACTION,
      ["rule", "off"] as const,
      "off",
    ),
    adminIds: splitList(env.AERVOX_ADMIN_IDS, ","),
    gptSovits: {
      modelPath: env.GPT_SOVITS_MODEL_PATH?.trim() || undefined,
      allowedRoots: splitList(env.GPT_SOVITS_ALLOWED_ROOTS, ":"),
      endpoint: env.GPT_SOVITS_ENDPOINT?.trim() || undefined,
      protocol: gptSovitsProtocol,
      modelId: env.GPT_SOVITS_MODEL_ID?.trim() || "default-remote",
      secretRef: env.GPT_SOVITS_SECRET_REF?.trim() || undefined,
    },
    asr: {
      senseVoiceBaseUrl:
        env.SENSEVOICE_MODEL_BASE_URL?.trim() ||
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
      senseVoiceModelPath: env.SENSEVOICE_MODEL_PATH?.trim() || undefined,
      senseVoiceAllowedRoots: splitList(env.SENSEVOICE_ALLOWED_ROOTS, ":"),
      whisperEndpoint: env.WHISPER_ENDPOINT?.trim() || undefined,
      whisperApiKey: env.WHISPER_API_KEY?.trim() || undefined,
      whisperModelId: env.WHISPER_MODEL_ID?.trim() || "whisper-1",
    },
    mcpServers: parseMcpServers(env.AERVOX_MCP_SERVERS),
  };
}

/**
 * 解析出站 MCP Server 清单（AERVOX_MCP_SERVERS，JSON 数组）。
 * 配置非法（非 JSON/缺 id/url）时丢弃非法项并 console.warn——外接 MCP 属增强能力，
 * 不因配置错误阻断 API 启动；启用开关 enabled === false 的项过滤。
 */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.warn(
      "[config] AERVOX_MCP_SERVERS 不是合法 JSON，外接 MCP Server 全部忽略：",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("[config] AERVOX_MCP_SERVERS 应为 JSON 数组，已忽略");
    return [];
  }
  const servers: McpServerConfig[] = [];
  for (const item of parsed) {
    const candidate = item as Partial<McpServerConfig> | null;
    const id = typeof candidate?.id === "string" ? candidate.id.trim().toLowerCase() : "";
    const url = typeof candidate?.url === "string" ? candidate.url.trim() : "";
    if (
      !/^[a-z0-9_-]+$/.test(id) ||
      !/^https?:\/\//.test(url)
    ) {
      console.warn(`[config] AERVOX_MCP_SERVERS 项非法（id 需匹配 [a-z0-9_-]，url 需 http(s)）：${id || "(空)"}`);
      continue;
    }
    if (candidate?.enabled === false) continue;
    servers.push({
      id,
      ...(typeof candidate?.name === "string" && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
      url,
      ...(typeof candidate?.token === "string" && candidate.token.trim() ? { token: candidate.token.trim() } : {}),
    });
  }
  return servers;
}

/** 加载 @aervox/worker 配置（可注入 env 便于测试；默认读取进程环境变量） */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const tickMs = requirePositiveInt("WORKER_TICK_MS", env.WORKER_TICK_MS, 5000);
  const intervalOverrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^WORKER_INTERVAL_([A-Z0-9_-]+)_MS$/.exec(key);
    if (!match) continue;
    if (value === undefined) continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      intervalOverrides[match[1]!.toLowerCase()] = parsed;
    } else {
      // worker 既有语义：非法覆盖值回退默认并告警（不阻断启动）
      console.warn(`[config] invalid ${key}=${value}; fallback to WORKER_TICK_MS=${tickMs}`);
    }
  }
  return {
    workerId: env.WORKER_ID?.trim() || `worker_${Date.now().toString(36)}`,
    tickMs,
    intervalOverrides,
  };
}