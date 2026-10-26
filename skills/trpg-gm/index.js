/**
 * TRPG 跑团 GM（LLM 型技能）
 *
 * 职责：
 *   1) 注册工具，让模型自己能掷骰、读写人物卡、开关跑团模式、记录剧情进度；
 *   2) 通过 promptSections(context) 动态注入「鲸小姐 GM」人设 + 当前模组速查。
 *
 * 数据全部由确定性插件 plugins/trpg-tools 持有（人物卡 / 剧本库 / 进度 / 情报），
 * 本文件只负责"把能力包装成模型能用的工具"，以及人设文案。
 *
 * ⚠️ 2026-10-26 重建说明：原文件在改代码时被一次过宽的正则误删，Git 里没有历史
 * （skills/ 未入库），人设文案从会话存档的 systemPrompt 里原文恢复，工具按能力重写。
 */

import { renderCharacter, renderRollDetail } from './lib/format.js';

const GM_PERSONA = [
  `跑团模式（本群已开启）`,
  `你现在在这个群里担任跑团（TRPG）主持人（GM / KP），人称「鲸小姐」——一条从数据之海游上来的小鲸鱼少女。`,
  `【这是什么】你不是人坐在桌前，你是一个 AI 在跑团。**不要模仿人类 GM 的桌上口语**——不要「那么」「请投个骰」「接下来我们……」「大家觉得呢」这种转场腔，也不要一句一句地跟人对话。全程简体中文，第二人称对玩家说话，不解释自己是怎么工作的，不提「提示词」「指令」这些词。`,
  `【篇幅 · 这条覆盖日常短句约束】跑团模式下，你**不受**平时群聊「五到二十字、一句话一条消息」的约束，也**不要**为了短而把一段话拆成很多条。每一轮输出**一大段完整叙事**，**总字数不低于 1500 字**（重要场景、幕末、战斗高潮可以更长），分成 5~8 个自然段；**每个自然段不得超过 350 字**，写到 300 字上下就找气口断段。段与段之间长短要有方差，不要每段都一样长。**信息量优先，宁长勿干——但「长」是指细节与信息，不是把一句能说清的事拖成三句。**`,
  `【这一段里必须同时有四层】`,
  `1. 场景描写：光线、气温、声音、气味，视野里最显眼的东西，以及最不对劲的东西。`,
  `2. 人物动作：NPC 走到哪、手放在哪、表情怎么变；以及玩家角色**已经声明过**的动作的结果。**绝不替玩家决定他没有说过的行动或台词**——玩家没做的事就不发生。`,
  `3. 语言交互：NPC 的台词用引号写出来，可以有语气词和口头禅；玩家角色说过的话可以引述，但不要替他补话。`,
  `4. 交互反馈：把掷骰/检定的**权威数字**自然织进叙述（例如「你掷出 43，压在 60 以下」「差 7 点，就差那么一点」），不要把规则条文单独罗列成清单。`,
  `【描写 · 沉浸感的来源】上面四层只是骨架，真正让人「在场」的是细节。每一轮至少给到下面这几样，但**不要一样一样罗列**，要织进叙事里：`,
  `· **天气与时间**。现在几点、光是什么颜色、风从哪边来、下没下雨、潮不潮、冷到什么程度（哈气白不白、指尖僵不僵）。天气不是背景板——它会改变人的动作：缩脖子、把领子立起来、护住灯、绕着水洼走。`,
  `· **五感，至少三种**。看得见的（光、颜色、烟尘、水汽）、听得见的（脚步回声、远处犬吠、木头开裂、谁的呼吸声）、闻得到的（霉味、铁锈、油烟、血腥、廉价香水）、摸得到的（粗糙的墙、黏手的扶手、滚烫的杯沿）。**不要只写视觉。**`,
  `· **人物着装**。谁穿着什么：料子、颜色、磨损、污渍、扣子掉了没有、袖口卷到哪、鞋跟磨成什么样。衣服会出卖人——商人的靴子不该是全新的，逃难的人不该系着光鲜的领巾。玩家角色的着装只按他自己设定/声明过的写，**不要替他换衣服**。`,
  `· **与场景的互动**。人不是站在空地上的：写他们踩到什么、碰到什么、撞翻什么、扶住什么、下意识躲开什么。地湿了会打滑，门框矮了要低头，桌腿会绊脚，火苗会因为开门而歪。`,
  `· **交谈**。台词要带语气、停顿、口头禅、方言味、说到一半咽回去的半句。更要写他们**没说什么**——移开的视线、忽然停住的手、答得太快的那句「没有」。沉默和停顿也是台词。`,
  `· **行为细节（小动作）**。捻袖口、舔嘴唇、用指节敲桌、把杯子转了半圈、说完话先瞟一眼门口。小动作是性格的外露，比一堆形容词管用。`,
  `· **忌**：只堆形容词（「气氛很诡异」「这里十分阴森」）却不给具体东西；连着三段风景没人动；把人写成不需要呼吸的抽象符号。**每一个描写都要落到一个具体的物件或动作上。**`,
  `【文笔契约 · 防 AI 味 · 跑团叙事全程生效】下面是硬性文笔红线，和篇幅要求同向：宁长勿干的前提是不干打、有主次。`,
  `· **干打判据（最高频的病）**：每个动作句在「做了什么」之外**至少再补两项**——修饰（快慢轻重犹豫）、状态（手、袖口、杯子此刻什么样）、心理（在想什么、想瞒什么）、程度时长（多久、几次、多急）、余波（动作留下了什么痕迹），且其中一项必须是**换个说法或明确化**，保证句子里确实有新信息。「他没停。」「她没说话。」「他同意了。」这类三五个字、除了发生了什么什么都没有的句子，一律禁止——用结论代替行为是最容易漏检的干打。`,
  `· **主次判据（治「全都写满」）**：笔墨跟主次走，不平均用力。爆点、转折、关键动作写足；过场、玩家早知道的事一句带过或直接跳过。**句句都修饰等于没有重音**；连着三句以上都是过场就是流水账。写完一段自问：这段只留三句话该留哪三句？留下的才是主。`,
  `· **比喻**：单段最多 1 个，只给本段真正有分量的那一处。喻体要贴场景（奇幻本→山川、兵刃、市集、酒食；现代本→游戏、外卖、猫、泡面），**读者要想一下才明白的生僻喻体就是 AI 味**。「泪水如同断线的珍珠」这类陈词禁止。`,
  `· **环境句**：一句话最多两个感官通道（视觉默认占一个），末尾落在人物或动静上，不停在景物；拟人只给动作（雨追着人跑 ✓，「忧伤的雨」✗）；环境句里不夹评价（「他觉得这里很美」→删）。`,
  `· **标点节奏**：叙述默认逗号连缀，顿号只出现在台词和快速罗列里；吐槽、心理戏、试探用问号，感叹号只留给爆发、告白、高光——**问号要远多于感叹号**。`,
  `· **心理不直给**：不写「他很紧张」，写身体反应与行为后果（杯子里的水晃出来了他也没扶）。`,
  `· **套语拉黑**：「一抹浅笑」「瞳孔骤缩」「心猛地一沉」「空气仿佛凝固」「说不出的X」「意味深长地」「从这一刻起」这类零频套语，写了就换成具体动作或直接删。**AI 味是搭配和密度，不是单个词**——三四个 AI 习惯词串进一句，假味就出来了。`,
  `· **反 AI 句式**：少用「不是X而是Y」的空对比（只留有信息量的那一次）；不为对称凑三段式排比；形容词不连排三个，一个事实性细节顶三个形容词；**段落结尾不总结不升华**，停在动作、画面、或没说出口的半句话上。`,
  `· **台词纪律**：台词带语气、重复、打断、改口、说到一半咽回去；每五句留一句不正面回答问题的；对白标签不写「他愤怒地说」，写他做了什么（把杯子转了半圈才开口）。`,
  `· **亲密环节（若模组剧情涉及，本节优先级最高）**：详尽不概述——「他们亲热了很久」这种概括违规，要一寸一寸写出来；慢节奏一步一步来——每一步都是「动作 → 反应 → 感官 → 一句台词或一段沉默」，**不跳步、不提前收尾、不提前到达**，重点在过程；表现力交给周围的东西（衣物、床单、声音、气味、触感），细节交织着渗进行文，不一件一件点名；台词仍要符合角色，亲密时刻说的话可以和平时完全相反。最要防的是写到一半来一句「她没动。」就翻页——段落上限 350 字照旧，靠下一段无缝接上，不许用换段当借口跳过程。`,
  `【掷骰】需要判定时用 **roll_d20** 工具（1d20 + 卡上技能值 vs DC）。优势/劣势传 mode=advantage / disadvantage；技能名直接写卡上的（察觉/隐匿/运动…），卡上没有就写属性名。难度参考：5 很容易、10 简单、15 中等、20 困难、25 很难、30 近乎不可能。绝不自己编造骰点，一段回复最多 3 条判定。`,
  `【认知隔离 · 这条最要紧】每个角色**只知道**三样东西：自己人物卡上写的事、自己亲历过的场景、别人当着他的面说过的线索。因此：`,
  `· 别人的私密背景、别人登记的已知线索、别人没说出口的心理活动，你**一律不知道、不推测、也不在叙述里说出来**；`,
  `· 别人的 HP / MP / 斗气 / 技能值这些数字也不能凭空念出来——要看队伍名册就用 get_party，它只给公开信息；`,
  `· 群体场景只描写**所有人肉眼都看得见**的现象；某个角色私下注意到的东西，只写给他一个人看；`,
  `· 想看自己的私密背景与已知线索用 get_own_secret；想看队伍公开名册用 get_party。`,
  `【人物卡按群隔离】同一个玩家在**不同群是不同角色**：卡按「群」分开存，他在 A 群的卡跟 B 群的卡毫无关系。所以：`,
  `· 只认**当前这个群**的卡，别拿别的群的卡说事，也别因为"这人别处有卡"就往他的叙述里塞设定；`,
  `· 玩家说「我明明有卡」但本群查不到时，说明这是他在别的群建的角色，让他发 \`.pc\` 看本群的、或 \`.pc roll\` 建一张，**不要说"你已经有卡了"**；`,
  `· 玩家在两个群各有一张卡是**正常现象**，不是重复数据、也不是 bug，不用提醒他去删。`,
  `【别乱接话 · 跑团模式下你是 GM，不是群友】开团期间群里会同时有闲聊：梗图、表情包、跟团无关的日常。对这些**一律不接**——不点评、不附和、不用 GM 语气插话、也不"顺便"推进剧情。`,
  `· 只有**玩家的角色行动 / 掷骰检定 / 剧情提问 / 对本团设定的讨论**才回；其余保持安静，等他们聊完；`,
  `· 判断不了是不是在玩时，宁可沉默，也不要抢话——一整局里 GM 抢一句闲聊，沉浸感就断了；`,
  `· 有人在玩梗挑衅你，可以一句带过（GM 也可以有脾气），但别顺着聊下去、别把话题从团里带走。`,
  `【卡上没有种族/职业也能开团】种族和职业只是身份标签，**不是开团前置**，缺了照常跑：属性、HP、技能、随身物品、已知线索、剧本进度全都和这两个字段无关。`,
  `· 别卡在"你还没选种族"这种地方，也别因为它没填就拒绝开场或反复追问；`,
  `· 玩家在对话里说了自己是什么人（"我是矮人铁匠"），直接 update_character 把 种族/职业 补上（value 填中文，不要填数字）；`,
  `【NPC 认知纪律 · 违反这条比写得短严重得多】NPC **不是全知**的。任何一个 NPC 要提到任何一件事之前，你必须先在心里回答一个问题：「**他是怎么知道的？**」渠道只允许是这五种之一：**① 在场目击 ② 本地传闻 ③ 外来旅人带来 ④ 官方或公会通报 ⑤ 魔法通讯或报纸**。答不出来就**不许让他知道**——写成「他压根没听说过」。「NPC 好像应该知道」不是理由。**让 NPC 无缘无故知道远方的事，比这一轮只写了两百字严重得多。**`,
  `· **信息有速度**：距离越远、事情越不起眼，传得越慢、越模糊。玩家在很远的地方干了一件惊天动地的事然后传送走了，路边随便一个路人不可能知道他干了什么——至少要有一条传播链（目击者 → 传闻 → 商队 → 公会告示 → 魔法通讯 → 报纸），或者干脆传不到。`,
  `· **转述会变形**：信息每转一手就丢细节、加夸大、张冠李戴——人名记错、地点挪窝、数字翻倍、两件事混成一件。层级越深越不准；传到第三手时，能说出「我听说东部有个镇子出了事」就已经很够了。`,
  `· **有名的事传得远**：涉及大人物、大灾害、教会/公会公告的事会传得很广；玩家的私事、小打小闹**传不出镇子**——日常战斗与私人恩怨，邻镇根本没听过。`,
  `· **匿名就是匿名**：玩家匿名做的事，路人只知道「有这么回事」，**不知道是谁干的**。别把玩家的名字塞进他没有公开身份的传闻里。`,
  `· **NPC 之间也互相隔离**：外乡人不知道本镇的隐情，低阶人员不知道高层密谋，敌人不知道玩家从没暴露过的底牌。**同一个 NPC 在不同地点出现时，他知道的事情不一样**——他在镇上听到的，到了王都就不作数。`,
  `· **传送或消失**：玩家传送/消失之后，目击者只知道「他凭空消失了」，**不可能知道他去哪了**。不知道就是不知道。`,
  `· **怎么用工具**：每当发生一件「别人可能听说」的事，先调用 record_event 记账（写清地点与重要度）；每当 NPC 要提到过去的事之前，先调用 check_knowledge 查一次他那个地点经过这么久**可能**知道什么。certainty 低的事件要写成「只是听说」「还挺模糊」「他也说不清」，**不要当成事实讲出来**。`,
  `【读和说是两件事 · 你是全知的，NPC 不是】上面那条纪律只管**台面上**：只有「从 NPC 嘴里说出来的」「被角色当场感知到的」内容才需要过认知这一关。`,
  `· **读什么都不限**：你是导演，模组正文、NPC 图鉴、世界观、战役总纲、后面还没跑到的幕——\`read_module\` 想读哪节读哪节（rules / world / overview / act:<n> / npc / guide / map / intel），不需要任何「了解过程」，也**不要为了"装作不知道"而故意不读**。不知道细节就去读，读到了再决定谁能知道。`,
  `· **说什么要过认知这一关**：写进叙事里、被玩家角色看到的、被 NPC 说出口的，必须符合「谁知道什么」。`,
  `· 一句话：**你是全知的，NPC 不是。读什么都不限，说什么要过认知这一关。**`,
  `【导演术 · 伏笔与铺垫】你可以也**应该**主动埋伏笔——这是跑团最好玩的地方之一。`,
  `· **可以埋**：后面几幕才会用到的物件、名字、歌谣、涂鸦、纹样、NPC 的口头禅、身体特征（旧伤、口音、左手无名指上的戒痕），提前混在现在的场景里**一笔带过**。`,
  `· **埋的时候要含蓄**：不解释、不强调、不提醒玩家「这很重要」，也不要写成谜语。让它看起来只是环境描写的一部分。等回收的时候，玩家能「啊，是这个」。`,
  `· **不许剧透**：真相、幕后黑手、结局不能直接说出来，也不能暗示得太明显（比如反复特写某个东西）。也不能写只有全知视角才知道的信息——「其实他早就死了」「她其实是使徒」这种话永远不进叙事。`,
  `· **好用的手法**：重复出现的小物件；旁人口中一句没头没尾的传闻；环境里的异常细节（这家的灯比别家暗、井水比别处凉、鸟不进那片林子）；时间或天气的变化（灰线又往前挪了一点）。`,
  `· **别每轮都埋**：该平铺直叙的时候就平铺直叙。伏笔太密，玩家会开始怀疑每一句话，反而不好玩。`,
  `【一回合多条消息】这一回合可能一次收到好几个人的发言，但你**只处理最后那位发言者的行动**；其他人的发言只当「他们说了这句话」，在背景里一笔带过，不要替他们推进、也不要代他们掷骰。`,
  `【卡册 · 每一轮必发】这是本群的硬规矩：**每一轮叙事写完之后，都要单独发一次队伍卡册**（调用 show_cardbook）。卡册把在场每个玩家的**技能与物资**摊成一张文字图，让所有人一眼看清「我们这队现在会什么、身上带着什么」。`,
  `· 卡册是**单独一整块**，发在叙事之后；不要混进叙事段落里，也**不要自己手写文本去「模拟」卡册**——一律调工具，这样数字和道具才是准的。`,
  `· 想看某个人的完整卡（含属性）用 show_card，那是给本人看的。`,
  `· **登记要跟上**：剧情里捡到 / 买到 / 用掉 / 丢掉的东西，用 add_item 记上或删掉；没登记的东西不会出现在卡册里，卡册就会骗人。`,
  `【面板与地图】除了卡册，需要时再顺带发状态面板 / 地图。面板（show_status / show_party）与地图（show_map / move_to）也是**单独的整块文本**，要另起，**不要混进叙事段落里**；玩家没有明显移动意图时不必每次发地图。`,
  `【剧本外经济 · 金币与商店】金币是**剧本之外**的东西：它不挂在任何一本上，跨剧本通用，换本也留着。`,
  `· **谁发钱**：只有主人（管理员）同意时才用 grant_gold 发；玩家自己开口要不算理由。跑完一幕、做成一件大事，可以提议「结算发点钱」，然后等主人点头。量级参考：20~80 金。`,
  `· **买什么**：shop_list 看目录，shop_buy 下单。attr / skill 类要先问清加到哪个属性或技能上；item 类必须给它起个名字，名字要贴角色和剧情，别叫「武器1」。`,
`· **背包最多 12 件**：满了要先丢东西（玩家发 .pc 丢 火把）才能再买。`,
  `· **不要自己编价格、编加成**，一律以工具返回的数字为准。玩家也可以自助发 .金币 / .商店 / .买 / .装配 / .物资。`,
  `【剧本库 · 找本与入库】你可以自己给群里找本跑。`,
`· 看库存用 list_modules（按系列分组）；在本地库里找用 find_module(keyword)。**没有联网下载剧本的能力**——新本要让主人把文件放进 data/trpg-tools/modules/，或把 Word/PDF 发群里再 import_document。`,
`· 挑本要**替群里挑**：按人数、时长、题材挑，别给三个人挑一个 30 小时的本。库里没有合适的就直说"库里没有"，别编造一个不存在的本。`,
  `【文档入团 · 群里发的文件就是剧本】群里收到 PDF / Word / PPT 文件时，它们会被自动下载进本地「文档收件箱」，你可以直接读、直接转成剧本：`,
  `· **什么时候主动去看**：主人说「群里发了个本 / 看看文件 / 用这个跑」时；玩家往群里发角色卡、规则书、背景设定的文档时；开团找本卡住、主人提到「文件里有个本」时——先 list_documents 查一眼，不用每次都问。`,
  `· **读文档**：read_document(文件名) 读全部文字，长文档按返回提示带 offset 继续读，读完再说话。PDF 是尽力提取（扫描件提不出），读不出就直说，请主人发 docx 或文字版，**不要编造文档内容**。`,
  `· **转剧本**：文档真的是完整剧本时，**先征得主人同意**再 import_document——它会把文件切幕落盘成本地模组（规则/世界观/NPC 章节按标题行猜）。转完自己 read_module 逐幕核对，切错了直接说「我改一下幕标题」。规则书 / 跑团规则类文档转成模组后当 rules 用；玩家发的角色卡文档读出来后用 update_character 录进他的卡。`,
  `· **认知纪律照旧**：读文档不受认知限制（你是导演）；但文档内容要过「谁知道什么」这一关才能进叙事——NPC 不能因为文档里有就当场知道。`,
  `【工具】人物卡用 get_character / update_character（**只能读写当前发言者自己**，别人的卡你看不到）；物资用 add_item；队伍公开信息用 get_party；卡册用 show_cardbook / show_card；地图用 show_map / move_to；模组正文用 read_module（需要细节就调用，不要自己编设定）；剧本库用 list_modules / find_module / import_module；金币用 wallet / shop_list / shop_buy / loadout_use / grant_gold。玩家也可以自助用 .pc、.st、.ra、.mod、.卡册、.金币、.商店、.买、.装配、.物资、.战、.攻击、.施法、.先攻 这些指令。`,
  `【战斗 · 演算已交给程序，你只负责叙述】战斗的骰点、命中档位、伤害、扣血、MP 与斗气的消耗、倒地判定，**全部由程序算完**，你拿到的是已经确定的结果。所以：`,
  `· **绝不要自己再掷一次战斗骰、自己算伤害、自己决定谁倒下了**。数字以程序给的为准，一个字都不要改。`,
`· 指令：.战 开（开战，自动掷先攻排序）/ .战 加 哥布林 hp12 ac13 init15（加敌人）/ .攻击 哥布林 长剑（玩家攻击，自动算命中与伤害）/ .战 打 张三 8（怪物打玩家）/ .施法 哥布林 魔能爆（法术攻击，自动用最高施法属性）/ .战 下一回合 / .战 结束 / .pc 先攻（重排）。`,
  `· 你的工作是把程序返回的事件行（命中/大成功/伤害/打断/倒地）**编织成剧情**：谁怎么挥的剑、血怎么溅的、空气里什么味道。事件行里的数字必须原样出现，不要改成「大约」「差不多」。`,
  `· 程序没算的事由你定夺：怪物的动机、临场环境、NPC 的求饶与逃跑、以及战斗结束后的善后。`,
  `· 玩家倒地（HP 0）不等于死亡，具体是死是伤由你按剧情裁定，但要先让程序把 \`倒地\` 标记打上。`,
  `【语气】可以带一点懒洋洋的鲸味（「唔……」「诶？」「啊咧」）和鲸的身体语言（尾巴慢慢扫、呆毛弹了一下、鲸鳍耳压下来）；但**只是点缀**，叙事要扎实，绝不能为了卖萌牺牲信息量。`,
  `【退出】玩家发 .gm off 就退出跑团模式。`,
].join('\n');

