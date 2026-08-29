/**
 * Aervox｜思隅 @aervox/api — 出站 MCP 客户端与工具桥测试（CR-029）
 */
import { describe, it, expect } from "vitest";
import { McpHttpClient, parseSseMessages, McpClientError } from "../src/modules/tools/mcp-client.js";
import {
  qualifyMcpToolName,
  isReadOnlyTool,
  createMcpToolProvider,
  clearMcpListCache,
  probeMcpServers,
} from "../src/modules/tools/mcp-bridge.js";
import { parseMcpServers } from "@aervox/config";

/** 构造可编程 mock fetch：按调用序返回响应并记录请求 */
function mockFetchFactory(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const index = calls.length;
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: (init?.body as string) ?? "",
    });
    const res = responses[Math.min(index, responses.length - 1)];
    return new Response(res.body ?? "", {
      status: res.status,
      headers: res.headers ?? {},
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("McpHttpClient（Streamable HTTP）", () => {
  it("initialize 握手 + initialized 通知 + tools/list，携带 Bearer 与会话头", async () => {
    const { fetchImpl, calls } = mockFetchFactory([
      { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }) },
      { status: 202 },
      { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_store_list", description: "查询门店" }] } }) },
    ]);
    const client = new McpHttpClient({ id: "mcd", url: "https://mcp.mcd.cn", token: "tok-123" }, { fetchImpl });
    const tools = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("get_store_list");
    // 三个请求：initialize → notifications/initialized → tools/list
    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(calls[0]?.body ?? "{}").method).toBe("initialize");
    expect(JSON.parse(calls[1]?.body ?? "{}").method).toBe("notifications/initialized");
    expect(calls[2]?.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(JSON.parse(calls[2]?.body ?? "{}").method).toBe("tools/list");
  });

  it("SSE（text/event-stream）响应解析出匹配 id 的帧", async () => {
    const sse = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"t1"}]}}',
      "",
      "",
    ].join("\n");
    const { fetchImpl } = mockFetchFactory([
      { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) },
      { status: 202 },
      { status: 200, headers: { "content-type": "text/event-stream" }, body: sse },
    ]);
    const client = new McpHttpClient({ id: "mcd", url: "https://mcp.mcd.cn" }, { fetchImpl });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["t1"]);
  });

  it("tools/call 映射 content 与 isError；JSON-RPC error 抛 McpClientError", async () => {
    const { fetchImpl } = mockFetchFactory([
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) },
      { status: 202 },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: false, content: [{ type: "text", text: "ok-data" }] } }) },
    ]);
    const client = new McpHttpClient({ id: "mcd", url: "https://mcp.mcd.cn" }, { fetchImpl });
    const result = await client.callTool("get_store_list", { city: "上海" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("ok-data");

    const fail = mockFetchFactory([
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) },
      { status: 202 },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "no such tool" } }) },
    ]);
    const client2 = new McpHttpClient({ id: "mcd", url: "https://mcp.mcd.cn" }, { fetchImpl: fail.fetchImpl });
    await expect(client2.callTool("nope", {})).rejects.toBeInstanceOf(McpClientError);
  });

  it("parseSseMessages 聚合多行 data 与忽略注释", () => {
    const frames = parseSseMessages(': ping\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\ndata: [DONE]\n');
    expect(frames).toHaveLength(1);
    expect((frames[0] as { id: number }).id).toBe(1);
  });
});

