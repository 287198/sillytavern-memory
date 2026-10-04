# Conversation Memory JSON v1

公开、UTF-8 的记忆交换文件；不是完整聊天备份。入口标识固定为 `format: "conversation-memory"`、`version: 1`。

| 顶层字段 | 含义 |
| --- | --- |
| `exportedAt` | ISO 8601 导出时间，可选 |
| `producer` | 来源工具名称、版本，可选 |
| `subject.id` | 来源端角色/聊天作用域标识，必须存在；不直接作为目标端角色 ID |
| `subject.name` / `userName` | 可读角色名及用户称呼，可选 |
| `subject.source` | 原应用、角色标识、聊天标识，可选；便于未来显式关联聊天 |
| `activities` | `activity_log` 来源活动数组，必须存在 |
| `periods` | `period_block` 事件/时期记忆数组，必须存在 |
| `cores` | `digested_block` 核心记忆数组，必须存在 |
| `externalActivityIds` | 旧库中已经裁出交换范围的来源活动 ID；明确表示引用证据不在本文件内，不能假装携带完整证据 |

每条记录必须有 `id`、`charId`、`kind`，`charId` 对应 `subject.id`。角色 ID 上限 120 字符，记录 ID 上限 160 字符；同一集合不能有重复 ID。文件大小上限 20 MB。

## 通用记录与时间

`summary` 保存完整记忆正文，活动和时期记忆不能为空。`state`、`sourceRefs`、`keywords`、`entityTerms`、`participants`、`importance` 保留原含义。`sourceRefs` 是应用与消息来源的可读引用，不随目标端映射改变。

`transferOrigin: {subjectId, id}` 保留首次来源身份；接收方生成自己的 ID，用首次来源身份去重，不能每次导入都随机分配来源身份。核心候选条目也可以保留自己的 `transferOrigin`，跨端修改后再导回时保留本地冲突内容。

`sourceContext: {application, characterId, chatId}` 保存原应用、角色和聊天标识，双向交换后仍保留原值。酒馆活动另外保留 `sourceIndex`（原消息数组索引）和 `sourceSwipe`（当前版本索引），配合 `sourceOrder`、来源指纹为日后显式关联聊天提供依据；这些字段不构成网络同步授权或覆盖本地游标的依据。

时间数值为 Unix 毫秒，允许缺失或 `null` 表示不适用：

- `occurredAt`：事件发生时间；`timeUnknown: true` 时应为 0 或缺失，禁止填确定发生日期。
- `recordedAt` / `knownAt`：来源记录和获知时间。
- `createdAt` / `updatedAt`：记忆生成和修改时间。
- `periodStart` / `periodEnd`：时期范围；未知时可为 null。
- `timeLabel`：原始可读时间措辞，未知时间也可保留虚构历法或“某天”。
- `timeAnchors` / `subjectTime`：原时间表达、来源楼层、精度、锚点及依据。
- `sourceOrder`：来源端逻辑楼层顺序，不是目标端聊天游标。

`at` 是兼容存储/索引字段，不能覆盖 `timeUnknown` 或冒充剧情发生时间。跨端召回必须尊重未知时间。

酒馆插件 0.5.0 的 AI 补时间结果在 `timeLabel` 标明“推测”，`timeAnchors` 保留依据、精度和范围。用户仅提供月份、季节或年份时，`periodStart` / `periodEnd` 保存大致范围，不能把范围起点解释成确切发生日；跨端应显示可读标签与精度。

仍未知的事件导出时 `occurredAt` 保持 0，`at` 仅作为列表排序位置：根据前后已知事件与 `sourceOrder` 安置，整段无日期时保留段内顺序。排序位置不能用于补日期、事实有效时间或显示成真实日期。故事时间线背景只保存在当前聊天，未新增私有顶层格式。

## 活动、时期和核心

活动可带 `module`、`actionType`、`consolidatedInto` 等字段。酒馆活动以当前选定 swipe 的消息或提取摘要为来源，`source` 标明 `preset_summary` 或 `message_body`。

时期记忆保留 `eventSummary`（短事件摘要）、`summary`（完整经历）、`facts`、`activityRefs`、事件链及证据版本、来源校验、消化状态。`activityRefs` 必须对应文件中的活动或明确列出的 `externalActivityIds`。

事实保留完整 `text`、`kind`、`entityTerms`、`status`、`evidenceIds` / `sourceActivityIds`、`sourceRefs`、发生时间及有效时间。不能从角色设定推断新事实。当前 API 对 AI 输出按共享规则校验覆盖、来源与完整性后才存储。

核心 `scope: "local_user_core"` 表示角色应知道的本地关系/身份核心，`items` 中每项至少有 `id`、`text`，并可带 `type`、`state`、`originBlockId`、`sourceRefs`、`locked`、`pinned`、`userEditedAt` 等字段。当前五类是「当前生活状态、重大里程碑、硬性约定、誓约信物、个人信息」。旧核心正文 `summary` 也保留；追加新候选时不能使旧正文不可见。

眠眠机尚未进入结构化库的旧大块记忆导出为普通 `period_block`，原文完整、不额外生成事实，具体发生时间未知。

## 导入行为

先验证，再映射到明确选定的目标角色；活动、时期、核心、事实证据和核心来源引用一起重映射。原数据库 key 不可信也不读取。

相同来源相同内容跳过，同来源不同内容计为冲突并保留本地内容。核心候选追加并去重，不覆盖既有锁定/手改条目。普通导入使用一次追加事务，不调用清库式备份恢复。外部文件的 cursor、设置、密钥和缓存不会进入目标端。

[Schema](conversation-memory.schema.json) 检查基本形状；跨记录引用、源角色一致性、重复 ID 和未知时间约束由运行时进一步验证。未列出的字段不代表执行权限；导出使用记忆字段白名单，凭证和内部缓存不导出。
