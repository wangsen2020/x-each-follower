---
name: agentrelay-session-bridge
description: 通过本机 AgentRelay 在 Codex、Antigravity、DeepSeek Harness 现有会话间派单、直达回执与事件驱动协作。作为主控委派其他 AI 时使用，要求子控完成后主动回传当前主控会话，区分空闲唤醒与活动轮次 Steer；也保留 Grok Bot 的传统任务查询。
---

# 本地异构 AI 的派单与主动回执

主控拆解目标并分发任务，子控自主执行并主动回报；主控收到事件后继续集成、补派或验收，直至目标达成或出现需要用户处理的真实阻塞。以回执驱动后续调度，避免把反复查询子控是否完成作为正常工作机制。

这里的“去中心化调度”指执行与反馈分布在各 AI 会话中，主控仍负责目标、依赖和最终验收。AgentRelay 是当前部署中的本地公共通信服务，不能描述为无中心基础设施、自动容错集群或共享上下文。

## 派单前确定当前身份与边界

- 仅在用户授权的协作范围内派单。任务本身授权子控把必要结果回传主控；不扩展为任意聊天、提交、发布或生产操作授权。
- 每次从当前运行环境读取主控地址，不复制实测旧 ID。Codex 优先取 `CODEX_THREAD_ID`，以 `CODEX_SESSION_ID` 作为候选并核对当前会话；其他引擎使用其原生当前会话标识。向子控提供明确的 `replyProvider` 和 `replySessionId`。
- 验证本机 `/health` 和目标会话列表。列表能查到仅证明会话存在，不证明它有活动轮次、已读消息或可随时执行任务。优先复用与本任务有关的已有会话，保护其未完成任务。
- 软件开发仍先执行目标项目的分支、编辑锁和权限规则。限定绝对目录、分支、文件写入归属、验收条件；主控不能因通信已打通而让多个 AI 同时编辑同一区域。

## 空闲唤醒与活动直达

| 情形 | 操作 | 成功所代表的含义 |
|---|---|---|
| 空闲会话接收新任务 | `POST /{provider}/jobs`，给定 `jobId` | 排队或受理，之后仍须核实对端执行 |
| 活动轮次接收进度、纠正或完成回执 | `POST /steer`，显式 provider、sessionId、`strict:true` | 插入活动轮次；不等于业务已完成 |
| 严格直达返回 `409 no_active_turn` | 该次没有活动轮次；按明确授权选择排队唤醒或保留待回传记录 | 不能声称已直达，也不使用 loose 冒充成功 |
| 超时、断线、5xx 或不完整成功响应 | 记为未知，检查原凭据和会话 | 不自动重发，不自动转为唤醒任务 |

主控首次派单可使用普通任务入口唤醒空闲子控。子控完成时优先向当前主控活动轮次直达回执；派单契约若明确允许“回执唤醒”，确认主控 `no_active_turn` 后，可向同一主控已有会话排队一次**结果通知**，让下一轮继续处理原目标。此操作不重做业务任务、不新建替代会话。排队受理与真正唤醒执行分别记录。

若主控主动结束轮次前仍有任务在途，先确认子控已收到回传地址、结果已持久化且约定允许回执唤醒。不要把长时间阻塞轮询或无限空转当成可靠的后台常驻机制。

## 默认派单契约

使用 [references/task-contract.md](references/task-contract.md) 的模板。每次实际派单都必须包含：

1. 任务 ID、真实来源、目标、边界与完成条件。
2. **本次当前主控**的引擎、会话 ID 和回执地址；要求完成或阻塞时主动回传，不只在子控窗口输出最终答案。
3. `receiptIdlePolicy`：允许已确认空闲时向同一主控排队一次回执，或仅保留待回传记录。需要持续协作且用户已授权的任务，优先明确允许回执唤醒。
4. 结果包含结论、产物位置、验证结果、未决问题与建议下一步；交回写入权后再通知主控集成。
5. 不允许 ACK 相互回 ACK。每个任务事件有唯一 ID，收到回执只推进状态，不重新派发已完成任务。