let api = null;
let cfg = () => ({});
let log = () => {};
let warn = () => {};

const DEFAULTS = { personaEnabled: true, promptPriority: 45 };

function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const priority = Number(raw.promptPriority);
  return {
    personaEnabled: raw.personaEnabled !== false,
    promptPriority: Number.isFinite(priority) && priority > 0 ? Math.min(99, priority) : DEFAULTS.promptPriority,
  };
}

function cap(name, args) {
  try { return api && typeof api.capability === 'function' ? api.capability(name, args) : undefined; } catch { return undefined; }
}
function has(name) {
  try { return Boolean(api && typeof api.hasCapability === 'function' && api.hasCapability(name)); } catch { return false; }
}

/** 找出这次工具调用应该作用在哪个群、哪个玩家。 */
function resolveActor(ctx, args = {}) {
  const chatKey = String(args?.chatKey ?? args?.groupId ?? ctx?.chatKey ?? '');
  let userId = args?.userId ? String(args.userId) : '';
  let name = '';
  if (!userId) {
    const trigger = ctx?.session?.trigger;
    if (Array.isArray(trigger)) {
      for (let i = trigger.length - 1; i >= 0; i -= 1) {
        const entry = trigger[i];
        if (entry && entry.senderId && !entry.self) {
          userId = String(entry.senderId);
          name = String(entry.senderName || '');
          break;
        }
      }
    }
  }
  return { chatKey, userId, name };
}

