# XFollower · 粉丝跟进 · v4.7.0

管理 X 粉丝、待回关账号和关注任务，追踪帖子与作者，使用 X Grok、Grok Webhook，或通过 AgentRelay 连接 Grok Bot、Codex、Antigravity 辅助创作与发布。

4.7.0 新增统一 AI 引擎设置：共用服务地址与 Token，Grok Bot、Codex、Antigravity 分别配置会话。复用同一客户端，支持读取会话、创建 Codex/Antigravity 会话及测试保存。采集打标、互粉评论、关注队列和知识库可选择引擎与会话。旧 Grok 连接配置自动保留，进行中任务按提交时的原连接、引擎和会话查询，不因切换设置而重发。

互粉评论的首页采集与批量 AI 打标、已打标帖子评论分别调度，支持随机间隔、来关必回、随机标签和发布回溯。按账号保存采集锚点；最多保留 5000 条记录，优先清理非互关旧帖，并保护互关帖与执行中的任务。设置持久化并回读确认。

写作知识统一为“批量分析—经验—当前智慧”，生成按知识库开关读取当前智慧；包含关注队列计划恢复、批量重试、蓝V筛选和会话核验等已集成改进。

上一已发行版本：[XFollower 4.6.2](https://github.com/wangsen2020/x-each-follower/releases/tag/4.6.2)。[下载最新发行版](https://github.com/wangsen2020/x-each-follower/releases/latest)。GitHub发行与Chrome商店上架是不同步骤。
