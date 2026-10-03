# 记忆系统开源项目致谢

眠眠记忆 · Conversation Memory 是眠眠机记忆系统的 SillyTavern 适配。整理规则参考以下项目的公开架构与提示词设计原则：逐条来源覆盖、先拆事实再聚合场景、来源可追溯、事件时间与记录时间分离、原始活动保留、保守的低价值归档和分层召回。

| 项目 | 项目许可证 | 本项目参考内容 |
| --- | --- | --- |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | 来源覆盖、事实溯源、事件时间字段 |
| [Cognee](https://github.com/topoteretes/cognee) | Apache-2.0 | 分类、语义切块与事件抽取流水线 |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | 事实提取和分层记忆操作思路 |
| [Hexis](https://github.com/QuixiAI/Hexis) | MIT | 原始经历与提炼记忆分层维护 |
| [OmniMemory](https://github.com/omnirexflora-labs/omnimemory) | MIT | 缓冲活动与摘要整理分阶段执行 |
| [Ombre-Brain](https://github.com/P0luz/Ombre-Brain) | MIT | 来源桶、记忆沉底而非直接删除 |

许可证信息核对日期：2026-10-04。各项目最新许可证和版权声明以对应仓库为准。

当前插件由独立实现并适配的眠眠机记忆模块与酒馆适配代码组成，没有直接打包上列项目的运行时代码，也未引入它们的数据库、服务端或第三方运行时依赖。参考项目的许可证说明不等于本插件自身的许可声明。

感谢 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的扩展机制与 [官方扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。这些项目与作者未为本插件提供官方背书。

若后续直接复制或修改第三方代码，需要随发布版本保留对应许可证全文、版权声明及适用的 NOTICE。本页致谢不替代这些声明。
