# HDS Interlude 文档索引

当前发布基线为 `1.0.1-rc24`。根目录 README、新手指南、配置指南和命令文档面向使用者；本目录保存当前架构、设计依据、发布增量与维护记录。判断当前行为优先阅读“当前实现”，历史报告只用于追溯，不覆盖源码与当前架构。

## 当前实现

- [ARCHITECTURE.md](ARCHITECTURE.md)：当前真实架构和数据流。
- [V2_IN_PLACE_REFACTOR_IMPLEMENTATION_FORM.md](V2_IN_PLACE_REFACTOR_IMPLEMENTATION_FORM.md)：V2 原位迁移、当前完成度和验证门槛。
- [V2_VS_BETA10_COMPARISON.md](V2_VS_BETA10_COMPARISON.md)：beta10 与当前 V2 架构的对照及拟真性收益。
- [ALTER_SYSTEM.md](ALTER_SYSTEM.md)、[AGENCY_WINDOW.md](AGENCY_WINDOW.md)、[SCHEDULE_PREPLAN.md](SCHEDULE_PREPLAN.md)：当前次级系统边界。
- [FORWARD_MESSAGE_READING_DESIGN.md](FORWARD_MESSAGE_READING_DESIGN.md)：QQ 合并转发读取现状、SnowLuma 接口依据与 HDSI 接入方案。
- [WORLD_EVENT_SEEDER_DESIGN.md](WORLD_EVENT_SEEDER_DESIGN.md)：世界事件播种器（已随 rc23 发布；rc24 起模型选择为用途勾选）——外部事件源、事实权威/反应自由语义、生成回路与注入管线。
- [GROUP_WILLINGNESS_TIERS.md](GROUP_WILLINGNESS_TIERS.md)：群聊意愿档位化与 auto 档（已随 rc23 发布）。

## 发布增量与维护记录

- [rc12 Anthropic Messages 适配](development/ANTHROPIC_MESSAGES_RC12.md)：双协议选择、cache-first、流式、群音频写作与兼容边界。

- [CHANGELOG.md](CHANGELOG.md)：rc12 双协议与群音频接入，以及此前发布记录。
- [EVENT_LED_SCRIPT_REPAIR.md](development/EVENT_LED_SCRIPT_REPAIR.md)：事件优先续写、Alter 收束与关系学习证据边界。

- [URGE_SYSTEM_PROPOSAL.md](development/URGE_SYSTEM_PROPOSAL.md)：可选 Urge 自动推进设计；源码已实现，默认关闭。
- [URGE_SYSTEM_IMPLEMENTATION.md](development/URGE_SYSTEM_IMPLEMENTATION.md)：Urge 配置、历史兼容、部件合作和验证边界。

- [P1_MEMORY_NAVIGATION.md](development/P1_MEMORY_NAVIGATION.md)：同事项交接、渐进补齐、原文跨度与事项导航。
- [CHANGELOG.md](CHANGELOG.md)：版本血统和当前版本变更。
- [SECURITY.md](SECURITY.md)：发布包边界、依赖审计和已知上游风险。
- [SCRIPT_CENTRIC_ARCHITECTURE_REDESIGN.md](SCRIPT_CENTRIC_ARCHITECTURE_REDESIGN.md)：V2 的历史目标架构提案。
- [development/README.md](development/README.md)：发布增量与历史维护资料的分类索引。
- [development/logging/LAYERED_LOG_IMPLEMENTATION.md](development/logging/LAYERED_LOG_IMPLEMENTATION.md)：当前彩色分层日志实现。
- [development/logging/LOG_FORMAT_DESIGN.md](development/logging/LOG_FORMAT_DESIGN.md)：日志输出约束。

## 本地归档

根目录 `release/` 保存当前候选包及必要的回退包；源码恢复快照位于 `dustbin/source-backups/`，较旧发布包位于 `dustbin/release-history/`，旧向导、早期笔记与构建检查也均在 `dustbin/` 下。归档不会进入 npm 包；需要追溯时可在本地查看。

## 阅读原则

判断当前行为时只以 `src/`、根目录四份用户文档以及本目录的当前文档为准。`dustbin/` 中的内容都不是当前实现说明。
