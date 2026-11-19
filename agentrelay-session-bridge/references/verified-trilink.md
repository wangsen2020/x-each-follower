# Windows 三方直达验证

验证环境：2026-11-12，Windows 宿主，AgentRelay 2.11.0。测试编号 TRILINK-20261112-84f099。

使用 Codex 主控、Antigravity 与 DeepSeek Harness 三个已有会话，完成六个方向的原生直达接收确认。

1. 空闲 Antigravity 的严格 Steer 返回 409 no_active_turn；普通 jobs 唤醒同一会话后，补测活动轮次直达，对端明确确认。
2. Codex 向活动 Harness 发送任务，两个子控向当前主控主动回传 READY。
3. Harness 的 H2A 挑战 nonce 为 0fcfaa9cfc0ae658，Antigravity 原样返回 H2A_ACK。
4. Antigravity 的 A2H 挑战 nonce 为 c5adc1b4d2a39281，Harness 原样返回 A2H_ACK，双方核对匹配。
5. H_DONE 与 A_DONE 实际进入同一个 Codex 活动轮次；原 Antigravity job 随后核实为 completed。

历史会话地址和本机文件路径未纳入公开包。未来任务必须读取当前主控与目标的实际会话 ID，不能复用历史地址。

## 证据层级与边界

accepted/steered 是投递受理；对端回显 nonce 是接收确认；业务是否完成仍由主控按产物与验收条件核实。

该次没有验证空闲 Codex 主控排队回执后的自动执行、进程崩溃恢复、长期无人值守、高负载或费用节省比例。本地协议模拟测试不替代这些实机场景。

本 skill 的回执唤醒分支仅在明确 no_active_turn 且契约允许时排队一次结果通知；不能把排队受理写成实际执行成功。

[AgentRelay 2.11.0 公开发行记录](https://github.com/wangsen2020/agentrelay-releases/releases/tag/v2.11.0)
