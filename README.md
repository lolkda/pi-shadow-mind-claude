# pi-shadow-mind (Claude Code port)

把 Pi 编码 Agent 的 [pi-shadow-mind](https://github.com/liuzhengdongfortest/pi-shadow-mind) 移植为 Claude Code 插件：为主 Agent 配置多个**并行运行的影子认知核心**（Shadow Minds），每次回合结束后按概率抽签激活，审阅主 Agent 轨迹并将发现回注给主 Agent —— "边实现，边审阅"。

> ⚠️ **成本警告**：每个影子会话都重建独立上下文（约 2–4 万 input tokens）。本机代理实测每次激活成本约 **$0.06–0.25**。默认配置（heartbeat 1/3、激活概率 0.3、并发 2）下会频繁触发，请按需调低 `heartbeat_probability` 或设置 `daily_budget_usd` 封顶。影子默认 `effort=medium`，比主会话的 max 便宜很多。

## 安装 / 启用

### 方式 A：临时试用（推荐先做这个）

```powershell
claude --plugin-dir "D:\Personal\Desktop\新建文件夹 (6)\pi-shadow-mind-claude" -p "..."
```

### 方式 B：全局启用

```powershell
node "D:\Personal\Desktop\新建文件夹 (6)\pi-shadow-mind-claude\bin\install.mjs"
```

`install.mjs` 会把 `{pluginDir, nodePath}` 写入 `C:\Users\Administrator\.claude\shadow-mind.json`，供 `/shadow` 斜杠命令解析插件路径。随后在 `~/.claude/settings.json` 的 `enabledPlugins` 或 plugins 中启用（或通过 `/plugin` 安装本地目录）。hooks（Stop / UserPromptSubmit / SessionEnd）随插件启用后自动生效。

## Shadow Mind 定义

每个 Shadow 是一个 Markdown 文件，放在 `C:\Users\Administrator\.claude\shadow-minds\` 下：

````markdown
---
id: architecture-review
name: Architecture review
activation_probability: 0.3
active_for_models: ["*"]
tools: [read, grep, find, ls]
---

审阅主 Agent 当前的实现是否偏离合理架构。检查职责边界、上帝组件、
脆弱的扩展点。只报告有证据、可行动的问题；与职责无关时不要介入。
````

字段：`id`（必填，`[a-z0-9_-]`）、`name`、`enabled`（默认 true）、`debug`、`activation_probability`（0–1，默认 0.3）、`active_for_models`（默认 `["*"]`）、`run_with_model`、`thinking_level`、`timeout_seconds`（默认 300）、`tools`（可识别的名字见下）、正文 = 职责 prompt。

**工具名映射**（Pi 名 → Claude Code 名）：`read→Read`、`grep→Grep`、`find→Glob`、`ls→LS`、`webfetch→WebFetch`、`websearch→WebSearch`、`task→Task`、`bash→Bash`（必须显式声明才放行）。未识别的名字按原版语义丢弃。默认只读集 `read,grep,find,ls` 始终合并。

## 管理命令

```
/shadow status          # 状态
/shadow pause|resume    # 暂停/恢复（暂停后不再抽签）
/shadow list            # 列出定义
/shadow create <id>     # 新建（编辑正文描述职责）
/shadow delete <id>     # 删除（先经用户确认）
/shadow config get|set  # 查看/修改 config.json
```

或直接跑 CLI：`node <pluginDir>/bin/admin.mjs <命令>`。

## 配置（config.json，位于 `~/.claude/shadow-minds/config.json`）

| 键 | 默认值 | 说明 |
|---|---|---|
| `heartbeat_probability` | 0.3333 | 每轮结束后抽签概率 |
| `max_parallel_shadows` | 2 | 最大并发影子数 |
| `default_shadow_timeout_seconds` | 300 | 影子单轮超时（上限还受 `max_wait_ms` 约束） |
| `max_wait_ms` | 90000 | Stop hook 内所有影子共享的等待预算，到期强杀 |
| `default_shadow_model` | null | 影子模型（不设则继承默认） |
| `default_thinking_level` | "medium" | 映射为 `--effort` |
| `random_seed` | null | 可复现抽签 |
| `max_report_chars` | 4000 | 报告截断长度 |
| `max_trajectory_chars` | 200000 | 轨迹截断长度 |
| `use_safe_mode` | true | 影子进程加 `--safe-mode`（禁 hooks/插件/CLAUDE.md/MCP，防重入） |
| `daily_budget_usd` | null | 每日成本封顶，达到后冻结抽签（约 0.05/次估算） |
| `report_delivery` | "context" | `"context"`=additionalContext 注入；`"block"`=decision block（实验） |

## 工作原理

1. 主 Agent 每次响应结束 → `Stop` hook 触发。
2. hook 读 `transcript_path` 解析净化轨迹（剥 thinking、工具结果摘要化、过滤子任务 sidechain），序列化为 `<main-agent-trajectory>`。
3. heartbeat 抽签 → 各 Shadow 独立抽签 → 并发上限内并行 spawn `claude -p --safe-mode --permission-mode plan` headless 子会话，stdin 注入"轨迹 + 协议 + 职责"。
4. 影子判定相关性：无关输出 `NOT_RELEVANT` 静默退出；相关则只读检查后输出报告文本。
5. 报告合成为 `[name / id]\n内容`，通过 Stop hook 的 `hookSpecificOutput.additionalContext` 注入主会话（转录标记 "Stop hook feedback"，对话继续让主 Agent 处理）。
6. 用户新输入 → `UserPromptSubmit` hook：epoch+1、`taskkill /T /F` 杀光本会话的影子进程、作废未交付报告（等价 Pi 的 abortAll）。
7. 会话结束 → `SessionEnd` hook 清孤儿；每次进场先 sweep 过期进程。

## 与原版的能力差异

- 影子不继承主会话个性化 system prompt（transcript 取不到），使用 Claude Code 默认系统提示 + 注入协议/职责。
- `report_to_main` 内建工具降级为"影子 stdout 文本即报告"。
- 异步 400ms 报告批处理窗口未实现（同步模型下无意义）；`headless_drain` 未移植（SessionEnd 只做清孤儿）。
- 状态 widget / 面板未移植，用 `/shadow status` 代替。

## 开发

```powershell
npm test          # node --test test/*.test.mjs
claude plugin validate --strict .\pi-shadow-mind-claude
```