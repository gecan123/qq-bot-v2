# Luna 个人网站维护设计

## 背景

Luna 需要一个可长期自主维护的个人网站。网站首次创建、首次发布、Vercel 绑定、域名和账号级配置由 owner 完成；后续 Luna 只负责日常内容维护、构建检查、提交和推送。

这个功能不是多 bot 网站平台，也不负责自动购买域名、创建 Vercel 项目或管理 DNS。第一版只服务 Luna 自己。

## 目标

- 使用独立网站仓库承载 Luna 的公开个人站点。
- 让 Luna 能通过受控工具读取、编辑、构建检查并发布网站内容。
- 保持 `qq-bot-v2` 主仓库和网站仓库解耦。
- 保持 AgentContext replay 稳定：网站文件、构建日志和 diff 不作为历史重建来源，只通过有界 tool result 进入上下文。
- 先专注网站维护闭环；Codex CLI 子任务能力作为后续通用扩展，不进入 MVP。

## 非目标

- 不自动创建 GitHub 仓库。
- 不调用 Vercel API 创建项目、绑定域名或修改部署配置。
- 不管理 DNS、支付、token、secret 或账号授权。
- 不暴露任意 shell、任意 git 命令或任意文件编辑。
- 不实现多 bot 模板平台。
- 不在第一版提供 Codex CLI 子任务工具。

## 仓库结构

推荐结构：

```text
/Users/zzz/WebstormProjects/qq-bot-v2
  src/agent/tools/website.ts
  docs/superpowers/specs/2026-07-09-luna-website-design.md

/Users/zzz/WebstormProjects/luna-site
  src/
    content/
      posts/
      notes/
    layouts/
      BaseLayout.astro
      PostLayout.astro
    pages/
      index.astro
      about.astro
      posts/[...slug].astro
    styles/
      tokens.css
      global.css
      components.css
  public/
    images/
  astro.config.mjs
  package.json
```

`qq-bot-v2` 只提供工具和权限边界。`luna-site` 是独立 Git 仓库，由 Vercel Git integration 从 `main` 自动部署。

## 网站技术栈

选择 Astro。

理由：

- Luna 的个人网站以文章、短记录、图片和个人介绍为主，属于内容型静态站。
- Astro 默认适合 Markdown/MDX 内容和静态生成，在 Vercel 上部署简单。
- 对 Agent 维护友好：大多数日常更新是 Markdown、JSON、图片和少量 CSS tokens。

样式采用手写 CSS，不引入 Tailwind 或 shadcn。第一版暴露窄样式入口：

- `src/styles/tokens.css`：颜色、字体、间距、正文宽度等变量，允许 Luna 修改。
- `src/styles/components.css`：少量组件外观，允许受限修改。
- `src/styles/global.css`：基础排版和全局结构，默认不鼓励频繁修改。

## 配置

新增环境配置：

```env
BOT_WEBSITE_ENABLED=true
BOT_WEBSITE_REPO_DIR=/Users/zzz/WebstormProjects/luna-site
BOT_WEBSITE_PUBLIC_URL=https://example.com
BOT_WEBSITE_BRANCH=main
BOT_WEBSITE_CHECK_COMMAND=pnpm build
```

这些配置只指向已有仓库和已有发布目标。secret、Vercel token、GitHub token 不写入 tool result、memory 或 AgentContext。

## 工具形态

新增 deferred capability：`website`。

它默认不常驻，按需通过 `help action=activate capability=website` 激活，再通过 `invoke` 调用内部工具。第一版可以实现为单一 action-driven 工具：

```text
website action=status
website action=read
website action=write
website action=publish
```

### status

返回有界 JSON：

- repoDir
- publicUrl
- branch
- remote
- latestCommit
- dirty
- changedFiles

不返回完整日志。

### read

读取白名单文件，带字符上限。用于 Luna 查看已有页面、文章、样式 tokens。

允许读取：

- `src/content/**`
- `src/pages/about.astro`
- `src/styles/tokens.css`
- `src/styles/components.css`
- `public/images/**` 的元数据

