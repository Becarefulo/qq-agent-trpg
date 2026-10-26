# QQ-agent 跑团扩展（TRPG for QQ-agent）

给 [QQ-agent](https://github.com/K0nd1us/QQ-agent) 加的一套跑团（TRPG）能力：**DnD 5e 人物卡、点指令、d20 检定、剧本库、文档入团**。

不是独立应用 —— 它是一组**可直接拷进 QQ-agent 仓库**的技能与插件。

---

## 放进去就能用

把这四个目录**原样拷到 QQ-agent 根目录**（覆盖同名目录前先备份）：

```
skills/trpg-gm/          →  <QQ-agent>/skills/trpg-gm/
plugins/trpg-tools/      →  <QQ-agent>/plugins/trpg-tools/
plugins/trpg-doc-bridge/ →  <QQ-agent>/plugins/trpg-doc-bridge/
_tools/pdf/              →  <QQ-agent>/_tools/pdf/
```

重启 QQ-agent，控制台「技能 / 插件」页签里应该出现：

- **技能**：TRPG 跑团 GM（trpg-gm）
- **插件**：跑团工具箱（trpg-tools）、跑团文档桥（trpg-doc-bridge）

> ⚠️ `plugins/trpg-tools` 已经**打过本地补丁**（感知属性、种族/职业/等级字段、里程碑升级、状态/休息、先攻、卡面与指令）。它原本是市场插件，**从市场更新会整目录覆盖，补丁全丢** —— 更新前先备份，更新后跑 `test/trpg-tools-fields-test.mjs` 检查。

---

## 群里怎么玩

发消息不用 @，指令由插件的 `before-incoming` 钩子直接接走（**零 token、不进模型**）。

### 开团

```
.gm on                 开跑团模式（模型开始以 GM 身份叙事）
.gm off                关
.mod                   看剧本库里有什么本
.mod load 蝗金岛        载入某个本
```

### 建卡

```
.pc roll                    随机车卡：4d6 取高 3 掷六属性，随机种族+背景+职业，技能熟练自动算好
.pc roll 名字 张三          随机车卡并起名
.pc 建卡 力量14 敏捷16 体质13 智力11 感知12 魅力9    手写属性
.pc 侦查45 图书馆50          加技能（技能值 = 属性调整值 + 熟练加值）
.pc 名字 张三               改名字
.pc 种族 矮人 / .pc 职业 战士 / .pc 出身 士兵          改出身
```

### 查卡

```
.pc               看自己的人物卡（属性 / 技能 / HP 当前/上限 / 状态 / 等级）
.pc 技能           列出全部技能
.pc 队伍           队伍卡册
```

### 金币 / 商店 / 地图

`.pc 金币`（看） `.pc 金币 +120`（加） `.pc 金币 -30`（花）
`.pc 商店`（价目表） `.pc 买 治疗药水`（下单）
`.pc 地图`（看位置与出口） `.pc 去 酒馆`（移动，只能走出口）

商店可用 `data/trpg-tools/shop.json` 覆盖内置价目表，`kind` 支持 `item` / `heal` / `cure`。

### 初始装备

定职业时**自动发一套 PHB 起步装备**（物品 + 金币，主武器自动装上），每个角色只发一次：

| 职业 | 初始装备 | 金币 |
|---|---|---|
| 战士 / 圣武士 | 长剑、盾牌、皮甲 | 20 |
| 野蛮人 | 大剑、皮甲 | 10 |
| 游侠 | 短弓、短剑、皮甲 | 20 |
| 盗贼 | 匕首、短剑、盗贼工具、皮甲 | 25 |
| 牧师 | 战锤、盾牌、皮甲 | 15 |
| 德鲁伊 | 木棒、皮甲 | 10 |
| 吟游诗人 | 短剑、皮甲 | 15 |
| 武僧 | 短剑 | 5 |
| 邪术师 | 短剑、皮甲 | 15 |
| 术士 | 匕首、皮甲 | 15 |
| 法师 | 法术书、匕首 | 15 |

`.pc 初始装备` 可手动补发（已发过的不重复）。

### 武器 · 开箱

`.pc 买 长剑` → `.pc 装备 长剑` → `.攻击 哥布林`（不写武器就用装备的那把）
`.pc 卸下` 收起武器；`.pc 开箱` 开宝箱（.战 结束 打死敌人掉 1 个）

武器必须真的在背包里，没买过不能拿；支持 `长剑+1` 这类魔法武器（命中与伤害 +1）。

### 战斗

`.战`（看战况） `.战 开`（开战，自动掷先攻排序） `.战 加 哥布林 hp12 ac13 init15`（加敌人）
`.攻击 哥布林 长剑`（玩家攻击，自动算命中与伤害）
`.战 打 张三 8`（怪物打玩家，直接扣血）
`.战 下一回合` / `.战 结束`

命中 = 1d20 + 力量调整值 + 熟练加值 vs 目标 AC；伤害 = 武器骰 + 力量调整值，天然 20 双倍。

### 跑团中

```
.pc 状态 中毒       加状态（中毒 / 倒地 / 恐惧 / 束缚 / 目盲 / 力竭）
.pc 状态 -中毒      去掉
.pc 状态            看当前状态
.pc 受伤 8          扣血（归零自动挂「倒地」）
.pc 治疗 8          回血
.pc 短休 / .pc 长休  休息回血 / 回满
.pc 法术位 2/4      设法术位；.pc 法术位 -1 消耗
.pc 先攻            全队投先攻（1d20 + 敏捷调整值）排序
.pc 下一个          轮到谁
.pc 升级            里程碑升一级（HP 上限一起涨）
.pc 物品 / .pc 拿 火把 / .pc 丢 火把    背包
.pc 清卡 [确认]     整张删掉（需二次确认）
```

中文句号 `。pc` 同样识别。

### 模型侧（GM 工具）

27 个工具，主要是：`roll_d20`（d20+修正 vs DC，支持优势/劣势，中毒等状态**自动劣势**）、`apply_damage`、`take_rest`、`level_up`（可全队）、`set_condition`、`get_character` / `update_character`（只能读写自己 —— 认知隔离）、`show_cardbook`、`read_module`、`find_module`、`list_documents` / `read_document` / `import_document`、`record_event` / `check_knowledge`。

---

## 数据放在哪

全部由 `plugins/trpg-tools` 持有，存在 `<QQ-agent>/data/` 下：

| 数据 | 位置 |
|---|---|
| 人物卡 / 剧情进度 / 先攻 / 状态 | `data/trpg-tools/state.json` |
| 剧本库 | `data/trpg-tools/modules/<id>/{module.json, act-N.md}` |
| 文档收件箱 | `data/documents/`（需要装 `file-inbox` 插件才会自动落盘） |
| 手册模板 | `data/trpg-tools/剧本模板.md`（首次启动生成） |

**人物卡按会话隔离**：同一个 QQ 在不同群是不同角色，私聊又是一张。

---

## 规则实现范围

| 支持 | 说明 |
|---|---|
| 属性 | 4d6 取高 3，或手填 |
| 种族 | PHB 九个，含属性加值与种族技能（精灵察觉 / 半兽人威吓 / 半精灵任选 2） |
| 背景 | PHB 十三个，各给 2 项固定技能 |
| 职业 | 十二个，起始技能熟练按 5e 数据随机挑（战士 2、盗贼 4、吟游诗人任意 3…） |
| 技能值 | 属性调整值 + 熟练加值（1 级 +2，每 4 级 +1） |
| 检定 | 1d20 + 修正 vs DC，优势/劣势，天然 20/1 |
| 状态 | 中毒 / 恐惧 / 力竭 / 目盲 / 束缚 → 自动劣势；倒地由 HP 归零自动挂 |
| 休息 | 短休回一个生命骰（平均），长休回满 |
| 升级 | 里程碑制（不记经验），HP 上限同步涨 |
| 金币 / 商店 | 卡上金币，内置 12 件 PHB 装备，可自定义 shop.json |
| 地图 | 每群一份地点表，只能沿出口移动 |
| 战斗 | 先攻排序、攻击命中/伤害/暴击、怪物打玩家，状态与 HP 同步 |

**没实现**：法术表、专长、装备加值、怪物图鉴、联网搜本。

数据来源：[5e.kiwee.top](https://5e.kiwee.top)（5etools 中文版）的 `classes` / `backgrounds` / `races` JSON。

---

## 测试

`test/` 下 7 个套件，共 100+ 项断言：

```
trpg-cards-test.mjs        卡面与指令（47 项）
trpg-command-e2e-test.mjs  点指令端到端，真实启应用（13 项）
trpg-d20-check-test.mjs    检定 / 优势劣势 / 状态 / 休息（10 项）
trpg-gm-tools-test.mjs     人物卡写入（8 项）
trpg-gm-roll-test.mjs      掷骰工具（4 项）
trpg-tools-fields-test.mjs trpg-tools 补丁回归（10 项）
trpg-doc-bridge-test.mjs   文档桥（20 项）
```

> 这些测试 import 了宿主的 `src/` 和 `test/_harness.mjs`，**必须在完整的 QQ-agent 仓库里跑**（拷进去之后），单独 clone 这个仓库跑不了。

---

## 来源与许可

本项目基于 [Kondius/QQ-agent](https://github.com/K0nd1us/QQ-agent) 开发，遵循其 **MIT License**（见 `LICENSE`，版权归原作者）。

本仓库内的跑团扩展部分（`skills/trpg-gm`、`plugins/trpg-tools` 的本地补丁、`plugins/trpg-doc-bridge`、`_tools/pdf`）为衍生修改。

MIT 要求保留版权声明，请勿删除 `LICENSE`。
