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

