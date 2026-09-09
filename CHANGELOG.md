# 变更记录

## 代码组织标准

结构清晰，文件代码内容符合文件名。单文件职责变得混杂、体积明显超出同类文件时，
按领域拆分到独立文件/子文件夹；文件名要能让人不看内容就大致猜到里面装的是什么。

单个函数体积明显超出同类函数（如一个弹窗/面板函数几百上千行）、又暂时不适合拆成
独立函数时，用 `// === 小节名 ===` 统一格式的注释按内部逻辑分段（如"字段列表区"/
"按钮事件绑定"等），让人不用读完整个函数就能定位到某一段在干什么；小节划分要贴合
代码本身已有的顺序，不要为了加标题去调整代码顺序——除非几个属于同一小节的代码块
被其它内容从中间隔开、拆成了不连续的几段，这种情况下才连带把它们挪到一起，再统一
加标题。

## 重构历史

- 早期：`character.js`/`core.js` 等几个文件集中了大部分逻辑，按此标准手动拆分为
  `modules/{holiday,map,novel,novel-summary,phone,summary}/` 各模块下的
  `generator.js`/`parser.js`/`store.js`/`ui.js` 基本结构。
- 2026-08：`modules/summary/` 下继续细化——`status-llm-*.js`、`prompt-template-*.js`
  分别归入 `status-llm/`、`prompt-template/` 子文件夹；`parser.js`（1000+行，混了楼层还原/
  状态表解析/状态存档三块逻辑）拆分为 `floor-restore.js`/`status-table.js`/`archive.js`；
  `generator.js` 拆出 `pre-emphasis.js`；`novel-summary/lib/storage.js` 改名 `novel-idb.js`
  （避免跟"设置存储"的 `store.js` 混淆）；`map/data.js` 改名 `store.js`（统一叫法）。
- 2026-09：`modules/chat-migration.js`（724行，混了解析/导出导入逻辑/记忆配置/弹窗UI
  四块职责）按同样的标准拆分为 `modules/chat-migration/{parser,generator,store,ui}.js`；
  `panel.js` 里 850+ 行的 `showSummaryPopup()`、`modules/summary/ui.js` 里 495 行的
  `openCustomFieldsDialog()` 体积太大又不适合拆函数，改用 `// === 小节名 ===` 分段——
  `showSummaryPopup()` 顺带把"联系人"（悬浮球开关跟另外两个按钮隔着"地图"）、"节假日"
  （假期预设/设置节假日跟开关按钮隔着"提示词模板联动"）这两处被打散成不连续代码块的
  绑定逻辑挪到了一起，才能各自收敛成一个标题。

## LLM 协作友好性改造

跟协作的 LLM 讨论后启动的一轮小改造，目的是减少"改动/排查时要靠读注释、搜字符串
字面量来确认跨模块隐式约定"的成本。原本讨论了共享常量、JSDoc类型标注、模块级
README、轻量测试、CHANGELOG 维护几个方向，权衡工作量和收益后，本轮只做**共享常量**
这一项（把散落在多个文件里、靠注释口口相传的字符串字面量约定收敛成常量，改动本身
零风险；JSDoc 范围经估算过大——大模块导出函数动辄近百个，暂缓，等真正遇到痛点再
针对性补）。

推进方式：一个模块一个模块做，做完一个就打包验证一次，避免中途因为单轮改动量太大
被打断。常量统一放进 `modules/core.js`（沿用项目里已有的跨模块常量惯例，没有新建
独立的 `constants.js`）；如果某个约定在还没轮到的模块里也有用到，会先在 `core.js`
里把常量定义好，只替换当前模块的引用，未轮到的模块留到做那个模块时再补，避免一次
改动跨越太多未验证的文件。

