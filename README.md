# XFollower · 粉丝跟进 · 4.48.2

<div align="right">
  <a href="./README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.pt-BR.md">Português (Brasil)</a> ·
  <a href="./README.es-419.md">Español (Latinoamérica)</a>
</div>

XFollower 是面向 X.com 的本地浏览器扩展，用于管理粉丝审核、关注队列、回关监控、首页跟评、帖子追踪和写作知识库。数据保存在当前浏览器的扩展数据库中。

## 下载

当前公开下载版本：**4.48.2**。

- [下载 XFollower 4.48.2 ZIP](https://github.com/wangsen2020/x-each-follower/releases/download/4.48.2/XFollower-4.48.2.zip)
- [SHA256 校验文件](https://github.com/wangsen2020/x-each-follower/releases/download/4.48.2/SHA256SUMS.txt)
- [查看全部 GitHub Releases](https://github.com/wangsen2020/x-each-follower/releases/latest)

公开仓库现在作为产品介绍、发行下载和教程入口使用，源码与研发构建已迁移到独立的私有仓库。历史 Release、标签和下载资产保持不变；GitHub 为历史标签生成的 Source ZIP/TAR 可能仍包含当时的源代码，这些历史归档没有被重写。

## 4.48.2 更新

- 首页新增互关评论、评论提取成果，区分首页自动提取和手动提取；重复用户保留首次渠道。
- 首页跟评增加打标与评论日志，进度、倒计时和结果集中到右下角浮窗，全选批量操作置于列表左侧。
- 修复评论调度卡住、受保护账号补采超时及任务标签页反复打开；明确 AI 引擎错误重新请求，未知 AI 结果沿原编号恢复。
- 可恢复评论失败自动限次重试；发布核实连续 3 次无证据后，按既定策略重新生成并发送。

## 安装

1. 下载 ZIP 并解压到固定目录，目录根部应直接包含 `manifest.json`。
2. 在 Chrome 或 Edge 的扩展管理页开启“开发者模式”，选择“加载已解压的扩展程序”。
3. 选择解压后的目录并完成加载。升级前先备份浏览器配置和本地扩展数据，不要卸载扩展来代替升级。

## 教程

- [XFollower 使用教程索引](./docs/使用指南/使用说明.md)
- [安装与初次使用](./docs/使用指南/01-安装与初次使用.md)
- [粉丝管理与回关](./docs/使用指南/02-粉丝管理与回关.md)
- [关注队列](./docs/使用指南/08-关注队列.md)
- [近期功能图解](./docs/使用指南/61.%20近期功能图解教程_20261027_0919_wangsen.md)
- [Grok Bot 本地接入](./docs/使用指南/84.%20Grok-Bot本地接入图解与分步引导_20261028_1534_wangsen.md)

教程中的截图和步骤保留在 `docs/`，可直接在 GitHub 上阅读。公开仓库没有已核实的独立官网或博客地址，因此这里仅提供 GitHub 官方入口，避免引导到未经确认的 URL。

## 功能范围

- 粉丝列表、筛选、AI 初审、回关和关注队列
- 互关追踪、评论追踪、首页跟评和多语言互动偏好
- 帖子追踪、X 榜单、日报和本地写作知识库
- 本地 AgentRelay、Grok Bot Bridge 等按需连接
- 简体中文、英语、巴西葡萄牙语和拉丁美洲西班牙语界面

自动关注、移除、回复和采集都受用户配置、服务可用性与 X 平台限流影响。GitHub Release 不等同于 Chrome Web Store 提交。
