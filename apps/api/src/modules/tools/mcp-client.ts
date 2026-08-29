/**
 * Aervox｜思隅 @aervox/api — 出站 MCP 客户端（Streamable HTTP，CR-029）
 *
 * 自研轻量 JSON-RPC 客户端，对接远程托管 MCP Server（如麦当劳 open.mcd.cn）：
 * - initialize 握手（协议版本 2025-06-18）+ mcp-session-id 会话保持；
 * - tools/list / tools/call；响应兼容 application/json 与 text/event-stream（SSE 帧）两种返回；
 * - 无鉴权或 Bearer Token 鉴权（Authorization: Bearer <token>）；
 * - 会话失效（404）自动重握手一次；不引入第三方 MCP SDK（对齐 tools/mcp.ts 自研先例）。
 */
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;

/** 外接 MCP Server 的工具定义（tools/list 条目） */
export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  /** 服务端 isError 标记（业务失败） */
  isError?: boolean;
  /** 内容块（通常为 [{type:"text", text:"..."}]） */
  content: McpCallToolContent[];
}

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
}

export interface McpHttpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class McpHttpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private initialized = false;

  constructor(
    private readonly server: { id: string; url: string; token?: string },
    private readonly options: McpHttpClientOptions = {},
  ) {}

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extra,
    };
    if (this.server.token) headers.Authorization = `Bearer ${this.server.token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  /** 发送一次 JSON-RPC 请求；SSE 响应解析出匹配 id 的 result/error 帧 */
  private async rpc(
    method: string,
    params: unknown,
    options: { notify?: boolean } = {},
  ): Promise<unknown | undefined> {
    const id = options.notify ? undefined : this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (id !== undefined) body.id = id;
    if (params !== undefined) body.params = params;

    const response = await this.doFetch(body);
    if (options.notify) return undefined;

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const messages = contentType.includes("text/event-stream")
      ? parseSseMessages(text)
      : text.trim()
        ? [safeParseJson(text)]
        : [];

    if (id !== undefined) {
      let matched = messages.find(
        (m): m is JsonRpcResponse => Boolean(m) && (m as JsonRpcResponse).id === id,
      );
      // 容错：个别 Server 以 event-stream 头返回裸 JSON 体（无 data: 帧），回退整段解析
      if (!matched && contentType.includes("text/event-stream")) {
        const whole = safeParseJson(text);
        if (whole && whole.id === id) matched = whole;
      }
      if (!matched) {
        throw new McpClientError(
          `mcp ${this.server.id}: ${method} 响应中缺少匹配的 id 帧`,
          response.status,
        );
      }
      if (matched.error) {
        throw new McpClientError(
          `mcp ${this.server.id}: ${method} JSON-RPC 错误 ${matched.error.code ?? ""} ${matched.error.message ?? ""}`.trim(),
          response.status,
        );
      }
      return matched.result;
    }
    return undefined;
  }

  /** 带超时与一次会话重试的 POST；返回原始 Response 供 rpc 解析 */
  private async doFetch(body: Record<string, unknown>, retry = true): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(this.server.url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const cause = (error as { cause?: unknown })?.cause;
      const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
      throw new McpClientError(`mcp ${this.server.id}: fetch failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    // 会话头失效：重握手后重试一次
    if ((response.status === 404 || response.status === 400) && this.sessionId && retry) {
      this.sessionId = undefined;
      this.initialized = false;
      await this.ensureInitialized();
      return this.doFetch(body, false);
    }
    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 200);
      throw new McpClientError(
        `mcp ${this.server.id}: HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
        response.status,
      );
    }
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) this.sessionId = sessionHeader;
    return response;
  }

  /** initialize 握手 + initialized 通知（幂等） */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "aervox", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", undefined, { notify: true });
    this.initialized = true;
  }

  /** 拉取远端工具清单 */
  async listTools(): Promise<McpRemoteTool[]> {
    await this.ensureInitialized();
    const result = (await this.rpc("tools/list", {})) as { tools?: McpRemoteTool[] } | undefined;
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** 调用远端工具；返回内容块与 isError 标记 */
  async callTool(name: string, args: unknown): Promise<McpCallToolResult> {
    await this.ensureInitialized();
    const result = (await this.rpc("tools/call", { name, arguments: args ?? {} })) as
      | { content?: McpCallToolContent[]; isError?: boolean }
      | undefined;
    return {
      isError: Boolean(result?.isError),
      content: Array.isArray(result?.content) ? result.content : [],
    };
  }
}

/** 解析 SSE 文本为 JSON-RPC 消息帧（data: 行聚合，忽略注释/空行） */
export function parseSseMessages(text: string): JsonRpcResponse[] {
  const messages: JsonRpcResponse[] = [];
  let dataBuffer = "";
  const flush = () => {
    const payload = dataBuffer.trim();
    dataBuffer = "";
    if (!payload || payload === "[DONE]") return;
    const parsed = safeParseJson(payload);
    if (parsed) messages.push(parsed);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataBuffer += (dataBuffer ? "\n" : "") + line.slice(5).trim();
      continue;
    }
    if (line.trim() === "") flush();
  }
  flush();
  return messages;
}

function safeParseJson(text: string): JsonRpcResponse | undefined {
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return undefined;
  }
}
