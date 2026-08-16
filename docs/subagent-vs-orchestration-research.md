# 调研:用 Claude 原生 subagent 实现影子审查 vs 用 hooks 实现(现状 shadow-mind-claude)

> 范围澄清:本文对比的是**两条独立的技术路线**——
> - **subagent 路线**:影子 = Claude 原生后台 subagent(定义文件 + Task/Agent 工具),不依赖本插件的 hooks
> - **hooks 路线**:影子 = 现状 shadow-mind-claude(Stop hook 抽签 + collector 起独立 `claude -p` 进程 + Stop 排水),即当前仓库的实现
>
> 之前的版本错误地把"hook 编排 + subagent 执行"当作 hooks 路线对比,已作废重写。

## 0. 两条路线的运行图

**subagent 路线(纯原生,零插件):**

```
你(或主 Agent)触发:"审一下代码"
  → spawn 后台 subagent(定义文件:代码审查员,只读工具,职责固话)
  → 主 Agent 结束回合
  → subagent 后台执行(读轨迹/文件)
  → 完成 → 平台自动唤醒主 Agent → 报告自动送达(用户可见回合)
```

**hooks 路线(现状 shadow-mind-claude):**

```
每回合结束 → Stop hook 触发
  → hook 抽签(1/3 概率 + 每个影子激活概率 + 模型过滤 + 预算)
  → 命中 → 交给后台 collector 进程
  → collector 起独立 `claude -p --safe-mode` 会话(喂净化轨迹)
  → 报告落盘到 reports/<会话>.jsonl
  → 等你下一次发消息 → Stop hook 排水 → 报告注入主会话(不可见)
```

## 1. 一目了然的区别

| | subagent 路线 | hooks 路线(现状) |
|---|---|---|
| 谁决定开始审 | 你 / 主 Agent 自觉 | **机器自动**(抽签) |
| 谁去审 | 同进程后台 subagent | 独立 `claude -p` 进程 |
| 报告怎么送达 | **跑完自动唤醒主 Agent**(平台原生) | **等下一次用户回合**(Stop 排水) |
| 你需要做的事 | 记得说"审一下"(或主 Agent 自觉) | 什么都不用做,但报告要等你开口才到 |

**一句话:subagent 路线"送达主动、触发被动";hooks 路线"触发自动、送达被动"。** 两者各自补的恰是对方缺的。

## 2. 全维度对比

| 维度 | subagent 路线 | hooks 路线(现状) | 谁赢 |
|---|---|---|---|
| 主动送达(你关心的核心) | ✅ 完成通知自动唤醒主 Agent,用户可见 | ❌ 必须等下一次用户输入,否则报告滞留队列 | subagent |
| 自动触发(无人值守) | ❌ 只能手动/主 Agent 自律(会忘) | ✅ hook 抽签,一致性承诺 | hooks |
| 影子隔离度 | 同进程,工具靠定义层白名单(tools/disallowedTools/maxTurns) | **进程级硬隔离**:safe-mode + 禁 hooks/插件/MCP + allowedTools,影子连自己都是不可重入的 | hooks |
| 影子上下文来源 | 同进程,可被主 Agent 喂轨迹 | 独立会话,只能靠脚本序列化 transcript | 相当(都靠喂) |
| 影子记忆 | 每次新上下文;主 Agent 可在 prompt 里附"上次结论"近似记忆 | reuse 模式 `--resume` 真实持久会话(带记忆,20 轮上限) | hooks |
| 主会话打扰 | 每次完成 = 一个可见回合 + 一次模型调用,用户会看到主 Agent 动 | 报告静默注入,主会话无感知(只在下一回合带入) | hooks(无感)/subagent(透明),看偏好 |
| headless / CI | ❌ 后台 subagent 依赖交互式会话 | ✅ 主会话 headless 也可(collector 独立) | hooks |
| 失败可见性 | ✅ 失败 = 完成通知 failed,主 Agent 看得见可重试 | ❌ collector/影子失败只有 debug 日志 | subagent |
| 预算/暂停/并发控制 | 无(靠自觉);可暂停 = 不触发即可 | ✅ daily_budget / /shadow pause / 槽位 / 冷却 | hooks |
| 报告格式统一/去重 | 靠主 Agent 现场发挥 | ✅ formatReport + claim 原子投递,至少一次 | hooks |
| 代码与维护 | **约零**(一个定义文件 + 一段行为约定) | 插件 15 模块 + hooks 全局注入 + state/reports 文件 | subagent 碾压 |
| 单次成本结构 | 子代理上下文 + 完成回合(~1k tokens) | 每次冷启动独立上下文(README 实测 $0.06–0.25/次,reuse 更高) | subagent 通常更低 |
| system prompt 继承 | ✅ 同进程,影子可读到主会话语境 | ❌ 独立进程,拿不到,只能用默认提示+协议 | subagent |

## 3. 关键洞察:为什么"自动"和"主动"不能兼得(纯选一条路线时)

- **自动触发只能靠 hooks**:subagent 不会自己醒;Platform 没有"每回合自动 spawn"的开关。想让"审阅不用人记得",唯一机制就是 hook(或行为约定这种软约束)。
- **主动送达只能靠 subagent**(或额外进程):hooks 在回合之间**没有执行时机**——报告只能等下一次事件(Stop/UserPromptSubmit/SessionEnd)才有出口。后台 subagent 完成通知是唯一"非用户输入也能唤醒主会话"的原生机制。
- 所以:**纯 subagent = 主动但靠自觉;纯 hooks = 自动但等回合。** 你的需求("自动审 + 报告主动来")单靠任何一条都不完整。

## 4. 落地选项与推荐

| 选项 | 做法 | 适合 |
|---|---|---|
| ① 纯 subagent | 定义 2~3 个影子文件 + AGENTS.md 写"大改动后自觉审一下";删掉/停用插件 | 你能接受手动/自觉触发;要简单、透明、报告主动 |
| ② hooks 现状 | 维持现插件;报告下一回合送达;接受"要开口" | 你就要无人值守自动审,能接受送达延迟 |
| ③ **组合(推荐试)** | **保留 hooks 做自动触发,报告送达改走 subagent 通道**:抽签命中 → 主 Agent 回合内 spawn 后台影子 subagent → 完成自动唤醒送达。报告队列/排水全部删除 | 要"自动 + 主动"两者兼得;代价是方案①的零代码优势没了,且多一条"主 Agent 遵从指令"的软链路 |

推荐路径:**先做①验证影子价值**(零成本,同一定义文件),如果"忘记审"成为实际痛点 → 上③(或先试 hooks 的 `/shadow now` 手动强制 + 接受延迟)。

## 5. 实施③前必须实测的三件事

1. 影子 subagent 回合是否触发 Stop hook、input 是否带 `agent_id` 标记(决定防递归守卫是否成立)
2. 后台 subagent 完成时主 Agent 是否必定自动产出汇报回合、成本多少
3. 同时 2~3 个影子,完成通知逐个/合并、主 Agent 汇报质量

(实测细节与③的完整设计见 [subagent-delivery-design.md](./subagent-delivery-design.md),其中 4.1b 已含 subagent 路线所需的定义文件生成方案;已存在的工作区草稿 `bin/notify.mjs` 与①②③均无关,另行处置。)