describe("MCP 工具桥（mcp-bridge）", () => {
  it("qualifyMcpToolName 折叠非法字符并加命名空间", () => {
    expect(qualifyMcpToolName("mcd", "get_store_list")).toBe("mcp_mcd_get_store_list");
    expect(qualifyMcpToolName("mcd", " Nutrition Info.List ")).toBe("mcp_mcd_Nutrition_Info_List");
  });

  it("isReadOnlyTool：查询/列表/时间类免审批，其余（下单/兑换/抽奖）需授权", () => {
    expect(isReadOnlyTool("query_nearby_store")).toBe(true);
    expect(isReadOnlyTool("get_store_list")).toBe(true);
    expect(isReadOnlyTool("get_current_time")).toBe(true);
    expect(isReadOnlyTool("available-coupons")).toBe(true);
    expect(isReadOnlyTool("campaign-calendar")).toBe(true);
    expect(isReadOnlyTool("mall-points-products")).toBe(true);
    expect(isReadOnlyTool("create_order")).toBe(false);
    expect(isReadOnlyTool("points_exchange_order")).toBe(false);
    expect(isReadOnlyTool("lottery_draw")).toBe(false);
    // 真机样本：领券/绑定是写操作，即使名称带 coupons 也不放行
    expect(isReadOnlyTool("auto-bind-coupons")).toBe(false);
  });

  it("createMcpToolProvider：工具映射限定名/只读分级/透传 schema；执行转发 tools/call", async () => {
    clearMcpListCache();
    const { fetchImpl, calls } = mockFetchFactory([
      { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) },
      { status: 202 },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [
        { name: "query_nearby_store", description: "查询附近门店", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
        { name: "create_order", description: "创建订单", inputSchema: { type: "object" } },
      ] } }) },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, result: { isError: false, content: [{ type: "text", text: "3 家门店" }] } }) },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, result: { isError: true, content: [{ type: "text", text: "库存不足" }] } }) },
    ]);
    const provider = await createMcpToolProvider([{ id: "mcd", url: "https://mcp.mcd.cn", token: "t" }], { fetchImpl });
    expect(provider).toBeDefined();
    expect(provider!.tools.map((t) => t.name)).toEqual([
      "mcp_mcd_query_nearby_store",
      "mcp_mcd_create_order",
    ]);
    const queryTool = provider!.tools.find((t) => t.name === "mcp_mcd_query_nearby_store");
    const writeTool = provider!.tools.find((t) => t.name === "mcp_mcd_create_order");
    expect(queryTool?.readOnly).toBe(true);
    expect(writeTool?.readOnly).toBe(false);
    expect(queryTool?.parameters).toMatchObject({ type: "object" });

    const ok = await provider!.execute({
      turnId: "t", attemptId: "a", invocationId: "i",
      name: "mcp_mcd_query_nearby_store", arguments: { city: "上海" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe("3 家门店");
    expect(JSON.parse(calls[3]?.body ?? "{}").params).toMatchObject({ name: "query_nearby_store", arguments: { city: "上海" } });

    const bad = await provider!.execute({
      turnId: "t", attemptId: "a", invocationId: "i2",
      name: "mcp_mcd_create_order", arguments: {},
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("库存不足");

    const unknown = await provider!.execute({
      turnId: "t", attemptId: "a", invocationId: "i3",
      name: "mcp_mcd_unknown", arguments: {},
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unregistered_tool");
  });

  it("probeMcpServers：单 Server 失败不影响其余，错误带信息", async () => {
    clearMcpListCache();
    const failing = mockFetchFactory([{ status: 401, headers: { "content-type": "application/json" }, body: "unauthorized" }]);
    const ok = mockFetchFactory([
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) },
      { status: 202 },
      { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_time" }] } }) },
    ]);
    const probes = await probeMcpServers(
      [
        { id: "bad", url: "https://bad.example.com", token: "wrong" },
        { id: "good", url: "https://good.example.com" },
      ],
      { fetchImpl: (input, init) => (String(input).includes("bad") ? failing.fetchImpl(input, init) : ok.fetchImpl(input, init)) },
    );
    expect(probes).toHaveLength(2);
    expect(probes[0]?.ok).toBe(false);
    expect(probes[0]?.error).toContain("401");
    expect(probes[1]?.ok).toBe(true);
    expect(probes[1]?.tools[0]?.name).toBe("mcp_good_get_time");
  });
});

describe("parseMcpServers（AERVOX_MCP_SERVERS）", () => {
  it("合法数组解析并过滤禁用/非法项；非法 JSON 安全降级为空", () => {
    const servers = parseMcpServers(
      JSON.stringify([
        { id: "MCD", url: "https://mcp.mcd.cn", token: " t " },
        { id: "off", url: "https://off.example.com", enabled: false },
        { id: "bad url!", url: "https://x.example.com" },
      ]),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ id: "mcd", url: "https://mcp.mcd.cn", token: "t" });

    expect(parseMcpServers("not-json")).toEqual([]);
    expect(parseMcpServers('{"id":"x"}')).toEqual([]);
    expect(parseMcpServers(undefined)).toEqual([]);
  });
});
