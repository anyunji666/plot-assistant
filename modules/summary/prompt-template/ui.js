"use strict";

import { RELATIONSHIP_STAGE_WORDS } from "../status-table.js";

// === Function: 打开"动态提示词"格式说明浮层——纯展示，没有输入框，只有一个"关闭"按钮。
// 外壳样式对齐 holiday/ui.js 的 openTextDialog（遮罩+居中卡片+遮罩点击/Esc 可关闭），
// 内容部分改成一段可滚动的说明文字，教用户怎么在角色卡绑定的世界书条目里用 EJS（配合
// ST-Prompt-Template 扩展的 getvar()）按"阶段_角色名"变量写分支人设。
// 阶段词表直接从 status-table.js 的 RELATIONSHIP_STAGE_WORDS 动态拼，不在文案里手写第二份，
// 避免以后词表改了这里忘记同步。
// 返回 Promise<void>，点击"关闭"或点遮罩/按 Esc 都会 resolve，不区分结果——
// 面板那边拿到这个 Promise resolve 后会重新打开控制面板弹窗，回调方式跟 holiday 的
// openTextDialog 保持一致（await 之后由调用方决定后续动作）。===
export async function openPromptTemplateFormatDialog() {
  const $bodyEl = $("body");
  const prevBodyOverflow = $bodyEl.css("overflow");
  $bodyEl.css("overflow", "hidden");

  await new Promise((resolve) => {
    const $overlay = $("<div>").css({
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 99999,
      boxSizing: "border-box",
    });

    const $box = $("<div>").css({
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#252525",
      border: "1px solid #3a3a3a",
      borderRadius: "10px",
      padding: "clamp(16px, 4vw, 24px)",
      width: "min(560px, calc(100% - 24px))",
      maxHeight: "min(85vh, calc(100dvh - 24px))",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      color: "#e8e8e8",
      fontFamily: "inherit",
      boxSizing: "border-box",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
    });

    const $title = $("<div>").text("动态提示词 · EJS 人设书写格式说明").css({
      fontSize: "1.05em",
      fontWeight: "600",
      color: "#f0f0f0",
      letterSpacing: "0.01em",
    });

    const stageWordsLine = RELATIONSHIP_STAGE_WORDS.join(" / ");
    const bodyText =
      "1. 功能依赖 ST-Prompt-Template 扩展插件，使用需要把\u201c阶段词开/关\u201d打开。\n" +
      "2. 动态提示词写在角色卡绑定的世界书条目里即可。不随阶段变化的基础设定（年龄/职业/性格底色等）" +
      "直接写成普通文本，放在 <% %> 标签外面，永远生效。\n" +
      "3. 开头要写 <% const 阶段_角色名 = getvar('阶段_角色名', { defaults: '' }); %> 。" +
      "没有这层兜底的话，游戏刚开始、变量还没同步过时 getvar 可能读到 undefined，" +
      "导致所有阶段都不匹配，甚至报错。\n" +
      "4. EJS 会随角色关系阶段的变化，匹配发送相应的行为/语气。\n" +
      "5. 条件里的阶段词只能选用插件内置阶段词：\n" +
      stageWordsLine +
      "\n" +
      "示例一：\n" +
      "\n" +
      "林某，性格外冷内热，说话简洁，很少主动流露情绪。\n" +
      "\n" +
      "初始阶段词必填 {{user}}→林某: 陌生；之后阶段词可一步一步升级为 相识、相熟、好感、暧昧、亲密、恋人。\n" +
      "<% const 阶段_林某 = getvar('阶段_林某', { defaults: '' }); %>\n" +
      "\n" +
      "<% if (阶段_林某 === '好感') { %>\n" +
      "在{{user}}面前会不自觉放软语气，说话时偶尔走神看着对方，\n" +
      "被发现会立刻移开视线找借口掩饰；对{{user}}的关心表现得比对旁人更明显，但嘴上不会承认。\n" +
      "<% } %>\n" +
      "\n" +
      "<% if (阶段_林某 === '亲密') { %>\n" +
      "在{{user}}面前会主动表达情绪，肢体接触自然，称呼从\u201c你\u201d变成\u201c宝贝\u201d或类似昵称，\n" +
      "对{{user}}的安全和情绪状态高度敏感，会主动询问、主动安排见面。\n" +
      "<% } %>\n" +
      "\n" +
      "示例二：\n" +
      "\n" +
      "初始阶段词必填 {{user}}→男二: 兄弟(相识)；男二发现{{user}}和女一有亲密关系后阶段词转为 {{user}}→男二: 兄弟(对手)；男二发现{{user}}和女二有亲密关系后阶段词转为 {{user}}→男二: 兄弟(同伴)。\n" +
      "<% const 阶段_男二 = getvar('阶段_男二', { defaults: '' }); %>\n" +
      "\n" +
      "<% if (阶段_男二 === '相识') { %>\n" +
      "（这里需要一段\u201c和{{user}}相识\u201d的行为描写）\n" +
      "<% } %>\n" +
      "\n" +
      "<% if (阶段_男二 === '对手') { %>\n" +
      "（这里需要一段\u201c视{{user}}为竞争对手\u201d时的行为描写）\n" +
      "<% } %>\n" +
      "\n" +
      "<% if (阶段_男二 === '同伴') { %>\n" +
      "（这里需要一段\u201c把{{user}}当同伴\u201d时的行为描写）\n" +
      "<% } %>";

    const $body = $("<pre>").text(bodyText).css({
      margin: 0,
      fontSize: "0.85em",
      lineHeight: 1.6,
      color: "#ccc",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "inherit",
    });

    const $btnRow = $("<div>").css({
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
      marginTop: "4px",
    });
    const $close = $("<button>")
      .text("关闭")
      .css({
        padding: "6px 10px",
        borderRadius: "6px",
        boxSizing: "border-box",
        cursor: "pointer",
        fontSize: "0.8em",
        touchAction: "manipulation",
        border: "none",
        background: "#5b9cf6",
        color: "#ffffff",
        fontWeight: "600",
      });
    $btnRow.append($close);

    $box.append($title, $body, $btnRow);
    $overlay.append($box);
    $("body").append($overlay);

    const done = () => {
      $(document).off("keydown.promptTemplateFormatDialog");
      $overlay.remove();
      $bodyEl.css("overflow", prevBodyOverflow || "");
      resolve();
    };

    $close.on("click", () => done());

    let overlayPointerDownOnSelf = false;
    $overlay.on("mousedown touchstart", (e) => {
      overlayPointerDownOnSelf = $(e.target).is($overlay);
    });
    $overlay.on("mouseup touchend", (e) => {
      if (overlayPointerDownOnSelf && $(e.target).is($overlay)) done();
      overlayPointerDownOnSelf = false;
    });
    $(document).on("keydown.promptTemplateFormatDialog", (e) => {
      if (e.key === "Escape") done();
    });
  });
}