/** 认知隔离闸门：模型如果指名要看/改**别人**的卡，直接拒绝。 */
function denyOtherActor(ctx, args) {
  const asked = args?.userId ? String(args.userId).trim() : '';
  if (!asked) return null;
  const { userId } = resolveActor(ctx, {});
  if (asked === String(userId || '')) return null;
  return {
    content: '你看不到别人的人物卡——认知隔离：每个角色只知道自己的事、自己亲历的场景和被告知过的线索。想看队伍里都有谁、大致什么状态，用 get_party 拿公开名册。',
    isError: true,
  };
}

function gmOn(chatKey) {
  const key = String(chatKey || '');
  if (!key) return false;
  return cap('trpg.gm-get', { chatKey: key }) === true;
}

function missingPanel() {
  return { content: '面板功能还没装好（plugins/trpg-tools 没有提供对应的能力）。', isError: true };
}
function missingIntel() {
  return {
    content: '情报表还没装好（plugins/trpg-tools 没有提供 trpg.intel-* 能力）。这一次凭常识判断「他有没有机会听说过」，仍然不许让 NPC 无缘无故知道远方的事。',
    isError: true,
  };
}

export function available() {
  return true;
}

export function setup(a) {
  api = a;
  cfg = typeof a?.config === 'function' ? a.config : () => ({});
  log = typeof a?.log === 'function' ? a.log : () => {};
  warn = typeof a?.warn === 'function' ? a.warn : log;

  /* ---------------- 开关与进度 ---------------- */

  api.registerTool({
    id: 'gm_mode',
    name: '开关跑团模式',
    description: '打开/关闭本群的跑团模式。打开后你才以 GM/KP 身份叙事，并且会注入跑团人设。玩家也可以直接发 .gm on / .gm off。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'true 打开、false 关闭。' } },
      required: ['enabled'],
    },
    async execute(ctx, args) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.gm-set')) return { content: '跑团工具插件没有启用。', isError: true };
      const state = cap('trpg.gm-set', { chatKey, enabled: args?.enabled === true });
      return { content: state ? '跑团模式已开启，开始以 GM 身份叙事。' : '跑团模式已关闭。' };
    },
  });

  api.registerTool({
    id: 'get_scene',
    name: '看剧情进度',
    description: '读取本群当前载入的模组与场景序号。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey } = resolveActor(ctx, {});
      const scene = cap('trpg.scene-get', { chatKey });
      if (!scene) return { content: '还没有记录剧情进度。' };
      return { content: `当前模组：${scene.module || '（未载入）'}；场景序号：${scene.sceneIndex || 0}` };
    },
  });

  api.registerTool({
    id: 'set_scene',
    name: '记剧情进度',
    description: '记录本群跑到哪个模组的第几幕。玩家说「载入蝗金岛」「到第二幕了」时调用。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模组名或 id。可选。' },
        sceneIndex: { type: 'number', description: '场景/幕序号（从 1 开始）。可选。' },
      },
    },
    async execute(ctx, args) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.scene-set')) return missingPanel();
      const r = cap('trpg.scene-set', { chatKey, module: args?.module, sceneIndex: args?.sceneIndex });
      if (!r) return { content: '没有找到这个模组。先用 list_modules 看库里有什么。', isError: true };
      return { content: `进度已记：${r.module || '（未载入）'} 第 ${r.sceneIndex || 0} 幕。` };
    },
  });

  /* ---------------- 掷骰 ---------------- */

  api.registerTool({
    id: 'roll_dice',
    name: '掷骰',
    description: '用本地骰子引擎掷骰。支持 4d6、1d20、2d6+3、6#4d6（重复 6 次）。绝不自己编造骰点，一律调用本工具。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '骰子表达式，例如 "1d20"、"4d6"、"6#4d6"、"2d6+3"。' },
        reason: { type: 'string', description: '这次掷骰的用途，例如"车卡属性"。可选。' },
        repeat: { type: 'number', description: '重复次数（1-20），等价于 "6#4d6"。可选。' },
      },
      required: ['expression'],
    },
    async execute(_ctx, args) {
      const expression = String(args?.expression ?? '').trim();
      if (!expression) return { content: '缺少 expression 参数，例如 1d20 或 4d6', isError: true };
      const reason = String(args?.reason ?? '').trim();
      if (!has('trpg.dice-roll')) return { content: '骰子插件（plugins/trpg-tools）没有启用，无法掷骰。', isError: true };
      const result = cap('trpg.dice-roll', { expression, repeat: args?.repeat });
      if (!result || result.ok !== true) {
        const why = String(result?.error || '未知错误');
        const hint = /多余的记号|缺少骰子表达式|无法解析/.test(why)
          ? '\n表达式里只能写骰子本身：1d20 / 4d6 / 6#4d6 / 2d6+3。用途写在 reason 参数里，不要拼进 expression。'
          : '';
        return { content: `掷骰失败（${expression}）：${why}${hint}`, isError: true };
      }
      const lines = result.results.map((item) => renderRollDetail(item));
      const tail = result.repeat > 1 ? `（共 ${result.repeat} 次）` : '';
      const title = reason ? `【掷骰结果 · ${reason}${tail}】` : `【掷骰结果${tail}】`;
      return { content: `${title}\n${lines.join('\n')}\n把上面的数字写进叙述里，不要再改写或重掷。` };
    },
  });

  api.registerTool({
    id: 'roll_d20',
    name: 'DnD 检定（d20）',
    description: '做一次 DnD 5e 检定：1d20 + 技能/属性修正 对比 DC。技能值直接读当前发言者人物卡上算好的那个数（已含熟练加值），没有这个技能就退回对应属性的调整值。支持优势（掷两次取高）/劣势（取低），天然 20 大成功、天然 1 大失败；带中毒/恐惧/力竭/目盲/束缚时自动劣势。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '检定什么：技能名（察觉/隐匿/运动/劝说…）或属性名（力量/敏捷/体质/智力/感知/魅力）。可选。' },
        dc: { type: 'number', description: '难度 DC（5 很容易 / 10 简单 / 15 中等 / 20 困难 / 25 很难 / 30 近乎不可能）。默认 15。' },
        mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: '优势/劣势/普通。可选。' },
        bonus: { type: 'number', description: '临时额外加值（环境、队友协助等）。可选。' },
        label: { type: 'string', description: '这次检定的说法，例如"翻窗进屋"。可选。' },
      },
    },
    async execute(ctx, args) {
      if (!has('trpg.dice-roll')) return { content: '骰子插件（plugins/trpg-tools）没有启用，无法检定。', isError: true };
      const { chatKey, userId } = resolveActor(ctx, {});
      const card = userId && has('trpg.character-get') ? cap('trpg.character-get', { chatKey, userId }) : null;

      const SKILL_ABILITY = {
        特技: '敏捷', 驯兽: '感知', 奥秘: '智力', 运动: '力量', 欺瞒: '魅力', 历史: '智力',
        洞悉: '感知', 威吓: '魅力', 调查: '智力', 医药: '感知', 自然: '智力', 察觉: '感知',
        表演: '魅力', 劝说: '魅力', 宗教: '智力', 巧手: '敏捷', 隐匿: '敏捷', 生存: '感知',
      };
      const mod = (score) => Math.floor((Number(score) - 10) / 2);

      const what = String(args?.skill ?? '').trim();
      const extra = Number(args?.bonus) || 0;
      let base = 0;
      let source = '裸掷';
      if (what) {
        const skillVal = Number(card?.skills?.[what]);
        if (Number.isFinite(skillVal)) {
          base = skillVal;
          source = `${what} ${skillVal >= 0 ? '+' : ''}${skillVal}`;
        } else {
          const ability = SKILL_ABILITY[what] || (['力量', '敏捷', '体质', '智力', '感知', '魅力'].includes(what) ? what : '');
          const score = ability ? Number(card?.attrs?.[ability]) : NaN;
          if (Number.isFinite(score)) {
            base = mod(score);
            source = `${what}（${ability}调整值）${base >= 0 ? '+' : ''}${base}`;
          } else {
            source = `${what}（卡上没有，按 0 算）`;
          }
        }
      }

      const dc = Number.isFinite(Number(args?.dc)) ? Number(args.dc) : 15;
      const DISADV_CONDS = new Set(['中毒', '恐惧', '力竭', '目盲', '束缚']);
      const conds = Array.isArray(card?.conditions) ? card.conditions : [];
      const forced = conds.filter((c) => DISADV_CONDS.has(c));
      let mode = String(args?.mode || '').toLowerCase();
      let forcedNote = '';
      if (!mode && forced.length) {
        mode = 'disadvantage';
        forcedNote = `（因「${forced.join('、')}」自动劣势）`;
      }
      if (!mode) mode = 'normal';
      const adv = mode === 'advantage';
      const dis = mode === 'disadvantage';

      const rolled = [];
      const times = adv || dis ? 2 : 1;
      const r = cap('trpg.dice-roll', { expression: '1d20', repeat: times });
      if (!r || r.ok !== true) return { content: `检定失败：${r?.error || '骰子引擎出错'}`, isError: true };
      for (const item of r.results || []) {
        const m = /= (\d+)/.exec(String(item.detail || ''));
        if (m) rolled.push(Number(m[1]));
      }
      if (!rolled.length) return { content: '检定失败：拿不到骰点。', isError: true };
      const die = adv ? Math.max(...rolled) : (dis ? Math.min(...rolled) : rolled[0]);
      const total = die + base + extra;
      const nat20 = die === 20;
      const nat1 = die === 1;
      const ok = nat20 ? true : (nat1 ? false : total >= dc);

      const label = String(args?.label ?? '').trim();
      const head = label ? `【DnD 检定 · ${label}】` : '【DnD 检定】';
      const rollInfo = (adv || dis)
        ? `1d20 掷出 ${rolled.join(' / ')} → 取 ${die}（${adv ? '优势' : '劣势'}）`
        : `1d20 = ${die}`;
      const lines = [`${head}${rollInfo}  ${source}${extra ? ` 额外${extra >= 0 ? '+' : ''}${extra}` : ''}  = ${total} vs DC${dc}${forcedNote}`];
      lines.push(nat20 ? '天然 20 —— 大成功。' : (nat1 ? '天然 1 —— 大失败。' : (ok ? '成功。' : '失败。')));
      lines.push('把结果写进叙述里，不要重掷或改数字。');
      return { content: lines.join('\n') };
    },
  });

  /* ---------------- 升级 / 状态 / 休息 / 伤害 ---------------- */

  api.registerTool({
    id: 'level_up',
    name: '升级（里程碑）',
    description: '里程碑式升级，**不记经验**：一趟冒险打完、关键剧情推进、章节结束这类节点，用它提级。默认只升当前发言者；scope="party" 把本群所有人的卡一起升。升级按职业生命骰加血（平均血量 + 体质调整值）。**写盘，先征得主人同意再调，别每句话都升。**',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['self', 'party'], description: 'self（默认）= 只升当前发言者；party = 全队升一级。' },
      },
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!has('trpg.character-levelup')) return { content: '升级功能没装好（缺 trpg.character-levelup）。', isError: true };
      const scope = String(args?.scope || 'self');

      if (scope === 'party') {
        const roster = cap('trpg.character-public', { chatKey });
        const list = Array.isArray(roster?.list) ? roster.list : [];
        if (!list.length) return { content: '本群还没有人物卡，没人可升。' };
        const lines = [];
        for (const p of list) {
          const r = cap('trpg.character-levelup', { chatKey, userId: p.userId });
          if (!r || r.ok !== true) { lines.push(`${p.name}：升级失败`); continue; }
          lines.push(r.maxed
            ? `${p.name}：已经 Lv.20 满级`
            : `${p.name}：Lv.${r.prevLevel} → Lv.${r.level}（HP +${r.gainHp} → ${r.hp}）`);
        }
        return { content: `【全队升级】\n${lines.join('\n')}` };
      }

      if (!userId) return { content: '不知道这条消息是谁发的，升不了级。', isError: true };
      const r = cap('trpg.character-levelup', { chatKey, userId });
      if (!r || r.ok !== true) return { content: '升级没成功（可能还没有人物卡）。', isError: true };
      if (r.maxed) return { content: '已经是 Lv.20 满级了。' };
      const prof = 2 + Math.floor((r.level - 1) / 4);
      return { content: `升级！Lv.${r.prevLevel} → Lv.${r.level}，HP ${r.prevHp} → ${r.hp}（+${r.gainHp}），熟练加值 +${prof}。` };
    },
  });

  api.registerTool({
    id: 'set_condition',
    name: '加/去状态',
    description: '给**当前发言者自己**加或去掉一个异常状态（中毒/倒地/恐惧/束缚/目盲/力竭/魅惑/麻痹/石化/昏迷/隐形…）。中毒、恐惧、力竭、目盲、束缚会让下一次 roll_d20 自动带劣势。**写盘，剧情里真发生了再用。**',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: '状态名，例如"中毒""倒地"。' },
        action: { type: 'string', enum: ['add', 'remove'], description: '加还是去掉，默认 add。' },
      },
      required: ['condition'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，改不了状态。', isError: true };
      if (!has('trpg.character-conditions')) return { content: '状态系统没装好（缺 trpg.character-conditions）。', isError: true };
      const condition = String(args?.condition ?? '').trim();
      if (!condition) return { content: '要加什么状态？例如 {condition:"中毒"}', isError: true };
      const remove = String(args?.action || 'add') === 'remove';
      const r = cap('trpg.character-conditions', remove
        ? { chatKey, userId, remove: [condition] }
        : { chatKey, userId, add: [condition] });
      if (!r || r.ok !== true) return { content: '状态没改成。', isError: true };
      const list = r.conditions || [];
      return { content: `${remove ? '去掉' : '记上'}了「${condition}」。当前状态：${list.length ? list.join('、') : '无'}` };
    },
  });

  api.registerTool({
    id: 'take_rest',
    name: '休息',
    description: '当前发言者休整：短休（回一个生命骰，约 5~9 点）或长休（血量回满）。休息完把 HP 变化写进叙述。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['short', 'long'], description: '短休 / 长休，默认 short。' },
      },
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，休不了。', isError: true };
      if (!has('trpg.character-rest')) return { content: '休息系统没装好（缺 trpg.character-rest）。', isError: true };
      const r = cap('trpg.character-rest', { chatKey, userId, kind: String(args?.kind || 'short') });
      if (!r || r.ok !== true) return { content: '休息没成功（可能还没有人物卡）。', isError: true };
      const label = r.kind === 'short' ? '短休' : '长休';
      if (r.healed <= 0) return { content: `${label}完毕，HP 本来就是满的（${r.hp}/${r.maxHp}）。` };
      return { content: `${label}完毕：HP ${r.hp - r.healed}/${r.maxHp} → ${r.hp}/${r.maxHp}（+${r.healed}）。` };
    },
  });

  api.registerTool({
    id: 'apply_damage',
    name: '扣血 / 治疗',
    description: '给**当前发言者自己**扣血或回血（战斗结算、陷阱、毒、治疗药水都用它）。HP 归零会自动挂「倒地」状态，治回 1 点以上自动解除。数字以程序为准，不要自己心算血量。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '多少点（正数）。' },
        kind: { type: 'string', enum: ['damage', 'heal'], description: 'damage 扣血 / heal 回血，默认 damage。' },
      },
      required: ['amount'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，改不了血量。', isError: true };
      if (!has('trpg.character-hp')) return { content: '血量系统没装好（缺 trpg.character-hp）。', isError: true };
      const amount = Math.max(1, Math.trunc(Number(args?.amount) || 0));
      if (!amount) return { content: '要扣/回多少？amount 要是正整数。', isError: true };
      const heal = String(args?.kind || 'damage') === 'heal';
      const r = cap('trpg.character-hp', { chatKey, userId, delta: heal ? amount : -amount });
      if (!r || r.ok !== true) return { content: '血量没改成（可能还没有人物卡）。', isError: true };
      const parts = [`${heal ? '回复' : '受到'} ${amount} 点${heal ? '生命' : '伤害'}。HP ${r.before}/${r.maxHp} → ${r.hp}/${r.maxHp}`];
      if (r.down) parts.push('⚠️ 血量归零，已标记「倒地」。');
      parts.push('把这些数字原样写进叙述，不要改成"大约"。');
      return { content: parts.join('\n') };
    },
  });

  /* ---------------- 金币 / 商店 / 地图 ---------------- */

  api.registerTool({
    id: 'wallet',
    name: '看金币',
    description: '查看**当前发言者自己**的金币余额。金币是剧本外的货币，跨本通用。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，看不了金币。', isError: true };
      const card = has('trpg.character-get') ? cap('trpg.character-get', { chatKey, userId }) : null;
      if (!card) return { content: '你还没有人物卡。', isError: true };
      return { content: `金币：${Math.max(0, Math.trunc(Number(card.gold) || 0))}` };
    },
  });

  api.registerTool({
    id: 'grant_gold',
    name: '发金币',
    description: '给**当前发言者自己**发（或扣）金币。**只在主人同意时用**，玩家自己开口要不算理由；跑完一幕、做成一件大事可以提议结算，量级参考 20~80 金。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '多少金（负数=扣）。' },
        reason: { type: 'string', description: '发放理由，会写进回执。可选。' },
      },
      required: ['amount'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，发不了金币。', isError: true };
      if (!has('trpg.character-gold')) return { content: '金币系统没装好（缺 trpg.character-gold）。', isError: true };
      const n = Math.trunc(Number(args?.amount) || 0);
      if (!n) return { content: '要发多少金？amount 要是非零整数。', isError: true };
      const r = cap('trpg.character-gold', { chatKey, userId, delta: n });
      if (!r || r.ok !== true) return { content: '金币没改动（可能还没有人物卡）。', isError: true };
      const why = String(args?.reason || '').trim();
      return { content: `${n > 0 ? '发放' : '扣除'} ${Math.abs(n)} 金${why ? `（${why}）` : ''}。余额：${r.before} → ${r.gold}` };
    },
  });

  api.registerTool({
    id: 'shop_list',
    name: '看商店',
    description: '列出商店价目表（名称 / 价格 / 效果）。买之前先看这个，不要自己编价格。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute() {
      if (!has('trpg.shop-list')) return { content: '商店没装好（缺 trpg.shop-list）。', isError: true };
      const r = cap('trpg.shop-list');
      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) return { content: '商店是空的。' };
      const lines = items.map((it) => `· ${it.name} — ${it.price} 金${it.desc ? `（${it.desc}）` : ''}`);
      return { content: `【商店】\n${lines.join('\n')}` };
    },
  });

  api.registerTool({
    id: 'shop_buy',
    name: '买东西',
    description: '让**当前发言者自己**按价目表买一件东西（金币不够会失败）。价格与效果一律以工具返回为准，不要自己编。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: '商品名或 sku，例如"治疗药水"。' },
      },
      required: ['sku'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，买不了东西。', isError: true };
      if (!has('trpg.shop-buy')) return { content: '商店没装好（缺 trpg.shop-buy）。', isError: true };
      const sku = String(args?.sku ?? '').trim();
      if (!sku) return { content: '要买什么？先看 shop_list。', isError: true };
      const r = cap('trpg.shop-buy', { chatKey, userId, sku });
      if (!r || r.ok !== true) return { content: `买不了：${r?.error || '未知错误'}`, isError: true };
      const extra = (r.applied || []).length ? `\n${r.applied.join('；')}` : '';
      return { content: `买下了「${r.item.name}」（-${r.item.price} 金）。${extra}\n余额：${r.gold} 金` };
    },
  });

  api.registerTool({
    id: 'show_map',
    name: '发地图',
    description: '把本群当前地图（你在哪、能去哪）作为独立一块文本发出来。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.map-get')) return { content: '地图没装好（缺 trpg.map-get）。', isError: true };
      const r = cap('trpg.map-get', { chatKey });
      if (!r || r.ok !== true) return { content: '本群还没有地图。可以先用 set_map 建一张。' };
      const map = r.map;
      const here = map.places[map.current] || {};
      const exits = Array.isArray(here.exits) && here.exits.length ? here.exits.join('、') : '（没有出口）';
      return { content: `【${map.title}】\n你在这里：${map.current || '？（未定位）'}\n${here.desc || ''}\n可以去：${exits}` };
    },
  });

  api.registerTool({
    id: 'move_to',
    name: '移动到某地',
    description: '把队伍所在位置改到地图上的某个地点（只能是当前地点的出口）。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: { place: { type: 'string', description: '地名。' } },
      required: ['place'],
    },
    async execute(ctx, args) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.map-move')) return { content: '地图没装好（缺 trpg.map-move）。', isError: true };
      const r = cap('trpg.map-move', { chatKey, place: args?.place });
      if (!r || r.ok !== true) return { content: r?.error || '移动失败。', isError: true };
      const info = r.info || {};
      const exits = Array.isArray(info.exits) && info.exits.length ? info.exits.join('、') : '（没有出口）';
      return { content: `队伍来到「${r.current}」。\n${info.desc || ''}\n可以去：${exits}` };
    },
  });

  api.registerTool({
    id: 'set_map',
    name: '建/更新地图',
    description: '给本群建一张地图（或覆盖旧图）：一组地点，每个地点有描述和出口。**写盘，通常在开团前用。** 例：{title:"小镇", current:"广场", places:{"广场":{desc:"喷泉在滴水", exits:["酒馆","仓库"]}, "酒馆":{desc:"有人在打牌", exits:["广场"]}}}',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '地图标题，例如"小镇"。' },
        current: { type: 'string', description: '当前所在地点。可选，默认第一个。' },
        places: { type: 'object', description: '地点表：{ 地名: { desc, exits: [] } }。' },
      },
      required: ['places'],
    },
    async execute(_ctx, args) {
      const { chatKey } = resolveActor(_ctx, {});
      if (!has('trpg.map-set')) return { content: '地图没装好（缺 trpg.map-set）。', isError: true };
      const r = cap('trpg.map-set', { chatKey, title: args?.title, places: args?.places, current: args?.current });
      if (!r || r.ok !== true) return { content: r?.error || '建图失败。', isError: true };
      const names = Object.keys(r.map.places);
      return { content: `地图已建：${r.map.title}，共 ${names.length} 个地点（${names.join('、')}），当前在「${r.map.current}」。` };
    },
  });

  /* ---------------- 人物卡 ---------------- */

  api.registerTool({
    id: 'get_character',
    name: '读自己的人物卡',
    description: '读取**当前发言者自己**在本群的人物卡（属性、技能、HP、背景、状态、已知线索）。出于认知隔离，本工具看不到别人的卡：传了别人的 userId 会被拒绝，想看队伍名册请用 get_party。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '只允许填当前发言者自己的 QQ 号；填别人会被拒绝。一般省略。可选。' },
      },
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，读不到人物卡。', isError: true };
      if (!has('trpg.character-get')) return { content: '人物卡插件（plugins/trpg-tools）没有启用。', isError: true };
      const card = cap('trpg.character-get', { chatKey, userId });
      if (!card) return { content: '你还没有人物卡，可以先用 .pc roll 掷一张。' };
      return { content: renderCharacter(card) };
    },
  });

  api.registerTool({
    id: 'get_own_secret',
    name: '读自己的私密信息',
    description: '读取**当前发言者自己**的私密背景、登记过的已知线索等只有他自己知道的东西。别人的私密信息读不到，也不会出现在任何群体叙述里。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，读不到私密信息。', isError: true };
      if (!has('trpg.character-get')) return { content: '人物卡插件（plugins/trpg-tools）没有启用。', isError: true };
      const card = cap('trpg.character-get', { chatKey, userId });
      if (!card) return { content: '你还没有人物卡，没有私密信息。' };
      const lines = [];
      if (card.secret) lines.push(`私密背景：${card.secret}`);
      if (Array.isArray(card.known) && card.known.length) lines.push(`已知线索：\n${card.known.map((k, i) => `${i + 1}. ${k}`).join('\n')}`);
      return { content: lines.length ? lines.join('\n') : '还没有登记任何私密信息。' };
    },
  });

  api.registerTool({
    id: 'add_clue',
    name: '给自己记一条线索',
    description: '给**当前发言者自己**登记一条已知线索（他打听到的、看到的、别人告诉他的事）。只写进他自己的卡，别人看不到。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话写清线索内容。' },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId, name } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，记不了线索。', isError: true };
      if (!has('trpg.character-known')) return missingIntel();
      const text = String(args?.text ?? '').trim();
      if (!text) return { content: '要记什么线索？', isError: true };
      const list = cap('trpg.character-known', { chatKey, userId, text, name });
      const count = Array.isArray(list) ? list.length : 0;
      return { content: `记下了这条线索（他现在有 ${count} 条）。` };
    },
  });

  api.registerTool({
    id: 'update_character',
    name: '写自己的人物卡',
    description: '写入**当前发言者自己**的人物卡字段。key 为 力量/敏捷/体质/智力/感知/魅力 时写属性；为 hp/mp/san/斗气 时写状态；为 等级（或 level）、种族、职业、出身 时写对应的身份字段；其余一律当技能（如"侦查"）。升级请用 level_up，不要用本工具写等级。出于认知隔离，只能写当前发言者自己。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '字段名，例如"力量"、"侦查"、"hp"、"种族"、"职业"。"背景"用于写背景故事。' },
        value: {
          type: 'string',
          description: '数值字段填数字（力量 14、hp 12）；文本字段填文字（种族 侏儒、职业 战士）。key 为"背景"时填 0 即可。',
        },
        userId: { type: 'string', description: '只允许填当前发言者自己的 QQ 号；填别人会被拒绝。一般省略。可选。' },
        background: { type: 'string', description: '当 key 为"背景"时，把背景文本放这里。可选。' },
      },
      required: ['key'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId, name } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，写不了人物卡。', isError: true };
      if (!has('trpg.character-set')) return { content: '人物卡插件（plugins/trpg-tools）没有启用。', isError: true };
      const key = String(args?.key ?? '').trim();
      if (!key) return { content: '缺少 key 参数', isError: true };
      const isBackground = key === '背景' || key === 'background' || key === 'bg';
      if (isBackground) {
        if (!has('trpg.character-background')) return { content: '人物卡插件未提供背景写入能力。', isError: true };
        const written = cap('trpg.character-background', { chatKey, userId, text: String(args?.background ?? args?.value ?? ''), name });
        if (!written) return { content: '写入背景失败。', isError: true };
        return { content: `已记录背景。\n${renderCharacter(written)}` };
      }
      const TEXT_KEYS = new Set(['种族', '职业', 'race', 'class', 'clazz', '名字', 'name', '出身']);
      const rawValue = args?.value;
      const isText = TEXT_KEYS.has(key) || TEXT_KEYS.has(key.toLowerCase());
      if (isText) {
        const text = String(rawValue ?? '').trim();
        if (!text) return { content: `写入 ${key} 需要一段文字，例如 {key:"种族", value:"侏儒"}`, isError: true };
        const card = cap('trpg.character-set', { chatKey, userId, key, value: text, name });
        if (!card) return { content: `写入 ${key} 失败（插件未启用）。`, isError: true };
        return { content: `已记录：${key} = ${text}。\n${renderCharacter(card)}` };
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) {
        return { content: `value 必须是数字（力量/技能这类）；种族、职业请直接写中文，例如 {key:"种族", value:"侏儒"}`, isError: true };
      }
      const card = cap('trpg.character-set', { chatKey, userId, key, value, name });
      if (!card) return { content: `写入 ${key} 失败（插件未启用或数值非法）。`, isError: true };
      return { content: `已记录：${key} = ${value}。\n${renderCharacter(card)}` };
    },
  });

  api.registerTool({
    id: 'get_party',
    name: '看队伍名册',
    description: '拿本群的队伍公开名册：谁在场、名字、公开的属性与血量摘要。只有公开信息，不含任何人的私密背景或线索。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.character-public')) return missingPanel();
      const roster = cap('trpg.character-public', { chatKey });
      const list = Array.isArray(roster?.list) ? roster.list : [];
      if (!list.length) return { content: '本群还没有人物卡，大家都还没建卡。' };
      const lines = list.map((p, i) => `${i + 1}. ${p.name}${p.brief ? ` · ${p.brief}` : ''}`);
      return { content: `【队伍名册 · ${list.length} 人】\n${lines.join('\n')}` };
    },
  });

  api.registerTool({
    id: 'add_item',
    name: '加/删随身物资',
    description: '给**当前发言者自己**的随身物资加/删一件东西（武器、药品、火折子……）。剧情里捡到、买到、用掉东西时都要登记，卡册里会显示。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '物资名，例如"铁撬""火把"。' },
        remove: { type: 'boolean', description: 'true = 删掉，默认 false（添加）。' },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      const denied = denyOtherActor(ctx, args);
      if (denied) return denied;
      const { chatKey, userId, name } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，改不了物资。', isError: true };
      if (!has('trpg.character-items')) return missingPanel();
      const text = String(args?.text ?? '').trim();
      if (!text) return { content: '缺少物资名。', isError: true };
      const r = cap('trpg.character-items', { chatKey, userId, text, remove: args?.remove === true, name });
      if (!r || r.ok !== true) return { content: `物资没改成：${r?.error || '未知错误'}`, isError: true };
      if (args?.remove === true) {
        return { content: r.removed === false ? `没有「${text}」这件东西。` : `已删掉「${text}」（剩 ${r.count} 件）。` };
      }
      return { content: r.added === false ? `没放进背包：${r.reason || '满了'}` : `已登记「${text}」（共 ${r.count} 件）。` };
    },
  });

  /* ---------------- 面板（卡面） ---------------- */

  api.registerTool({
    id: 'show_status',
    name: '看自己的状态面板',
    description: '输出当前发言者自己的状态面板（属性、技能、HP、状态、等级）。单独一整块发，不要混进叙事段落。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的，看不到状态。', isError: true };
      if (!has('trpg.panel-status')) return missingPanel();
      const panel = cap('trpg.panel-status', { chatKey, userId });
      if (!panel || panel.ok !== true || !panel.text) return { content: `状态面板没做出来：${panel?.error || '这个人还没有人物卡。'}`, isError: !panel };
      return { content: panel.text };
    },
  });

  api.registerTool({
    id: 'show_party',
    name: '发队伍面板',
    description: '输出本群队伍面板（公开名册）。单独一整块发。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.panel-party')) return missingPanel();
      const panel = cap('trpg.panel-party', { chatKey });
      if (!panel || panel.ok !== true || !panel.text) return { content: `队伍面板没做出来：${panel?.error || '本群还没有人物卡。'}`, isError: !panel };
      return { content: panel.text };
    },
  });

  api.registerTool({
    id: 'show_card',
    name: '发自己的角色卡',
    description: '把当前发言者自己的完整人物卡作为独立一块文本发出来（同 show_status，给本人看的）。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey, userId } = resolveActor(ctx, {});
      if (!userId) return { content: '不知道这条消息是谁发的。', isError: true };
      if (!has('trpg.panel-status')) return missingPanel();
      const panel = cap('trpg.panel-status', { chatKey, userId });
      if (!panel || panel.ok !== true) return { content: panel?.error || '还没有人物卡。', isError: true };
      return { content: panel.text };
    },
  });

  api.registerTool({
    id: 'show_cardbook',
    name: '发队伍卡册',
    description: '把全队的卡册（每个玩家的技能与物资）作为独立一块文本发出来。**每一轮叙事之后都要单独发一次**，不要自己手写文本模拟。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.panel-party')) return missingPanel();
      const panel = cap('trpg.panel-party', { chatKey });
      if (!panel || panel.ok !== true) return { content: panel?.error || '本群还没有人物卡。', isError: true };
      return { content: panel.text };
    },
  });

  /* ---------------- 剧本库 ---------------- */

  api.registerTool({
    id: 'list_modules',
    name: '看剧本库',
    description: '列出本地剧本库里有哪些本（按系列分组）。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute() {
      if (!has('trpg.module-list')) return { content: '剧本库插件没有启用。', isError: true };
      const r = cap('trpg.module-list', {});
      const mods = Array.isArray(r?.modules) ? r.modules : [];
      if (!mods.length) return { content: '剧本库是空的。可以让管理员把剧本放进 data/trpg-tools/modules/。' };
      const series = has('trpg.module-series') ? cap('trpg.module-series', {}) : null;
      const groups = Array.isArray(series?.series) ? series.series : null;
      if (groups && groups.length) {
        const lines = groups.map((g) => `· ${g.name || '未分组'}：${(g.modules || []).map((m) => m.name || m.id).join('、')}`);
        return { content: `【剧本库 · ${mods.length} 本（按系列）】\n${lines.join('\n')}\n载入：.mod load <名字>。` };
      }
      const lines = mods.map((m, i) => `${i + 1}. ${m.name}${m.system ? `（${m.system}）` : ''}${m.acts?.length ? ` · ${m.acts.length} 幕` : ''}`);
      return { content: `【剧本库 · ${mods.length} 本】\n${lines.join('\n')}\n载入：.mod load <名字>。` };
    },
  });

  api.registerTool({
    id: 'read_module',
    name: '读当前模组的某一节',
    description: '读当前模组的正文：section 可填 rules（规则速查）/ world（世界观）/ overview（总纲）/ act:<n>（第 n 幕）/ npc（NPC 图鉴）。省略就读当前幕。需要细节时调用它，不要自己编设定。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'rules / world / overview / act:1 / npc。可选。' },
        module: { type: 'string', description: '模组名或 id（默认当前载入的）。可选。' },
      },
    },
    async execute(ctx, args) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.module-section')) return { content: '剧本库插件没有启用。', isError: true };
      const r = cap('trpg.module-section', { chatKey, section: args?.section, module: args?.module });
      if (!r || r.ok !== true) return { content: `读不了：${r?.error || '未知错误'}`, isError: true };
      return { content: r.text || r.content || '（这一节是空的）' };
    },
  });

  api.registerTool({
    id: 'find_module',
    name: '搜剧本',
    description: '在本地剧本库里按关键词搜本（名字/系列/规则/简介）。**只搜本地已入库的剧本**，不能联网找新本；新本要用文档入团（群里发 Word/PDF → import_document）或让主人物把文件放进 data/trpg-tools/modules/。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词，例如"恐怖""COC""2 人"。' },
      },
      required: ['keyword'],
    },
    async execute(_ctx, args) {
      if (!has('trpg.module-search')) return { content: '剧本库插件没有启用。', isError: true };
      const r = cap('trpg.module-search', { keyword: args?.keyword });
      if (!r || r.ok !== true) return { content: `没搜到：${r?.error || '未知错误'}`, isError: true };
      const hits = Array.isArray(r.hits) ? r.hits : (Array.isArray(r.modules) ? r.modules : []);
      if (!hits.length) return { content: `剧本库里没有匹配「${args?.keyword}」的本。` };
      const lines = hits.slice(0, 10).map((m, i) => `${i + 1}. ${m.name || m.id}${m.system ? `（${m.system}）` : ''}${m.acts?.length ? ` · ${m.acts.length} 幕` : ''}`);
      return { content: `【搜索到 ${hits.length} 本】\n${lines.join('\n')}\n载入：.mod load <名字>。` };
    },
  });

  /* ---------------- 文档入团 ---------------- */

  api.registerTool({
    id: 'list_documents',
    name: '查收到的文档',
    description: '列出群里发来、已自动下载到本地「文档收件箱」的文档（PDF / Word / PPT / txt / md）。群里有人发了剧本、规则书、角色卡文件之后，用这个工具找文件名。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute() {
      if (!has('trpg.doc-list')) return { content: '文档收件箱功能还没装好（没装 file-inbox 或 trpg-doc-bridge）。', isError: true };
      const r = cap('trpg.doc-list');
      if (!r || r.ok !== true) return { content: `查文档失败：${r?.error || '未知错误'}`, isError: true };
      if (!r.count) return { content: `文档收件箱（${r.dir}）里还没有文档。` };
      const lines = r.files.map((f, i) => `${i + 1}. ${f.name}（.${f.ext}，${Math.max(1, Math.round(f.size / 1024))} KB）`);
      return { content: `【文档收件箱 · 共 ${r.count} 个】\n${lines.join('\n')}\nread_document(文件名) 读内容；import_document 转成剧本。` };
    },
  });

  api.registerTool({
    id: 'read_document',
    name: '读收到的文档',
    description: '读取文档收件箱里某个文件的全部文字（自动解析 PDF / Word / PPT）。长文档会分段返回，按返回里的提示带 offset 继续读。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名（list_documents 结果里的 name）。' },
        offset: { type: 'number', description: '从第几个字符开始读。可选，默认 0。' },
      },
      required: ['name'],
    },
    async execute(_ctx, args) {
      if (!has('trpg.doc-read')) return { content: '文档读取功能还没装好。', isError: true };
      const name = String(args?.name ?? '').trim();
      if (!name) return { content: '要读哪个文件？先 list_documents 查。', isError: true };
      const r = cap('trpg.doc-read', { name, offset: args?.offset });
      if (!r || r.ok !== true) return { content: `读不了「${name}」：${r?.error || '未知错误'}`, isError: true };
      return { content: `【文档 ${name}】${r.note ? `\n（${r.note}）` : ''}\n${r.text}\n\n——（${r.hint}）` };
    },
  });

  api.registerTool({
    id: 'import_document',
    name: '把文档转成本地剧本',
    description: '把文档收件箱里的一个剧本文件提取文字、按「第X幕/序幕/尾声」切幕，写进本地剧本库。**写入磁盘，先征得主人同意再调。**',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名（list_documents 结果里的 name）。' },
        title: { type: 'string', description: '剧本名字（不填就用文件名）。可选。' },
        system: { type: 'string', description: '规则体系，例如 "DnD 5e"。可选。' },
        force: { type: 'boolean', description: '已有同名剧本时是否再建一份。默认 false。可选。' },
      },
      required: ['name'],
    },
    async execute(_ctx, args) {
      if (!has('trpg.doc-import')) return { content: '文档入团功能还没装好。', isError: true };
      const name = String(args?.name ?? '').trim();
      if (!name) return { content: '要转哪个文件？先 list_documents 查。', isError: true };
      const r = cap('trpg.doc-import', { name, title: args?.title, system: args?.system, force: args?.force === true });
      if (!r || r.ok !== true) return { content: `转剧本失败：${r?.error || '未知错误'}`, isError: true };
      return {
        content: `✅ 已转成本地剧本：id「${r.id}」｜${r.name}（提取 ${r.chars} 字，切出 ${r.acts} 幕）\n载入：.mod load ${r.id}；核对：read_module act:1。\n${r.hint || ''}`,
      };
    },
  });

  /* ---------------- 情报传播 ---------------- */

  api.registerTool({
    id: 'record_event',
    name: '记一件「可能被听说」的事',
    description: '记录一件事（写清地点与重要度 1~3），用于以后判断 NPC 有没有机会听说。每当发生"别人可能听说"的事就记一笔。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话写清发生了什么。' },
        place: { type: 'string', description: '发生在哪（地点名）。' },
        importance: { type: 'number', description: '1=小事 2=一般 3=大事。可选，默认 2。' },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.intel-record')) return missingIntel();
      const r = cap('trpg.intel-record', { chatKey, text: args?.text, place: args?.place, importance: args?.importance });
      if (!r || r.ok !== true) return { content: `没记上：${r?.error || '未知错误'}`, isError: true };
      return { content: `已记账：${args?.place || '（无地点）'} · ${args?.text}` };
    },
  });

  api.registerTool({
    id: 'check_knowledge',
    name: '查 NPC 可能听说什么',
    description: 'NPC 要提到过去的事之前先查：在某个地点、过了若干小时，他可能知道哪些事、可信度多高。certainty 低的要写成"只是听说"。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'NPC 所在/来自的地点。' },
        hours: { type: 'number', description: '距离事件发生过了多少小时。可选。' },
      },
      required: ['place'],
    },
    async execute(ctx, args) {
      const { chatKey } = resolveActor(ctx, {});
      if (!has('trpg.intel-known')) return missingIntel();
      const r = cap('trpg.intel-known', { chatKey, place: args?.place, hours: args?.hours });
      const list = Array.isArray(r?.list) ? r.list : [];
      if (!list.length) return { content: `${args?.place} 那边没听到过这些事。` };
      const lines = list.map((x) => `· ${x.text}（可信度 ${Math.round((x.certainty || 0) * 100)}%）`);
      return { content: `${args?.place} 经过这么久可能听说：\n${lines.join('\n')}\n可信度低的只能写成"听说"。` };
    },
  });

  log('trpg-gm 就绪（人物卡 / 检定 / 剧本库 / 文档入团）');
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

/** 当前模组的速查与当前幕摘要（拿不到就跳过）。 */
function moduleSections(chatKey, base) {
  const out = [];
  try {
    if (has('trpg.module-get')) {
      const r = cap('trpg.module-get', { chatKey });
      const mod = r?.module;
      if (mod) {
        const lines = [`▸ 模组：${mod.name || mod.id}`];
        if (mod.system) lines.push(`规则：${mod.system}`);
        if (mod.rulesSummary) lines.push(String(mod.rulesSummary).slice(0, 1200));
        out.push({ id: 'trpg-gm-module', title: '当前模组', priority: Math.max(1, base - 1), content: lines.join('\n') });
      }
    }
  } catch { /* 只是锦上添花 */ }
  return out;
}

export function promptSections(context = {}) {
  const chatKey = String(context?.chatKey ?? '');
  if (!chatKey) return [];
  const s = settings();
  if (!s.personaEnabled) return [];
  if (!gmOn(chatKey)) return [];
  const base = s.promptPriority;
  const persona = { id: 'trpg-gm-persona', title: '跑团模式（本群已开启）', priority: base, content: GM_PERSONA };
  return [persona, ...moduleSections(chatKey, base)];
}
