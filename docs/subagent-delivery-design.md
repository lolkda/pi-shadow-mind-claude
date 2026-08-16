# 影子报告主动送达设计（Subagent 方案）

> 状态：设计稿（未实施）。对应诉求：影子（Shadow Mind）审阅完成后，**无需用户发起下一次会话**，报告自动送达主 Agent 并由主 Agent 主动处理。
> 探索草稿 `bin/notify.mjs`（报告落盘即系统通知）为方向误解时的产物，不属于本方案主线，定稿后决定去留。

## 1. 问题与目标

现状：collector 把影子报告 append 到 `reports/<sessionId>.jsonl`，唯一取出点是下一次 `Stop` hook 的排水（claim → additionalContext）。用户不发言，报告就滞留在队列里。

目标：影子报告完成后 → 主 Agent 自动收到并处理，用户零操作。允许的代价：主 Agent 每次处理报告会产生一个用户可见的回合。

## 2. 平台机制事实（2026-08，官方文档核实）

| # | 事实 | 置信度 | 对本设计的含义 |
|---|---|---|---|
| F1 | 会话内**后台 subagent**（Agent/Task 工具后台模式）完成时，结果以 completion notification 在**后续回合**注入主会话，主 Agent 在其中主动汇报/处理；idle 时也呈现（footer 脉冲 "N done"） | 高（需实测是否**必定**触发一次模型调用） | 异步 + 回报是平台原生能力——方案 A 的地基 |
| F2 | 独立后台会话（`claude --bg` / `/background`）完成**不**唤醒主会话，只发用户侧通知 | 高 | 必须用"会话内后台 subagent"，不是 --bg |
| F3 | Agent 工具**无 timeout 参数**、无墙钟时长上限；约束为 `maxTurns`（subagent 定义 frontmatter）、并发上限 20（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）、嵌套深度 3 | 高 | 影子 subagent 必须显式限制 maxTurns，否则失控无兜底 |
| F4 | Monitor 对后台 subagent 可用；无轮询间隔概念，事件节奏由被监视命令控制；Monitor 内可任意 sleep 不被中断 | 高 | 方案 B（watcher）依赖此项；"1 分钟最小间隔"未证实，需实测 |
| F5 | 完成通知是"需要处理并回应"的输入事件，作为普通 assistant 可见回合落入 transcript，**触发该回合的常规 hooks** | 高 | 完成回合会触发 Stop hook → 存在"完成→再激活→再完成"正反馈，必须加激活冷却 |
| F6 | 后台 subagent 是完整 agentic loop（非单轮）；`ScheduleWakeup` 对 subagent 不可用；`SendMessage` 可后台自动 resume 已完成的 subagent | 高 | 影子可以做"只读检查→报告"全程；方案 B 循环靠主 Agent 重生而非自醒 |
| F7 | 后台 subagent 存活依赖交互式会话；headless `-p` 模式下后台任务在 run 结束后很快终止 | 高 | 影子后台模式只在交互式会话可用——与现有 collector（headless 兼容）不同，需明确适用边界 |
| F8 | Agent 工具调用参数仅 `prompt`/`model`/`name`/`isolation`/`run_in_background`；`max_turns`/`effort`/`thinking`/`temperature`/`tools` **都不是调用参数**，限制只能在 subagent 定义 frontmatter 设置（`maxTurns` 驼峰、`tools` 白名单、`disallowedTools`、`permissionMode`、`effort`、`model`） | 高 | 影子 subagent 必须以"定义文件"形式存在，激活指令只能"点名字"，不能现配限制 |
| F9 | 工具类 hook（PreToolUse/PostToolUse 等）在 subagent 内照常触发；hook input 的 **`agent_id`/`agent_type` 是区分主/子会话的正式字段**（文档原话 "Present only when the hook fires inside a subagent call"），并无 `is_subagent`；另有 `SubagentStart`/`SubagentStop` 专用生命周期事件；`UserPromptSubmit`/`Notification`/`Stop` 在 subagent 回合内行为无明文（需实测） | 高（字段存在）；中（Stop 事件在 subagent 回合的行为） | 防重入有正式身份字段可用：hook 侧检测 `agent_id` 存在即跳过——V1 从"致命未知"降级为"待实测确认 Stop 在 subagent 回合确实触发且 input 携带 agent_id" |
| F10 | subagent 定义 frontmatter `tools:` 白名单（省略=继承全部）+ `disallowedTools` 黑名单 = **定义层硬工具隔离**；后台 subagent 另有第二层工具过滤（保留 Read/Grep/Glob/Bash/Edit/Write/WebFetch/WebSearch/TodoWrite/Skill/MCP 等） | 高 | 颠覆早期论断"subagent 无法硬隔离工具"——只读影子可用定义文件硬实现；但必须**显式排除** Edit/Write/Bash，不能省略 tools 字段 |

