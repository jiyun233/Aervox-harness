/**
 * Aervox｜思隅 @aervox/api — 出站 MCP 工具桥（CR-029）
 *
 * 把远端 MCP Server 的 tools/list 映射为 ToolProviderPort：
 * - 命名空间：`mcp_<serverId>_<toolName>`（对齐 persona 配置 allowedMcpToolIds 预留位）；
 * - 审批分级：名称命中写操作模式（create/add/submit/redeem/draw/exchange/receive/order）
 *   → readOnly: false（走既有授权闸门）；其余按只读放行；
 * - 工具清单带 TTL 缓存，避免每个 Turn 重复 initialize + tools/list（远端限流 600 req/min）。
 */
import type { ToolExecutionInput, ToolExecutionResult, ToolProviderPort } from "@aervox/agent-loop";
import type { ToolSpec } from "@aervox/agent-loop";
import type { McpServerConfig } from "@aervox/config";
import { McpHttpClient, type McpRemoteTool } from "./mcp-client.js";

const LIST_CACHE_TTL_MS = 5 * 60_000;

/**
 * 只读白名单判定：名称命中查询类模式（query/get/list/search/fetch/check/view/
 * detail/history/info/time 等）才免审批；其余（含无法判断的未知工具）一律
 * readOnly: false 走既有授权闸门——对外接工具 fail-safe，宁可多问一次。
 */
const READ_TOOL_PATTERN =
  /(query|get|list|search|fetch|check|view|detail|history|info|time|menu|price|calc|available|calendar|products|survey)/i;

export interface QualifiedMcpTool {
  serverId: string;
  serverName: string;
  /** 桥接后的限定名（mcp_<serverId>_<tool>） */
  qualifiedName: string;
  remoteName: string;
  description?: string;
  inputSchema?: unknown;
  readOnly: boolean;
}

export interface McpServerProbe {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  toolCount: number;
  tools: Array<{ name: string; description?: string; readOnly: boolean }>;
  error?: string;
}

/** 生成合法工具限定名：非 [a-zA-Z0-9_-] 字符折叠为下划线 */
export function qualifyMcpToolName(serverId: string, toolName: string): string {
  const sanitized = toolName.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `mcp_${serverId}_${sanitized}`;
}

/** 只读判定：名称命中查询类模式 → 免审批；否则需授权（fail-safe） */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_TOOL_PATTERN.test(toolName);
}

function toQualified(
  server: McpServerConfig,
  tool: McpRemoteTool,
): QualifiedMcpTool {
  const readOnly = isReadOnlyTool(tool.name);
  return {
    serverId: server.id,
    serverName: server.name ?? server.id,
    qualifiedName: qualifyMcpToolName(server.id, tool.name),
    remoteName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly,
  };
}

const listCache = new Map<
  string,
  { at: number; tools: QualifiedMcpTool[] }
>();

function cacheKey(server: McpServerConfig): string {
  return `${server.id}|${server.url}`;
}

/** 拉取单个 Server 的工具清单（优先读 TTL 缓存；forceRefresh 忽略缓存） */
export async function listServerTools(
  server: McpServerConfig,
  options: { forceRefresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<QualifiedMcpTool[]> {
  const key = cacheKey(server);
  const cached = listCache.get(key);
  if (!options.forceRefresh && cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
    return cached.tools;
  }
  const client = new McpHttpClient(server, { fetchImpl: options.fetchImpl });
  const remoteTools = await client.listTools();
  const tools = remoteTools.map((tool) => toQualified(server, tool));
  listCache.set(key, { at: Date.now(), tools });
  return tools;
}

/** 探测全部已配置 Server（GET /v1/tools/mcp/external 用；单 Server 失败不影响其余） */
export async function probeMcpServers(
  servers: McpServerConfig[],
  options: { forceRefresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<McpServerProbe[]> {
  return Promise.all(
    servers.map(async (server): Promise<McpServerProbe> => {
      try {
        const tools = await listServerTools(server, options);
        return {
          id: server.id,
          name: server.name ?? server.id,
          url: server.url,
          ok: true,
          toolCount: tools.length,
          tools: tools.map((t) => ({
            name: t.qualifiedName,
            description: t.description,
            readOnly: t.readOnly,
          })),
        };
      } catch (error) {
        return {
          id: server.id,
          name: server.name ?? server.id,
          url: server.url,
          ok: false,
          toolCount: 0,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/** 清空工具清单缓存（测试用） */
export function clearMcpListCache(): void {
  listCache.clear();
}

/**
 * 构建外接 MCP 工具提供者：先按 Server 拉取清单（失败的 Server 跳过并 warn），
 * 未产出任何工具时返回 undefined（不注册空 Provider）。
 */
export async function createMcpToolProvider(
  servers: McpServerConfig[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ToolProviderPort | undefined> {
  const qualified: QualifiedMcpTool[] = [];
  const clients = new Map<string, McpHttpClient>();

  for (const server of servers) {
    const client = new McpHttpClient(server, options);
    try {
      const cached = listCache.get(cacheKey(server));
      let tools: QualifiedMcpTool[];
      if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
        // 缓存命中：免握手；调用客户端惰性 initialize（callTool 内部保证）
        tools = cached.tools;
      } else {
        // 复用同一客户端完成 list（已握手、保持会话），后续 call 不再重握手
        tools = (await client.listTools()).map((tool) => toQualified(server, tool));
        listCache.set(cacheKey(server), { at: Date.now(), tools });
      }
      qualified.push(...tools);
      clients.set(server.id, client);
    } catch (error) {
      console.warn(
        `[mcp-bridge] 外接 MCP Server "${server.id}" 工具拉取失败，已跳过：`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (qualified.length === 0) return undefined;

  const specByName = new Map<string, QualifiedMcpTool>();
  const specs: ToolSpec[] = qualified.map((tool) => {
    specByName.set(tool.qualifiedName, tool);
    return {
      name: tool.qualifiedName,
      description: `${tool.description ?? tool.remoteName}（外接 MCP：${tool.serverName}）`,
      readOnly: tool.readOnly,
      ...(tool.inputSchema && typeof tool.inputSchema === "object"
        ? { parameters: tool.inputSchema as Record<string, unknown> }
        : {}),
    };
  });

  return {
    tools: specs,
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const tool = specByName.get(input.name);
      if (!tool) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }
      let client = clients.get(tool.serverId);
      if (!client) {
        const server = servers.find((s) => s.id === tool.serverId);
        if (!server) return { ok: false, error: `mcp server missing: ${tool.serverId}` };
        client = new McpHttpClient(server, { fetchImpl: options.fetchImpl });
        clients.set(tool.serverId, client);
      }
      try {
        const result = await client.callTool(tool.remoteName, input.arguments);
        const text = result.content
          .map((block) => (typeof block.text === "string" ? block.text : JSON.stringify(block)))
          .filter(Boolean)
          .join("\n");
        return {
          ok: !result.isError,
          ...(result.isError
            ? { error: text || "mcp tool reported error" }
            : { output: text || result.content }),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