### write

写入白名单文件，限制路径、扩展名和大小。

允许写入：

- `src/content/**/*.md`
- `src/content/**/*.mdx`
- `src/content/**/*.json`
- `src/pages/about.astro`
- `src/styles/tokens.css`
- `src/styles/components.css`
- `public/images/**/*.{png,jpg,jpeg,webp,svg}`

禁止写入：

- 隐藏文件和隐藏目录
- `.github/**`
- `.vercel/**`
- `package.json`
- lockfile
- `astro.config.*`
- `tsconfig.*`
- 构建脚本
- 环境变量文件
- 任意路径逃逸

第一版不提供 delete。需要删除内容时，先由 owner 或后续设计处理。

### publish

固定发布流程：

1. 确认 repoDir 是配置的仓库。
2. 确认当前分支是 `BOT_WEBSITE_BRANCH`。
3. 收集变更，只允许白名单文件进入提交。
4. 执行 `BOT_WEBSITE_CHECK_COMMAND`。
5. `git add` 白名单文件。
6. `git commit -m "content: Luna 更新个人网站"`，可附简短摘要。
7. `git push origin <branch>`。
8. 返回 commit hash、changedFiles、check 摘要、publicUrl。

如果检查失败，返回有界错误摘要和日志尾部，不提交、不推送。

## 安全边界

- `website` 是副作用工具，必须进入 tool-call audit。
- 不接受模型传入任意命令。
- 不接受模型传入任意 repo 路径。
- 不允许修改部署、CI、依赖、配置和 secret。
- 不把完整构建日志、完整 diff 或站点源码大块内容送入 AgentContext。
- `publish` 只推送配置分支，不创建 tag，不 force push。
- 如果 Luna 想做结构性改版、依赖升级、CI 修改或 Vercel 配置变更，工具返回 `owner_help_required`。

## 失败处理

- 仓库不存在：返回 `repo_not_found`，提示 owner 先完成首发仓库配置。
- 分支不匹配：返回 `wrong_branch`，不自动切分支。
- 工作区已有非白名单改动：返回 `unsafe_dirty_worktree`，不发布。
- 构建失败：返回 `check_failed`，包含有界 stdout/stderr 尾部。
- commit 无变更：返回 `nothing_to_publish`。
- push 失败：返回 `push_failed`，不重试无限次。

所有错误结果使用稳定 JSON，并包含 `ok=false`、`code`、`error`、`next`。

## Codex CLI 后续扩展

Codex CLI 能作为后续通用能力，但不属于 MVP。

后续可以新增独立 deferred capability：`codex_task`。它用于把复杂代码任务委托给 Codex CLI，例如网站结构改版、修构建失败、整理文档或在单独 sandbox 仓库里做实验。

边界：

- 不并入 `website`。
- 不暴露裸 `codex` 命令。
- 只允许 allowlist repo。
- 以后台任务运行，返回摘要和文件变更，不返回无界日志。
- 默认不允许 Codex 自己 push；发布仍由专门工具完成。

## 测试计划

- `website` 配置解析测试：默认禁用、启用后必填字段、路径解析。
- 路径白名单测试：允许内容路径，拒绝路径逃逸、隐藏文件、配置文件、CI 文件。
- `read/write` focused tests：上限、扩展名、大小限制和错误码。
- `publish` runner 测试：check 失败不 commit，非白名单改动不 publish，成功路径只 add 白名单文件。
- tool manifest 测试：`website` 作为 deferred capability 注册，不进入 always-on tools。
- 文档同步：更新 `docs/TOOLS.md` 和必要的 `.env.example`。

## 验证

实现时最小验证：

```bash
node --import tsx --test src/agent/tools/website.test.ts src/agent/tools/merged-tools.test.ts
pnpm repo-check
```

如果修改 config：

```bash
pnpm typecheck
```

MVP 不需要启动真实 bot、NapCat、browser sidecar 或真实 Vercel 部署。
