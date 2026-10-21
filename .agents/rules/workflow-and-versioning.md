# 工作流与版本号全局规范 (workflow-and-versioning.md)

---

## 一、Git Flow 分支工作流纪律

1. **分支创建与命名**：
   - 所有新功能与新改造必须通过 `git flow feature start <名称>` 创建对应 `feature/<名称>` 分支。
   - **严禁**直接创建 `codex/*` 分支或无规范前缀分支。
2. **分支演进与迭代**：
   - 已有功能演进或 Bug 修复在对应的 `feature/*` 分支继续提交。
   - 不得直接在 `main` / `master` 或 `develop` 主干上混杂未经全量测试验证的代码。
3. **完成与发布**：
   - 必须通过自动化单测（`npm test`）、构建产物校验（`npm run build:check`）以及 CDP 实机验收后，按指令执行 `git flow feature finish`、`git flow release start/finish` 并推送。

---

## 二、语义化版本号迭代管理规范

在每次功能演进或缺陷修复时，必须同步更新版本号（`package.json`、`manifest.json`、`background.js`、`panel.js`），严格遵循以下规则：

1. **已有功能优化与 Bug 修复**：
   - **修改第 3 位版本号（Patch）**，例如 `1.8.0` -> `1.8.1`。
2. **新增功能**：
   - **修改第 2 位版本号（Minor），第 3 位归零**，例如 `1.8.1` -> `1.9.0`。
3. **架构重构或重大改版**：
   - **修改第 1 位版本号（Major），第 2、3 位归零**，例如 `1.9.0` -> `2.0.0`。
