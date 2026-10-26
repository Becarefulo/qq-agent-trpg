# trpg-gm（跑团 GM · LLM 技能）

跑团扩展的**大模型部分**。放在 `skills/` 下，注册工具供模型决定何时调用。

## 里面有什么

| 文件 | 作用 |
| --- | --- |
| `skill.json` | 清单：工具元数据在 `index.js` 里注册，这里只写能力、配置、静态提示词 |
| `index.js` | 导出 `setup(api)`、`providers`、`available()`、`promptSections(ctx)` |
| `lib/format.js` | 把人物卡 / 掷骰结果渲染成给模型看的文本 |

## 注册的工具（17 个）

| 工具名（模型看到的） | 作用 |
| --- | --- |
| `trpg-gm__roll_dice` | 掷骰，`{expression, reason?, repeat?}` |
| `trpg-gm__roll_check` | 检定，`{target, label?, bonus?}` |
| `trpg-gm__get_character` | 读**当前发言者自己**的人物卡（别人的会被拒绝） |
| `trpg-gm__get_own_secret` | 读自己的私密背景与已知线索 |
| `trpg-gm__update_character` | 写**当前发言者自己**的人物卡，`{key, value, background?}` |
| `trpg-gm__set_scene` | 记录模组与场景序号 |
| `trpg-gm__get_scene` | 读剧情进度 |
| `trpg-gm__gm_mode` | 开关本群跑团模式 |
| `trpg-gm__read_module` | 读当前模组正文，`{section?, module?}` |
| `trpg-gm__show_status` | 发自己的状态面板 |
| `trpg-gm__show_party` | 发队伍面板（只有公开信息） |
| `trpg-gm__get_party` | 读队伍**公开**名册 |
| `trpg-gm__show_map` | 发当前地区地图 |
| `trpg-gm__move_to` | 移动并回新地图，`{place}` |
| `trpg-gm__list_documents` | 列出群里发来、自动进文档收件箱的 PDF/Word/PPT |
| `trpg-gm__read_document` | 读某个文档的全部文字（分段，PDF 尽力提取） |
| `trpg-gm__import_document` | 把剧本文件转成本地模组（切幕+分章节，写盘前需主人同意） |

工具返回值遵循核心契约：`{ content: '文本' }` 或 `{ content: '错误：…', isError: true }`。

### 认知隔离

`get_character` / `update_character` / `get_own_secret` / `show_status` **彻底忽略** `userId`
参数：永远只作用在当前发言者身上。模型如果指名别人的 QQ 号，`denyOtherActor()`
会直接返回 `isError: true`（提示改用 `get_party`）。`get_party` 走
`trpg.panel-party` / `trpg.character-public`，只给公开信息。

### 面板 / 地图能力的软降级

`show_status` / `show_party` / `get_party` / `show_map` / `move_to` 依赖
`plugins/trpg-tools` 新增的 `trpg.panel-status` / `trpg.panel-party` / `trpg.map-get` /
`trpg.map-move` / `trpg.character-public` 能力。用 `api.hasCapability()` 探测，
插件还没装好时统一回「面板功能还没装好（plugins/trpg-tools 没有提供对应的能力）。」

## 能力

`reply.inline-calls`：把模型回复里的 `[[roll 1d100<=60 侦查]]` 解析成一次真正的 `trpg-gm__roll_dice` 工具调用。核心在 `src/orchestrator.js` 的 `#capFirst('reply.inline-calls', …)` 处消费这个能力。

## GM 人设

`promptSections(context)` 是**动态**提示词：只有该群**已开启跑团模式**（`.gm on` 或 `gm_mode(true)`）时才注入「鲸小姐 GM」人设。

人设的核心是**AI 式长文叙事**：明确写死「跑团模式下**不受**群聊五到二十字、一句话一条消息的约束」，
每一轮输出一大段**总字数不低于 1500 字**（重要场景更长）的完整叙事，分 5~8 段，**每段不超过 350 字**，
段长要有方差，必须同时包含**场景描写 / 人物动作 / 语言交互 / 交互反馈**四层，并且**不要模仿人类 GM 的桌上口语**
（不要「那么」「请投个骰」「接下来我们……」）。

人设内置**文笔契约（防 AI 味）**，蒸馏自 novel-writing-skill 的硬性红线速查：
干打判据（动作句至少补两项、其中一项必须是换个说法）、主次判据（笔墨跟主次走，句句都修饰等于没有重音）、
单段最多 1 个比喻、环境句一句话最多两个感官通道、问号远多于感叹号、零频套语拉黑、
段落结尾不总结升华、对白标签写动作不写「愤怒地说」；若模组剧情涉及亲密环节，按 8.6 节
详尽不概述 / 慢节奏不跳步 / 表现力交给环境物件处理，该节优先级最高。

同时写死**认知隔离**：每个角色只知道自己的卡、自己亲历过的场景、别人当面说过的线索；
别人的私密背景与已知线索不推测、不叙述；群体场景只描写所有人肉眼可见的现象。
一回合收到多条群消息时，**只处理最后那位发言者的行动**。

人设还有**文档入团**段：群里发来的 PDF/Word/PPT 被 `plugins/file-inbox` 自动下载进文档收件箱后，
GM 可以 list_documents 查、read_document 读（分段）、import_document 转成本地模组
（与 plugins/trpg-tools 的 `trpg.doc-*` 能力联动）；主人提到「看文件/用这个本跑」时主动查看。

可用 `config.skills["trpg-gm"].personaEnabled = false` 关掉人设注入（工具与指令仍然可用），`promptPriority` 调整优先级（默认 45，上限 99）。

## 依赖

依赖 `plugins/trpg-tools` 提供的能力，但走的是**软依赖**（`api.capability`），没有写进 `requires`：插件不在时本技能照常加载，工具会回报"骰子插件未启用"，`promptSections` 不注入人设。
