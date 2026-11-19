# 公开接口

默认基础地址 `http://127.0.0.1:8787`。所有请求：`Authorization: Bearer <TOKEN>`；POST 另带 `Content-Type: application/json`。不使用 URL query 传 Token。地址和 Token 从实际运行的 AgentRelay 首页取得。

| 操作 | Grok Bot | Codex | Antigravity |
| --- | --- | --- | --- |
| 引擎健康 | GET /grokbot/health | GET /codex/health | GET /antigravity/health |
| 会话列表 | GET /grokbot/sessions | GET /codex/sessions | GET /antigravity/sessions |
| 显式创建 | 无 API | POST /codex/sessions | POST /antigravity/sessions |
| 提交 | POST /grokbot/jobs | POST /codex/jobs | POST /antigravity/jobs |
| 查询 | GET /grokbot/jobs/{jobId} | GET /codex/jobs/{jobId} | GET /antigravity/jobs/{jobId} |

GET `/health` 返回整体 service/version。列表为 `{ "sessions": [{ "id": "...", "name": "..." }] }`，可能还带 threadId/cwd/updatedAt。创建提交 `{ "name": "用户选择的名称" }`，201 返回含 id 的对象。只传接口返回的 id；不要在客户端拼装原生对话 ID。

提交：

```json
{"jobId":"调用方生成的UUID","sessionId":"选择的会话ID","text":"Reply exactly AGENTRELAY_OK. Do not use tools.","timeoutMs":120000}
```

首次通常 202；相同 ID 和相同参数重复提交返回原任务（200）；修改内容或会话后复用相同 jobId 是 409。服务按 provider、sessionId、text、timeoutMs 等计算指纹：重试时保留原请求，不更改默认参数。

查询示例：

```json
{"jobId":"原UUID","status":"completed","result":{"text":"AGENTRELAY_OK"}}
```

`queued` / `running`：继续查询；`completed`：读取 result.text；`failed` / `unknown`：终止自动流程。unknown 表示结果待确认，不表示没执行，不生成新 jobId 自动重发。GET 404 可能是错误 provider、错误 ID 或记录清理，不据此自动重新发送。客户端停止轮询不等于服务取消任务。

常见错误：401 Token；403 Origin；404 路由/会话/任务；409 ID冲突；413/400 大小或参数；421 Host校验；429 队列满；503 引擎未就绪或更新排空。显示服务返回的错误码和可操作提示，保留用户输入。提交响应丢失时用原 jobId 查询；后台没有任何自动 POST 重试。

源码默认 maxTextLength=8000 字符、maxBodyBytes=65536 字节、maxTimeoutMs=600000、timeoutMs 至少1000；这些可配置，不当作硬性服务发现值。批次按业务拆分为明确任务，不因为超限静默截断用户文本。

`/ask`、`/bots` 等是 Grok Bot 旧接口；新集成优先使用表中统一 jobs 接口。外部插件不得复用 `/ui/api` 的 cookie、登录或管理接口。

开发版另有 `/antigravity-acp`、`/codex-acp`，接口结构相同但依赖可选运行时和登录；先检测，404 即该实例未提供。`connected` 只证明 ACP 握手，真实测试任务成功才证明推理可用。`notifyThreadId` 是当前旧 Antigravity 路径的专用扩展，不是通用字段。