## 3. 方案对比

### 方案 A：会话内后台 subagent（推荐主干）

```
Stop hook 抽签命中
  └─ 注入 <shadow-activation> 指令（additionalContext，带 id 列表/transcript 路径/时间预算）
主 Agent 回合内：
  ├─ Read 各影子定义文件（~/.claude/shadow-minds/<id>.md）
  ├─ 用 Bash 调 node bin/serialize-transcript.mjs <transcript_path> 生成净化轨迹（进影子自己的上下文，主 Agent 不背）
  └─ 为每个影子 spawn 后台 subagent（Agent 工具，max_turns 限 3–5）
主 Agent 结束回合（用户无操作）
后台 subagent 独立执行（只读检查 → 判定相关 → 输出报告）
subagent 完成 → completion notification 唤醒主 Agent → 主 Agent 汇报报告并处理
```

- **优点**：无轮询、无报告队列、无 collector；异步和回报都是原生；报告全程可见（用户能在 TUI 看到主 Agent 处理影子报告，比现在的静默注入透明）。
- **弱点**（必须正视）：
  1. **工具权限不可硬隔离**：subagent 继承主 Agent 全部工具，没有 `--safe-mode` / `--allowedTools` 硬白名单。"只读"只能靠指令约束（软）。缓解：指令强声明 + maxTurns 收紧 + 影子职责仍以 read/grep/glob 为主。
  2. **激活可靠性依赖主 Agent 遵从指令**：hook 只能"建议激活"，主 Agent 可能忽略/误解（当前 collector 模式是确定性的）。缓解：指令格式固定、模板化；失败可加"未收到确认则下回合重发"（v1 不做，先观测）。
  3. **每个完成通知 = 一个可见回合 + 一次模型调用**：比现状多花汇报成本；F5 正反馈需冷却门控。
  4. **不兼容 headless `-p` 主会话**（F7）。与 collector 模式互补而非替代。

### 方案 B：后台 watcher 轮询（备选，仅当 A 受阻）

后台 subagent + Monitor（persistent watch 一个 probe 命令：`node bin/shadow-watch-probe.mjs <sessionId>`，内部复用 `claimReports` 原子改名）+ 报告出现即结束返回 → 唤醒主 Agent 处理 → 主 Agent 重生 watcher。循环保持靠"完成→重生"，空结果时静默续命。

- 比 A 多一层轮询与循环协议；且它本身也是后台 subagent，**同样受 V1（Stop hook 对 subagent 回合行为）影响**——V1 不过它也不成立。

### 方案 C：现状（collector + Stop 排水）+ 主动通知（对照）

报告仍留在下一回合送达，但落盘瞬间发系统通知（notify.mjs 已完成大半）。只解决"用户知道有报告"，不解决"自动送达主 Agent"。作为 V1 失败时的兜底。

## 4. 方案 A 详细设计

### 4.1 激活决策（完全复用现状）

Stop hook 的抽签逻辑**不动**：heartbeat 概率、activation_probability、模型过滤、`max_parallel_shadows` 槽位、`daily_budget_usd` 预算。变化仅在命中后的**执行方式**：

- 现状：`spawnCollector(job)` → 后台进程。
- 新：返回 `hookSpecificOutput.additionalContext`，内容为固定格式激活指令：

```
<shadow-activation>
激活影子审阅：<id1>, <id2>
- 每个影子定义：Read .claude/agents/shadow-<id>.md（subagent 形态的生成定义，见 4.1b；不要读 shadow-minds/ 原格式）
- 轨迹来源：由你在本回合运行 node "<pluginDir>/bin/serialize-transcript.mjs" "<transcript_path>" <max_chars>
  （输出即已净化窗口轨迹；把结果文本整体放入影子提示词，不要改写——因此影子定义不需要 Bash）
- 为每个影子启动一个【后台】subagent（不要阻塞回合），提示词 = 轨迹 + 影子协议（README 中 SHADOW_PROTOCOL 语义）+ 职责正文 + 时间预算 <N> 秒
- 轮数/工具限制只能来自定义文件（Agent 工具调用不支持传 maxTurns/工具限制，F8）；点名 shadow-<id> 即可
- 收到完成通知后：汇总报告并处理（验证/修正/告知用户），不要等待用户指令
</shadow-activation>
```

