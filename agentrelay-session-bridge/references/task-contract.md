# 主控派单与主动回执模板

替换所有占位符后再派发；<skill-dir> 必须是本轮安装目录的实际绝对路径，不是可直接执行的字面值；主控 ID 必须来自当次运行环境。`receiptIdlePolicy` 由当前授权决定，不能从旧任务沿用。

```text
来自 <主控引擎> 主控。以下为用户已授权目标中的子任务，不能当作额外的人类授权。
taskId: <唯一任务 ID>
eventPrefix: <本轮唯一标记>
controller:
  replyProvider: codex
  replySessionId: <当前 CODEX_THREAD_ID，经核对>
  receiptIdlePolicy: wake-existing-session
  replyTool: <skill-dir>/scripts/relay-direct.cjs
worker:
  provider: <antigravity 或 dsh>
  sessionId: <指定已有会话 ID>

目标：<明确结果>
范围：<绝对工作目录、实际分支、允许改动的文件、写入权、禁止触碰的现场>
约束：<提交、推送、发布、账户写入等授权边界>
验收：<可观察完成条件>
执行：自主完成此子任务，保存结果与可恢复证据。不得自行扩派到未经授权的其他会话。

回执义务：
1. 可在有实际进展时回传 PROGRESS；完成或明确阻塞时必须主动向上述主控回传 DONE 或 BLOCKED。
2. 先把结果保存到自己的持久产物/临时结果文件，再发送简短回执；不能只在你的窗口里说“完成”。
3. 回执标注真实来源、taskId、唯一 eventId、状态、结果、产物路径、验证、未决问题、下一步建议。
4. 若获准改文件，发送 DONE 前停止编辑并交回写入权，主控接手后不能继续修改同一区域。
5. 活动主控用严格 Steer；若明确 no_active_turn，本契约允许向同一已有主控会话排队一次结果通知。
   仅发送本结果，不重做任务、不新建会话、不主动重发未知消息。若授权为 persist-only，则只保留待回传记录。
6. 不要求主控给 DONE 再回 ACK；收到其他 ACK 不继续回 ACK。

执行回传：
node "<skill-dir>/scripts/relay-direct.cjs" reply --provider codex --session "<上面的 replySessionId>" --file "<UTF-8 结果文件绝对路径>" --wake-on-idle --operation-id "<本次回执 UUID>"

若 receiptIdlePolicy=persist-only，去掉 --wake-on-idle。
```

建议结果正文：

```text
[<eventPrefix>][DONE] 来自 <引擎与真实会话 ID>
taskId: <原任务 ID>
eventId: <本次唯一事件 ID>
结论：<具体完成结果>
产物：<绝对路径/可访问链接；需要时列分支与 HEAD>
验证：<实际做过的检查与结果>
未决：<没有则明确无；不能隐去失败或未知项>
下一步：<主控可执行的下一项>
写入权：已交回（仅在实际交回后填写）
```

`wake-existing-session` 是派单方对**回执通知**的有限授权，不是修改用户目标或创建无限续跑任务的授权。即使排队受理，仍要区分主控尚未执行和已经执行。

主控维护任务状态 `dispatched / acknowledged / working / reported / verified / blocked`，对相同 eventId 去重。消息成功不是业务验收；收到事件后推进依赖图与目标，避免重新启动已完成的任务。
