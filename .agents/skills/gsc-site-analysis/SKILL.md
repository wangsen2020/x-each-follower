---
name: gsc-site-analysis
description: >-
  Google Search Console (GSC) 站点流量、展现断崖、排名骤降及索引状态深度诊断。当用户需要分析网站SEO、GSC数据、排查无展现/掉排名、检测URL索引状态或镜像站点冲突时使用。
---

# GSC 站点排障与流量诊断指南 (gsc-site-analysis)

本技能用于在任何站点遭遇 Google 展现量暴跌、点击归零、排名掉出前页、或收录异常时，提供标准化的自动化数据提取、多维交叉归因与针对性恢复方案。

---

## 一、诊断数据入口与工具优先级

1. **第一优先级：官方 GSC MCP 工具（直接调用）**
   - **`gsc_list_sites`**：列出当前可访问的站点和域名（确认正确的 `siteUrl`，如 `sc-domain:goodexts.com`）；
   - **`gsc_query_performance`**：拉取指定时间段的流量趋势与细分（支持按 `date`、`page`、`query`、`country`、`device` 等切分）；
   - **`gsc_inspect_url`**：实时调用官方 URL Inspection API，检查指定 URL 的覆盖状态（`coverageState`）、爬虫抓取时间（`lastCrawlTime`）、标准网址（`googleCanonical`）及引荐来源网址（`referringUrls`）；
   - **`gsc_list_sitemaps`**：检查站点 Sitemap 的提交状态与发现页面数。

2. **第二优先级：CDP 实机直连（备用或查验 UI 细节）**
   - 当需要核验人工惩罚（Manual Actions）、安全问题（Security Issues）、站内信通知（Messages Drawer）或查看多语言展开明细时：
   - 检查并附加到 `C:\jtmp\xfollower-cdp-profile`（9222 端口）；
   - 打开 `https://search.google.com/search-console` 进行 DOM 提取与截图。

---

## 二、站点排障标准四步法（SOP）

### 第一步：锁定异常断崖日（Date Breakdown）
调用 `gsc_query_performance`，设置 `dimensions: ["date"]`，查询近 28 天或 3 个月数据：
- 观察每天的 `clicks`、`impressions`、`position`、`ctr`；
- 找到展现量断崖（如从 150+ 突降至个位数）和排名骤降（如从第 1~2 页掉到第 7~9 页开外）的**精确日期拐点**；
- 比对该日期是否有 Google 核心算法更新（Core Update / Spam Update）。

### 第二步：锁定核心受损承接页与关键词（Page & Query）
- 分别按 `dimensions: ["page"]` 与 `dimensions: ["query"]` 排序拉取；
- 识别断崖发生前贡献 80%+ 展现的核心受损页面（例如工具类站点的某个子域名或特定详情页）；
- 识别排名前列的主力关键词（是否有高意图核心词排名完全丢失）。

### 第三步：URL 索引深度诊断（Index Inspection）
针对主力受损页面调用 `gsc_inspect_url`，核验关键指标：
- **`coverageState`**：
  - 若为 `Submitted and indexed`：说明页面仍在索引库中，掉展现属于内容质量/相关性竞争落后或算法降权；
  - 若为 `Crawled - currently not indexed`（已抓取未编入索引）：说明 Google 重新抓取后认为页面质量不达标或判定为重复/低质内容，移出了索引库；
  - 若为 `Discovered - currently not indexed`（已发现未编入索引）：说明 Google 发现了链接但爬虫预算不足或不急于抓取。
- **`lastCrawlTime`**：比对爬虫最近一次抓取时间与流量断崖日是否高度重合；
- **`googleCanonical` vs `userCanonical`**：检查 Google 选择的标准链接是否被错误篡改；
- **`referringUrls`**：核查引荐来源中是否有异常网址。

### 第四步：镜像与重复内容排查（Mirror & Duplicate Audit）
重点排查现代 Web 部署平台的默认域名冲突：
- **Cloudflare Pages**：检查 `*.pages.dev` 默认二级域名是否对外公网可直接访问；
- **Vercel / Netlify**：检查 `*.vercel.app`、`*.netlify.app` 是否可访问；
- **实测检测项**：
  1. `curl -I <staging_domain>` 检查是否有 `X-Robots-Tag: noindex, nofollow`；
  2. 页面 HTML 是否漏设 `<meta name="robots" content="noindex">`；
  3. 若默认二级域名可被公网抓取且内容完全一致，Googlebot 会分散抓取预算甚至将正式主站判定为模版镜像。

---

## 三、针对性恢复措施与建议清单

1. **封锁 Staging/默认二级域名（最高优先级）**：
   - 在 Cloudflare / 托管后台配置：所有非正式域名的访问，一律返回 `X-Robots-Tag: noindex, nofollow`，或直接 301 永久重定向到正式域名。
2. **扩充核心页面实质性内容（告别 Thin Content）**：
   - 增加图文指南、FAQ 问答（搭配 Schema.org 结构化数据）、常见问题与格式支持说明，提升正文字数与独特信息增益（Information Gain）。
3. **修复多语言与 Sitemap 引用**：
   - 确保多语言 `hreflang` 双向对齐（`x-default` + 各语言版本互链）；
   - 主站增加对子域名的文字锚文本超链接，打通站内权重流动。
4. **触发重新评估**：
   - 在完成上述修复后，在 GSC 中重新发起 `REQUEST INDEXING`，加速算法重新收录。
