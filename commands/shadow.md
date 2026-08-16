---
description: Manage Shadow Mind background shadow agents (status, pause, resume, now, list, create, delete, config).
---

# Shadow Mind

管理 Shadow Mind 后台影子智能。用法: /shadow status|pause|resume|now [id]|list|create|delete|config get|set

说明: now [id] 是显式强制触发——立即在后台审阅指定（缺省全部）Shadow，报告在随后的回合送达，触发一次后自动失效；若同会话已有影子在跑则排队到批结束后触发。

自动触发（可选）: `config set auto_review_enabled true` 后，本回合动过 `auto_review_exts` 中后缀的文件（写操作或命令中出现 x.py 之类）会自动激活全部影子审阅（日志标记 AUTO）；改其他文件或只读浏览不触发。

先读取 C:/Users/Administrator/.claude/shadow-mind.json 中的 "pluginDir" 字段获得插件绝对路径
(该文件由 install.mjs 在插件安装时写入)，然后执行:

node "<pluginDir>/bin/admin.mjs" $ARGUMENTS

向用户汇报 admin.mjs 的输出，不要自行猜测参数。涉及删除(shadow delete)前先向用户确认。