- `transcript_path` 来自 Stop hook input（含 `last_assistant_message` 兜底逻辑，由 serialize 脚本复用现有 `trajectory.mjs` 语义）。
- `serialize-transcript.mjs` 是新增的小 CLI 包装（约 20 行，复用 `serializeTrajectory`），后续方案 B 的 probe 同理。

### 4.1b 影子定义文件（subagent 形态，保持单一数据源）

影子本体仍是 `~/.claude/shadow-minds/<id>.md`（frontmatter 含 id/激活概率/模型过滤/tools 等插件语义）。subagent 形态需要 Claude Code 可 spawn 的定义，因此新增**生成映射**（`admin.mjs sync-agents` 子命令，从 registry 单向生成 `.claude/agents/shadow-<id>.md`，admin 每次写操作后自动重跑，或 `/shadow sync-agents` 手动触发）：

```markdown
---
name: shadow-<id>
description: Shadow Mind "<id>" 的只读后台审阅进程；由 /shadow 激活指令点名启动。
tools: [Read, Grep, Glob, LS]        # 显式只读白名单；绝不省略（省略=继承全部工具，F10）
disallowedTools: [Bash, Edit, Write] # 双保险
maxTurns: 5                          # 失控保护（驼峰命名，仅定义层入口，F8）
effort: medium                       # 映射自 default_thinking_level
model: inherit                       # 映射自 run_with_model / default_shadow_model；inherit=继承主会话
---

（正文 = 影子职责 prompt + SHADOW_PROTOCOL 语义，由 sync 拼接）
```

要点：
- `permissionMode` 保持默认不设 plan：后台 subagent 的权限请求会冒到主会话（v2.1.186+），只读白名单本不该触发请求，设 plan 反而每次 spawn 都弹请求。
- 影子职责若声明 `tools: [bash, ...]`（Pi 名），sync 时拒绝生成写类工具（映射表只放行 read/grep/find/ls/webfetch/websearch），日志提示该影子仅适合 collector 模式。

### 4.2 防重入与冷却（F5 的处置）

两个风险点：

1. **subagent 自身回合是否触发 Stop hook**（V1，未知）：若触发，影子回合会再次抽签 → 递归激活。
2. **完成通知回合触发 Stop hook**：主 Agent 汇报完 → Stop → 抽签 → 又激活一批 → 正反馈循环。

处置（主守卫有文档依据，冷却为通用门控）：

- **主守卫（F9）**：Stop hook 读取 hook input 的 `agent_id`——文档确定该字段"只在 subagent 内触发时存在"。存在即影子回合，直接跳过不抽签。这使 V1 从"致命未知"降级为"待实测确认 Stop 事件在 subagent 回合确实触发且 input 携带 agent_id"；即使 Stop 不触发，守卫也是无害的。
- **冷却门控**：hook 端在注入激活指令时，把 `lastShadowActivationAt` 写入 state.json（原子，复用 StateStore）。Stop 抽签前检查：`now - lastShadowActivationAt < activation_cooldown_ms` 则跳过（默认 180_000，可配）。针对完成通知回合（主会话回合，无 agent_id 保护）的再激活正反馈。

### 4.3 报告回程与可见性

- 影子 subagent 输出（最终 report 文本）→ 完成通知注入主会话 → 主 Agent 汇报。
- 语义对齐现有 `reportText`：`NOT_RELEVANT` / 空输出 = 影子判定无关或无事可报 → 主 Agent 在汇总回合如实简述"XX 影子判定无关"，不展开。
- 多影子并发完成 → 各自注入通知；主 Agent 合并汇报。
- 对比现状：现状报告静默注入（用户无感，回合由用户发起）；方案 A 报告可见（用户看到主 Agent 主动汇报），这是主动式的必然形态，写入 README 预期管理。

### 4.4 配置与兼容（灰度）

```jsonc
// config.json 新增
"activation_delivery": "collector",   // "collector" 现状 | "subagent" 方案A
"activation_cooldown_ms": 180000,      // 激活冷却，防完成回合正反馈
```

