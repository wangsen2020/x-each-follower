---
name: agentrelay-integration
description: 将浏览器插件、网页或客户端接入 AgentRelay 本地 AI 服务，检测服务、选择引擎及已有对话、发送幂等任务并查询结果。适用于接入和连通性测试，不负责安装升级服务或发布插件。
---

# AgentRelay 接入

目标：让调用方选定一个 AI 引擎和已有会话（或显式创建会话），反复向同一会话发送任务，保留上下文。先跑通接口，再接插件 UI。

## 使用前

- 从 AgentRelay 首页获取实际服务地址与访问 Token。默认地址 `http://127.0.0.1:8787`，允许用户修改；不要假设自定义域名、HTTPS、端口扫描或免 Token 可用。
- 公共下载：[正式发行](https://github.com/wangsen2020/agentrelay-releases/releases/latest)。截至本 skill 核查日 2026-11-12，正式版为 2.11.0；实际连接后以 `/health` 返回为准。
- Token 只在用户本机配置中保存，不写源码、聊天、URL、截图或日志；扩展使用本地存储，不使用同步存储。外部插件只调用公开 API，不调用 `/ui/api` 管理接口。
- 修改调用方项目前遵循其 AGENTS.md 和分支规则，保留已有改动与运行任务；接入不授予发布、操作真实社交账号或修改服务配置的权限。

## 三方直达协作

本技能保留插件/客户端的普通任务接入。需要 Codex、Antigravity 与 DeepSeek Harness 会话之间的派单、主动回执和事件驱动协作时，安装同仓库的 [agentrelay-session-bridge](../agentrelay-session-bridge/SKILL.md)。其工具区分普通 jobs 空闲唤醒与活动轮次严格 Steer；不得把普通轮询或模型文字确认冒充原生直达。

## 快速验证

附带工具需要 Node.js 22+，无需 npm 安装。命令相对于本 skill 目录运行。先把 Token 放入临时环境变量 `AGENTRELAY_TOKEN`（不要把真实 Token 写进命令示例）。可选 `AGENTRELAY_URL` 和 `AGENTRELAY_PROVIDER`，默认分别是上述地址和 `codex`。

```powershell
node scripts/probe.mjs health
node scripts/probe.mjs sessions --provider codex
node scripts/probe.mjs send --provider codex --session <列表返回的ID>
```

`send` 默认只要求 AI 回复 `AGENTRELAY_OK`，并禁止用工具。它在发送前保存不含 Token 的任务收据，输出路径；若请求中断，用原收据恢复查询：

```powershell
node scripts/probe.mjs resume --receipt <收据文件路径>
```

只有用户明确希望新建时才执行：

```powershell
node scripts/probe.mjs create --provider codex --name "插件接入测试"
```

使用返回的同一 ID 再发第二轮，确认上下文持续存在。Grok Bot 没有新建 API，只能选择已有 Bot。传入文本可用 `--file <UTF-8文本文件>`。执行前确认目标会话不是用户正在运行其他业务的会话。

## 接入流程

1. GET `/health`：校验 `service` 为 `agent-relay`（旧版本可能为 `grok-bridge` 或 `gbot-local-service`），记录版本；服务在线不等于每个引擎已登录。
2. 选择 `grokbot`、`codex` 或 `antigravity`，GET `/{provider}/health` 和 `/{provider}/sessions`，展示实际名称，按 `id` 去重。不要从显示名称猜 ID。
3. 保存 `{baseUrl, provider, sessionId}` 绑定。仅在用户选择“新建对话”时 POST sessions。刷新列表、发送消息、重新打开插件均不自动新建。
4. 一次业务请求生成一个 `jobId`（`crypto.randomUUID()`）。**发送前持久化任务 ID、完整请求和绑定**，POST jobs；202/200 仅表示受理或返回原任务。
5. GET 同 provider 的 `jobs/{jobId}`，仅 `completed` 读取 `result.text` 为成功；`failed`、`unknown` 停止轮询，保留原 ID 与用户输入。网络超时不代表未发送，不生成新 ID 重发。
6. 插件页面关闭或 MV3 worker 重启后，从持久任务恢复 GET 查询。一次 `setTimeout` 轮询不能保证 worker 常驻；按插件现有任务机制使用 alarms/恢复入口，不用无限保活。

## 浏览器插件

把 `scripts/client.mjs` 作为本地 ES module 引入后台；MV3 service worker 设置 `type: "module"`。先阅读 [插件接入参考](references/plugin.md)，它包含权限、消息桥接和安全边界。API 字段、错误与实验引擎见 [接口参考](references/api.md)。

- 在后台发请求，content script 通过受限的内部消息交给后台；不向网页暴露 Token 或任意 URL 代理。
- 持久化绑定和未完成任务；Token 与 prompt 不放到报错日志。任务收据可能含提示词，仅在本机测试目录保留。
- UI 分别反馈“已配置”“检测中”“服务在线”“引擎异常”“任务运行”“完成/失败/待确认”，不要把配置保存成功当作 AI 调用成功。
- Node 工具通过不等于插件通过：实际重载目标插件，在真实后台请求中确认权限、浏览器本地网络访问限制、Origin 和 Token，并做一轮无外部副作用的消息测试。

## 实验入口

`antigravity-acp` 和 `codex-acp` 属于 1.4.0 开发接口，正式 1.3.0 不保证存在。仅用户明确选用、服务实际提供时，给 probe 加 `--experimental`。不要遇到 404 就偷偷切换引擎。

- Antigravity ACP 使用独立会话存储，不自动显示在原 IDE；本机历史 ID 已验证跨进程恢复，仍需账号登录和原生数据保留。
- Codex ACP 可对应原生 Codex thread，但桌面端占用时可能拒绝加载；不要改用新 ID 绕过。
- 本轮 ACP 文本实验没有开放工具权限审批、主动取消或完成回调，不能宣传这些已接入。

## 验收与交付

至少记录：实际版本/地址（不含 Token）、引擎、会话 ID、第一次任务 ID与结果、同 ID 第二轮上下文、重开调用方后绑定保留、失败不自动重发。区分模拟后端、真实引擎、Node 请求和真实插件请求，不把一种证据替代另一种。

有 UI 改动时执行所在项目的产品 UI 验收，查看真实截图；操作按钮统一图标和 hover/键盘 tips，保留本地化可访问名称，检查窄窗口、未保存输入和失败反馈。纯 API 接入明确记录无 UI 改动。

## 安装和分发

整个 `agentrelay-integration` 文件夹可复制到使用者的 `~/.codex/skills/`，也可放到支持 SKILL.md 的其他工具的技能目录。调用 `$agentrelay-integration`，说明插件目录与想用的引擎。无需 AgentRelay 私有源码。分发前执行 `node scripts/self-test.mjs` 验证附带客户端；它只启动本机模拟 HTTP 服务，不调用真实 AI。
