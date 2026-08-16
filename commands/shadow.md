---
description: Manage Shadow Mind background shadow agents (status, pause, resume, list, create, delete, config).
---

# Shadow Mind

管理 Shadow Mind 后台影子智能。用法: /shadow status|pause|resume|list|create|delete|config get|set

先读取 C:/Users/Administrator/.claude/shadow-mind.json 中的 "pluginDir" 字段获得插件绝对路径
(该文件由 install.mjs 在插件安装时写入)，然后执行:

node "<pluginDir>/bin/admin.mjs" $ARGUMENTS

向用户汇报 admin.mjs 的输出，不要自行猜测参数。涉及删除(shadow delete)前先向用户确认。