- 默认仍 `collector`，`/shadow config set activation_delivery subagent` 切换。
- 两模式共存：配置、抽签、预算、shadows 定义、reuse 会话记录全兼容；唯一差异在"命中后怎么跑 + 报告怎么回"。
- reuse 持久会话在方案 A 下不可用（subagent 无法 `--resume` 影子自己的 claude 会话）——方案 A 影子为一次性上下文（对应 `ephemeral` 语义），文档与 config 校验需注明：`activation_delivery: subagent` 时 `shadow_persistence` 强制视为 `ephemeral`。

### 4.5 安全与成本画像

- 安全：**工具隔离是硬性的**（4.1b 定义层 tools 白名单 + disallowedTools 双保险，F10），不再依赖提示词自觉。剩余妥协：主 Agent 在回合内运行 serialize CLI（Bash 属主 Agent 自己的正常能力，非影子权限）；后台 subagent 第二层工具过滤仍含 Edit/Write，因此白名单必须显式排除，不能省略 tools 字段。
- 成本：影子自身 token 与现状相同（轨迹相同）；增量 = 每次完成通知的一个可见回合（~数百–1k tokens）+ 激活指令注入量（仅 id/路径/预算，~200 tokens，不注入职责全文）。对比现状多出"完成回合"，换来主动送达。若实测完成回合成本不可接受，可用 `delivery: "quiet"` 回退现状。

## 5. 必做实验（实施前，约 15 分钟，交互式会话）

| 编号 | 实验 | 判定 |
|---|---|---|
| V1 | 让一个后台 subagent 跑若干轮工具调用，观察 Stop hook（`shadow-debug.log` 是否有 hook 执行记录/激活尝试）是否在其回合触发；确认触发时 hook input 携带 `agent_id`（F9 守卫生效） | 触发且 input 无 agent_id → 无法区分，方案 A/B 受阻，走 C；有 agent_id → 守卫成立，A 主线可行 |
| V2 | 后台 subagent 完成时主 Agent idle：是否必定产生一个汇报回合（观测 transcript 新 assistant 消息）；记录该回合 token 成本 | 确认主动送达成立 + 成本量级 |
| V3 | （方案 B 前置）后台 subagent + persistent Monitor watch 时间戳命令，观察事件粒度与"它停轮后能否继续" | 决定 B 是否可用；A 主线不依赖 |
| V4 | 同回合 spawn 2–3 个后台 subagent，观察完成通知是否逐个/合并注入、主 Agent 汇报形态 | 确认并发行为与汇报质量 |

## 6. 实施清单（V1–V4 通过后）

1. `bin/serialize-transcript.mjs`：CLI 包装（复用 `serializeTrajectory`，参数 = transcript 路径 + maxChars，输出轨迹文本）。由主 Agent 回合内调用，影子定义不含 Bash。
2. `bin/shadow-stop-hook.mjs`：命中后按 `activation_delivery` 分流——collector 现路径不变；subagent 路径先做 `agent_id` 守卫（存在即跳过），再写 `lastShadowActivationAt` + 注入 `shadow-activation` 指令。
3. `admin.mjs sync-agents`：从 registry 单向生成 `.claude/agents/shadow-<id>.md`（tools 只读白名单/disallowedTools/maxTurns/effort/model 映射，见 4.1b）。
4. `bin/config.mjs` + `shadow-minds/config.json`：加 `activation_delivery`、`activation_cooldown_ms`，校验二者互斥语义（subagent ⇒ persistence=ephemeral）。
5. `commands/shadow.md`：`/shadow config set activation_delivery subagent` 说明 + 主动回合预期管理。
6. 测试：config 校验、指令模板生成、serialize CLI、冷却门控（fake 时钟）、sync-agents 生成品。
7. README：机制图 + 能力差异表更新（"影子不继承主会话 system prompt"条目 → "subagent 模式：影子在主会话进程内，通过定义层只读白名单隔离"；成本警告更新）。

## 7. 决策门槛

- V1 通过（不触发 / 触发且 input 带 agent_id）→ 实施 A，灰度切换测试。
- V1 失败（触发且无 agent_id）→ 评估 C（通知兜底）+ 短期可接受：报告下一回合送达；长期等平台提供 subagent 会话隔离标记。
- V2 成本量级显著劣于预期 → 默认保持 collector，subagent 作为"按需主动审阅"（`/shadow now --active`）的可选通道。