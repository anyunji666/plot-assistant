# 变更记录

## 代码组织标准

结构清晰，文件代码内容符合文件名。单文件职责变得混杂、体积明显超出同类文件时，
按领域拆分到独立文件/子文件夹；文件名要能让人不看内容就大致猜到里面装的是什么。

## 重构历史

- 早期：`character.js`/`core.js` 等几个文件集中了大部分逻辑，按此标准手动拆分为
  `modules/{holiday,map,novel,novel-summary,phone,summary}/` 各模块下的
  `generator.js`/`parser.js`/`store.js`/`ui.js` 基本结构。
- 2026-08：`modules/summary/` 下继续细化——`status-llm-*.js`、`prompt-template-*.js`
  分别归入 `status-llm/`、`prompt-template/` 子文件夹；`parser.js`（1000+行，混了楼层还原/
  状态表解析/状态存档三块逻辑）拆分为 `floor-restore.js`/`status-table.js`/`archive.js`；
  `generator.js` 拆出 `pre-emphasis.js`；`novel-summary/lib/storage.js` 改名 `novel-idb.js`
  （避免跟"设置存储"的 `store.js` 混淆）；`map/data.js` 改名 `store.js`（统一叫法）。