正常控制流：`派单 → 子控执行 → 子控持久保存结果 → 主动回执 → 主控验收并决定下一步`。主控用等待原生消息或做独立工作来等待回执；只有恢复、超时诊断或交付核实需要时，查询原 job，不能以高频轮询驱动常规协作。

## 可直接使用的工具

安装时将整个 agentrelay-session-bridge 文件夹复制到 ~/.codex/skills/ 或相应工具的技能目录。以下 <skill-dir> 必须展开为该文件夹的实际绝对路径；同机其他 AI 也可调用其脚本。需要 Node.js 22+ 与本机 AgentRelay 2.11.0+。Token 自动从 `%APPDATA%/AgentRelay/config.json` 读取，不打印。正文使用 UTF-8 文件。

```powershell
$bridge = '<skill-dir>/scripts'

# 查已存在的会话，按需选择 provider，不把列表当在线/活动证明
node "$bridge/relay-bridge.mjs" sessions --provider antigravity
node "$bridge/relay-bridge.mjs" sessions --provider dsh

# 已确认空闲：唤醒已有会话，异步派单；task.txt 必须已填写本轮回传契约
node "$bridge/relay-bridge.mjs" send --provider antigravity --session '<目标会话 ID>' --from '<本轮主控 ID>' --file '<task-file.txt>' --job '<本任务 UUID>' --no-wait

# 活动轮次直达，单次投递；退出码 3 表示明确没有活动轮次
node "$bridge/relay-direct.cjs" steer --provider antigravity --session '<目标会话 ID>' --file '<progress-file.txt>'

# 子控完成后回当前 Codex 主控，明确空闲时允许排队一次结果通知
node "$bridge/relay-direct.cjs" reply --provider codex --session '<派单契约中的主控 ID>' --file '<result-file.txt>' --wake-on-idle

# 仅恢复/核实原任务，不发送第二份任务
node "$bridge/relay-bridge.mjs" status --provider antigravity --job '<原 jobId>'
```

`relay-direct.cjs` 支持 `codex`、`antigravity`、`dsh`。`steer` 永不自动唤醒；`reply --wake-on-idle` 只在明确的 `409 no_active_turn` 后向同一会话排队回执，未知结果不回退。每次发送前在临时目录写入意图与操作 ID，之后保存原始服务回执；指定相同操作 ID 时拒绝再次发送。`--dry-run` 不访问服务或写收据。Grok Bot 继续使用已有 `relay-bridge.mjs` 的普通 jobs 与查询，不宣称它通过了三方 Steer 实测。

## 核实完成与继续推进

区分三层证据：服务的 `accepted/steered` 是**投递受理**；对方回显唯一标记或 nonce 是**接收确认**；携带产物与验证的 `DONE` 是**子任务完成报告**。主控仍须按任务风险验证结果，之后才认定总体目标完成。

收到 `DONE` 后核对任务 ID、真实来源和产物归属，去重，再执行可独立确认的验收；有剩余工作就继续集成或派发有依赖的下一项。收到 `BLOCKED` 时先处理可自主解决的问题，需要用户决策才询问。不能把回复成功、排队成功、单个子任务结束或预算耗尽当成整体目标达成。

持续运行依赖客户端与服务存活、可用凭据、调度执行、结果持久化及恢复机制。本流程提供事件驱动闭环，不承诺进程退出后必然自恢复或任务无限运行。

## 实测依据与高级排错

- 三方六向直达及 nonce 闭环记录见 [references/verified-trilink.md](references/verified-trilink.md)。活动轮次直达和 Antigravity 空闲唤醒已实机验证；**空闲 Codex 主控的排队回执及后续自动执行未纳入该次实机测试**，不得混称为已实测。
- Codex 原生 owner/turn 回执细节可选参考已安装的 `codex-desktop-steer`；Antigravity strict 与 UTF-8 细节可选参考 `<antigravity-steer-skill-dir>/SKILL.md`；Harness 原生日志恢复见 `deepseek-harness-bridge`。只在需要对应细节时读取。
- 本技能只负责编排与通用通信，不把调用方的打标、评论计数或自动压缩业务策略移入 AgentRelay。