- 已完成：
  - `phone-migration`：新增 `PHONE_MESSAGE_FROM`（私信 `from` 字段的 `user`/
    `character`/`system` 约定），替换 `generator.js` 里 1 处引用。
  - `phone`：补齐 `PHONE_MESSAGE_FROM` 在本模块的引用——`generator.js` 7 处、
    `ui.js` 2 处，`store.js` 里 1 处相关注释同步更新为指向常量名。
  - `beautify`：新增 `CUSTOM_FIELD_SCOPE`（附加字段 `scope` 取值的 `character`/
    `global` 约定），替换 `render.js` 里 3 处引用；`badges.js` 本身已是良好组织
    的常量导出（`IDENTITY_WORDS`/`BLOOD_WORDS`/`STAGE_GROUPS`），未改动。
  - `summary`：补齐 `CUSTOM_FIELD_SCOPE` 在本模块的引用，并新增 `CUSTOM_FIELD_VALUE_TYPE`
    （附加字段 `valueType` 取值的 `numeric`/`text` 约定）——两个常量共涉及
    `status-llm/store.js`（2处+1处注释）、`status-llm/prompts.js`（3处）、
    `status-table.js`（5处）、`ui.js`（5处，含单选按钮选项列表和默认值）。
    这是目前改动范围最大的一个模块，但都是同一种"字符串换常量"的机械替换，
    没有触碰其他逻辑。
  - `chat-migration`：新增 `CHAT_MIGRATION_TAG_MODE`（导出时正文截取模式的
    `summary_only`/`whitelist`/`exclude` 约定）和 `CHAT_MIGRATION_IMPORT_MODE`
    （导入方式的 `overwrite`/`merge`/`newchat` 约定），涉及 `generator.js`（5处+
    1处默认参数）、`parser.js`（2处）、`ui.js`（8处，含单选按钮选项列表、默认值、
    自动切换逻辑，以及 1 处 jQuery 选择器里的字符串同步改成模板字符串引用常量）。
  - `novel`：排查过 `generator.js`/`store.js`/`ui.js`，没有发现需要收敛的跨文件
    字符串约定（裸字符串大都是 CSS 属性值），无代码改动。
  - `novel-summary`：排查过 `ui.js`/`lib/*.js`/`store.js`，同样没有跨文件字符串
    约定——`ui.js` 里的 `chunkStatus`（`pending`/`running`/`done`/`error`）虽然
    重复出现 20 多处，但完全封闭在单个文件内，不属于本轮"跨文件约定"的目标范围，
    无代码改动。
  - `holiday`：排查过 `inject.js`/`ui.js`/`settings.js`/`chinese-holidays.js`/
    `calc.js`/`lunar/*.js`。`calc.js` 里有个 `type: "day"/"range"`（自定义节假日
    单日型/区间型）的约定，但同样只在这一个文件内使用，其他文件不涉及，跟
    novel-summary 的情况一样不属于本轮目标范围，无代码改动。
  - 顶层文件（`core.js`/`character.js`/`worldinfo.js`/`mobile-opt.js`）：排查过
    全部四个文件，没有需要收敛的跨文件字符串约定——`core.js` 本身就是常量归属地，
    `mobile-opt.js` 已用 `MOBILE_OPT_*` 前缀自行组织好常量，`character.js`/
    `worldinfo.js` 里的裸字符串基本是 CSS 属性值和 `typeof` 原生判断，无代码改动。
  - `map`：新增 `MAP_FORM_CONTEXT_TYPE`（地图面板"待处理表单"的类型标记
    `marker`/`route`/`route-actions` 约定，标记新建/编辑标记点、新建路线、编辑
    路线途经动作三种表单状态），涉及 `markers.js`（1处设置+2处读取判断）、
    `routes.js`（2处设置）。其余文件（`store.js`/`ui.js`/`generator.js`/
    `npc-schedule/*.js`）排查过没有类似的跨文件字符串约定。

**至此计划里的全部模块（phone-migration/phone/beautify/summary/chat-migration/
novel/novel-summary/holiday/顶层文件/map）都过了一遍。** 后续如果新增模块或者
发现新的跨文件字符串约定，可以再按同样的方式单独处理，不必等下一轮整体扫描。

