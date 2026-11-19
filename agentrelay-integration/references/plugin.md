# Chrome / Edge MV3 接入

合并到现有 manifest，保留原权限和入口。默认连接仅增加所需主机：

```json
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "host_permissions": ["http://127.0.0.1/*"],
  "background": {"service_worker":"background.js","type":"module"}
}
```

用户使用 localhost 或其他明确地址时，再申请对应 host 权限。Match pattern 不使用 `:8787` 限制端口。不要为方便要求 `<all_urls>`。如果用 chrome.alarms 做任务恢复，合并 alarms 权限。浏览器版本/企业策略可能对本地网络有额外限制；以真实后台 fetch 为准，不能通过修改全局浏览器安全设置绕过。

后台可以复制使用附带 client.mjs：

```js
import { AgentRelayClient } from './agentrelay/client.mjs';
const { relayConfig } = await chrome.storage.local.get('relayConfig');
const relay = new AgentRelayClient(relayConfig); // baseUrl、token、provider
const sessions = await relay.sessions();
// 用户选定后保存 sessionId，普通发送不调用 createSession。
const job = relay.makeJob(relayConfig.sessionId, text);
await persistPending(job); // 按现有业务实现：发送前记录 jobId、请求体和绑定
await relay.submit(job);
// 使用 relay.job(job.jobId) 做可恢复的后台轮询。
// completed 时消费 result.text，unknown/failed 交给用户核实。
```

`persistPending` 是调用方自己的业务持久化，不是 SDK 内置函数；不能直接复制为可运行完整后台。可以使用 storage.local 或现有 IndexedDB 队列表。避免多个 worker/页面对同一业务重复生成 jobId；同一任务重复入口应复用已存请求。

消息桥接要点：只接收已知的内部 action，校验 sender.id、业务输入和用户绑定；调用 URL由后台已保存配置决定，不接受 content script 或网页传入任意 URL、Token 和管理动作。不要把 Token 回传 content script，不开放 externally_connectable 通用转发。

后台收发结果时不自动发布评论、发送私信或执行网页动作；这些由插件自己的任务规则和用户授权控制。接入测试使用测试会话和无外部副作用的提示词。

验证次序：保存配置 -> GET health -> 列举会话并选择 -> 提交测试 -> 得到 completed -> 第二轮验证上下文 -> 关闭重开插件后恢复绑定/原任务查询。状态不能只显示“配置保存成功”。取消按钮若仅停止本地等待，应标为“停止等待”，不可显示“任务已取消”。
