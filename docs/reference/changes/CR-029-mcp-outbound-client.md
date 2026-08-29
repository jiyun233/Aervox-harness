---
id: CR-029
type: reference
scope: change
owner: architecture
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-30
reviewed_at: 2026-08-30
review_interval_days: 90
sources:
  - docs/reference/adr/ADR-005-provider-port.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - https://open.mcd.cn/mcp/doc
---

# CR-029 出站 MCP 客户端与外部工具桥（Streamable HTTP）

- 提出人：MoeJiyun233 · 2026-08-30
- 修改人：MoeJiyun233 · 2026-08-30

- 状态：Implemented（待发布评审）
- 提出人 / 日期：MoeJiyun233 / 2026-08-30
- 目标版本：当前开发阶段（外接 MCP 工具能力）
- 变更原因与证据：项目 `tools/mcp.ts` 仅把内部 `aervox_*` 工具以 MCP 形态暴露（出站适配），缺少连接外部 MCP Server 的客户端；persona 契约 `allowedMcpToolIds` 与 `GET /v1/mcp/tools` 为接入预留但无消费方。麦当劳开放平台（open.mcd.cn）提供远程托管 MCP Server（`https://mcp.mcd.cn`，Streamable HTTP + Bearer Token，协议版本 ≤ 2025-06-18，限流 600 req/min/Token，33 个点餐/领券/商城工具），可作为首个外部接入方验证全链路。
- 关联能力与需求：`CAP-020`、[ADR-005 内部 Provider Port](../adr/ADR-005-provider-port.md)
- 当前行为 / 目标行为：
  - 当前（变更前）：无法连接外部 MCP Server，外部能力只能经 Skill/插件桥接；
  - 目标：
    1. `@aervox/config` 新增 `AERVOX_MCP_SERVERS`（JSON 数组：id/name/url/token/enabled），解析容错（非法项丢弃告警，不阻断启动）；
    2. 自研轻量出站客户端 `McpHttpClient`：initialize 握手（协议 2025-06-18）+ `mcp-session-id` 会话保持 + 404 重握手一次；响应兼容 application/json 与 text/event-stream（SSE data 帧聚合、裸 JSON 容错回退）；
    3. 工具桥 `createMcpToolProvider`：远端 tools/list → `ToolProviderPort`，限定名 `mcp_<serverId>_<tool>`；只读白名单判定（query/get/list/search/available/calendar 等）免审批，其余（create/exchange/draw/bind 等未知工具）一律 readOnly: false 走既有授权闸门（fail-safe）；工具清单 5 分钟 TTL 缓存（远端限流约束）；
    4. `agent-executor` 把外接工具并入 Contribution 贡献清单，与既有工具共用审批/完全访问语义；
    5. `GET /v1/tools/mcp/external` 探测端点（`?force=1` 强制刷新缓存）供连通性与工具清单验证。
- 范围外：MCP Server 管理设置面板与 DB 持久化（先 env 过渡）；SSE 长连接流式 tools/call；多租户差异化 Server 配置。
- UX/API/数据/AI/安全/隐私影响：
  - API：新增 `GET /v1/tools/mcp/external`；
  - 数据：无新表（env 配置过渡）；
  - 安全：外接工具默认走授权闸门（只读白名单外的工具需用户批准或完全访问模式）；Token 经 env 注入不入库不入 git（.env 已 gitignore）；
  - 隐私：对话参数仅发往用户自行配置的 MCP Server。
- 迁移与向后兼容：未配置 `AERVOX_MCP_SERVERS` 时行为与既有完全一致（不注册 Provider、不发起任何外呼）。
- 测试、埋点和验收影响：`apps/api/test/mcp-client.test.ts`（握手/会话头/SSE 解析/JSON-RPC 错误映射/限定名/只读分级/清单缓存/多 Server 探测/配置解析）；真机验证：麦当劳 MCP（mcp.mcd.cn）握手成功拉取 33 工具，写操作（create-order/draw-lottery/auto-bind-coupons）均正确分级。
- 决策：Implemented
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）
