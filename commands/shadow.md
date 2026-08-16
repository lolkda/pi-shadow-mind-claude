---
description: Manage Shadow Mind background shadow agents (status, pause, resume, now, list, create, delete, config).
---

# Shadow Mind

管理 Shadow Mind 后台影子智能。用法: /shadow status|pause|resume|now [id]|list|create|delete|config get|set

说明: now [id] 是手动强制触发——无论 heartbeat 概率是多少都会在下一回合结束后立即审阅指定（缺省全部）Shadow，适合"我希望这次专门审一下"的场景。触发一次后自动失效。

先读取 C:/Users/Administrator/.claude/shadow-mind.json 中的 "pluginDir" 字段获得插件绝对路径
(该文件由 install.mjs 在插件安装时写入)，然后执行:

node "<pluginDir>/bin/admin.mjs" $ARGUMENTS

向用户汇报 admin.mjs 的输出，不要自行猜测参数。涉及删除(shadow delete)前先向用户确认。