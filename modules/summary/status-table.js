"use strict";

import { STATUS_TABLE_ENTRY_DEFAULTS, STATUS_TABLE_TITLE, getCtx, getLastAiFloor, notify, persistChatMetadata } from "../core.js";
import { handleCharacterBecameFree } from "../phone/generator.js";
import { getPhoneChatState } from "../phone/store.js";
import { getPromptTemplateStageSyncEnabled } from "./prompt-template/settings.js";
import { getOrCreateSummaryLorebook, saveOrOverwriteLorebookEntry } from "../worldinfo.js";
import { extractLabelLine } from "./floor-restore.js";

// =====================================================================================
// === 摘要模块解析 & 结构化数据表（状态表）===
// 对应酒馆预设里每层输出的 <details><summary>摘要</summary>...</details> 模块，
// 每层摘要模块字段并列为 Time / Location / Relationships / Inventory / Setups / Overview；
// 但持久化进"状态表"世界书条目的只有 Relationships / Inventory / Setups 三项——
// Time / Location / Overview 只存在于每层楼的摘要模块原文里（Overview 另外供小总结提取用），不写入状态表。
// Inventory 的 value 支持 +N/-N/=N 三种符号触发数值增减/覆盖（见 applyNumericMapUpdates），
// 其他格式（裸数字、带单位、纯文字）一律按普通文字整体覆盖。
// Relationships 的 value 允许两种合法形式：(a) 纯裸词（阶段词/身份词/血亲词表里的某一个词，原样写）；
// (b) 身份/血亲词后面用括号附带一个阶段词，如"师徒(朋友)"（全角/半角括号都兼容）。
// 状态表合并时会用 isValidRelationshipWord 校验，两种形式都不合规的值会被跳过并提示，不会写入状态表。
// Setups 仍是自由文本；对代码而言只是不透明字符串，按 key 整体覆盖，内容格式不影响解析逻辑。
// =====================================================================================

// === Helper: 从单层楼消息原文里解析摘要模块的各字段，解析不到 <details>摘要</details> 时返回 null ===
export function parseFloorSummaryFields(mesText) {
  if (!mesText || typeof mesText !== "string") return null;
  const detailsMatch = mesText.match(
    /<details>\s*<summary>\s*摘要\s*<\/summary>([\s\S]*?)<\/details>/,
  );
  if (!detailsMatch) return null;
  const inner = detailsMatch[1];

  const overviewMatch = inner.match(/Overview\s*[:：]\s*([\s\S]*)$/);

  return {
    time: extractLabelLine(inner, "Time"),
    location: extractLabelLine(inner, "Location"),
    relationships: extractLabelLine(inner, "Relationships"),
    inventory: extractLabelLine(inner, "Inventory"),
    setups: extractLabelLine(inner, "Setups"),
    busy: extractLabelLine(inner, "Busy"), // 仅供手机私信插件读取"角色: [REMOVE]"信号，不参与状态表 Relationships/Inventory/Setups 的常规合并
    expiredChapter: extractLabelLine(inner, "ExpiredChapter"), // 仅供剧情录入模块读取"章节名已演绎完"信号，同样不参与状态表合并
    overview: overviewMatch ? overviewMatch[1].trim() : "",
  };
}


// === Helper: 判断本层是否"疑似尝试输出了摘要模块但结构不完整"（如漏写 </details> 闭合标签），
// 用于和"这层压根没写摘要"区分开——前者需要提示用户（数据静默丢失了），后者是正常情况，不用提示。===
export function detectMalformedSummaryBlock(mesText) {
  if (!mesText || typeof mesText !== "string") return false;
  if (
    /<details>\s*<summary>\s*摘要\s*<\/summary>[\s\S]*?<\/details>/.test(
      mesText,
    )
  )
    return false; // 能正常解析，不算畸形
  return (
    /<summary>\s*摘要\s*<\/summary>/.test(mesText) ||
    (/<details>/.test(mesText) && /摘要/.test(mesText))
  );
}


// === Helper: 解析 "key: value; key2: value2" 形式的分号分隔键值列表，
// 额外收集"解析不出 key:value 结构"的原始片段供状态表合并时做格式校验 ===
// 分隔符/冒号同时兼容半角(; :)和中文全角(； ：)——中文语境下 AI 输出全角标点是常态，
// 只认半角会导致多组内容拆不开、被错误地整体塞进前一个 key 的 value 里（曾实际复现过此问题）。
// 容错：识别"[REMOVE]key"这类缺冒号、REMOVE写在key前面的错误格式（正确格式应为"key: [REMOVE]"）。
// 兼容半角/全角方括号及中文方头括号，REMOVE 大小写不敏感。
export const REMOVE_PREFIX_PATTERN = /^[\[［【]\s*remove\s*[\]］】]\s*(.+)$/i;

// 容错：识别"key[REMOVE]"这类缺冒号、REMOVE写在key后面（紧跟或隔空格）的错误格式。
export const REMOVE_SUFFIX_PATTERN = /^(.+?)\s*[\[［【]\s*remove\s*[\]］】]$/i;


export function parseKeyValueListWithSkipped(str) {
  const map = new Map();
  const skipped = [];
  const corrected = [];
  if (!str) return { map, skipped, corrected };
  str.split(/[;；]/).forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const idx = trimmed.search(/[:：]/);
    if (idx === -1) {
      const removePrefixMatch = trimmed.match(REMOVE_PREFIX_PATTERN);
      if (removePrefixMatch) {
        const key = removePrefixMatch[1].trim();
        if (key) {
          map.set(key, "[REMOVE]");
          corrected.push(
            `"${trimmed}" 缺少冒号分隔，已按 "${key}: [REMOVE]" 处理`,
          );
          return;
        }
      }
      const removeSuffixMatch = trimmed.match(REMOVE_SUFFIX_PATTERN);
      if (removeSuffixMatch) {
        const key = removeSuffixMatch[1].trim();
        if (key) {
          map.set(key, "[REMOVE]");
          corrected.push(
            `"${trimmed}" 缺少冒号分隔，已按 "${key}: [REMOVE]" 处理`,
          );
          return;
        }
      }
      skipped.push(trimmed);
      return;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) {
      map.set(key, value);
    } else {
      skipped.push(trimmed);
    }
  });
  return { map, skipped, corrected };
}


// === Helper: 键值 Map 序列化回 "key: value; key2: value2" ===
// 序列化统一输出半角分号/冒号，保证状态表世界书条目自身的格式始终规范，
// 下一轮读回来解析时不会再引入全角标点问题。
export function serializeKeyValueList(map) {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}


// === Helper: 把 Inventory 快照里纯数字的 value 改写成 "=数字" 格式（如 "3" → "=3"）。
// 状态表里数值型 Inventory 条目的存储形式本身就是裸数字（applyNumericMapUpdates 写回时用 formatNumericValue
// 生成的就是不带符号的纯数字字符串），但 mergeFloorIntoStatusTable 只认 +N/-N/=N 三种带符号前缀的写法，
// 裸数字会被 looksLikeAttemptedNumericButMalformed 判定成"疑似想写数值但格式不对"，整条跳过不写入。
// 状态存档是要粘回新对话第0层、经由 rebuildStatusTableFromChat 重新解析合并回状态表的，所以必须提前把裸数字
// 转换成 =N 的合法写法，否则这些数值条目会在新对话第一次全量重放时被静默丢弃。
// 非纯数字的 value（文字备注，如"未开封"）原样保留，不做任何改写。===
export const BARE_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

export function convertInventorySnapshotToHardset(inventoryLine) {
  const { map } = parseKeyValueListWithSkipped(inventoryLine);
  map.forEach((value, key) => {
    if (BARE_NUMBER_PATTERN.test(value.trim())) {
      map.set(key, `=${value.trim()}`);
    }
  });
  return serializeKeyValueList(map);
}


// === Helper: 全角数字/正负号/等号 → 半角，用于数值类字段的宽松解析 ===
export function normalizeNumericToken(raw) {
  return String(raw)
    .replace(/＋/g, "+")
    .replace(/－/g, "-")
    .replace(/＝/g, "=")
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    );
}


// === Helper: 判断是否为"删除该 key"标记，兼容 [REMOVE] 的全角方括号/中文方头括号写法 ===
export function isRemoveMarker(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === "[REMOVE]" ||
    trimmed === "［REMOVE］" ||
    trimmed === "【REMOVE】"
  );
}


// === Helper: 判断是否"疑似想写删除标记但格式没写对"（大小写不对、漏括号、写成中文"移除/删除"等）===
// 命中时既不会当作删除执行（避免误删），也不会当作普通文字整体覆盖（避免状态表里出现"[remove]"这类明显是格式错误的文本），
// 而是交给调用方跳过该条写入并提示，留给使用者自行判断。
export function looksLikeAttemptedRemove(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (isRemoveMarker(trimmed)) return false; // 标准写法走正常删除逻辑，不算"疑似"
  return (
    /^[\[［【(（]?\s*remove\s*[\]］】)）]?$/i.test(trimmed) ||
    trimmed === "移除" ||
    trimmed === "删除"
  );
}


// === Constants: Relationships 字段允许的固定关系词表（对应摘要.txt 里的阶段词/身份词/血亲词），用于校验 AI 输出是否合规 ===
export const RELATIONSHIP_STAGE_WORDS = [
  "陌生",
  "相识",
  "相熟",
  "好感",
  "暧昧",
  "亲密",
  "恋人",
  "未婚夫妻",
  "夫妻",
  "对手",
  "仇人",
  "宿敌",
  "同伴",
  "盟友",
  "朋友",
  "挚友",
];

export const RELATIONSHIP_RANK_WORDS = [
  "师徒",
  "师兄弟",
  "师兄妹",
  "师姐妹",
  "师姐弟",
  "义兄弟",
  "义兄妹",
  "义姐妹",
  "义姐弟",
  "同门",
  "同学",
  "同事",
  "邻居",
  "网友",
  "战友",
  "上下级",
  "继父子",
  "继父女",
  "继母子",
  "继母女",
  "主仆",
  "学长学弟",
  "学长学妹",
  "学姐学弟",
  "学姐学妹",
  "师生",
  "校友",
  "室友",
  "甲乙方",
  "合伙人",
  "医患",
  "队友",
  "教练学员",
  "房东租客",
  "粉丝偶像",
];

export const RELATIONSHIP_KIN_WORDS = [
  "父女",
  "父子",
  "母女",
  "母子",
  "兄弟",
  "兄妹",
  "姐弟",
  "姐妹",
  "祖孙",
  "叔侄",
  "舅甥",
  "姑侄",
  "姨甥",
  "表兄弟",
  "表兄妹",
  "表姐弟",
  "表姐妹",
  "堂兄弟",
  "堂兄妹",
  "堂姐弟",
  "堂姐妹",
];

export const RELATIONSHIP_ALLOWED_WORDS = new Set([
  ...RELATIONSHIP_STAGE_WORDS,
  ...RELATIONSHIP_RANK_WORDS,
  ...RELATIONSHIP_KIN_WORDS,
]);


// === Constant: 身份/血亲词表（合并），用于校验"身份/血亲词(阶段词)"这种带括号的合法形式 ===
export const RELATIONSHIP_RANK_OR_KIN_WORDS = new Set([
  ...RELATIONSHIP_RANK_WORDS,
  ...RELATIONSHIP_KIN_WORDS,
]);

export const RELATIONSHIP_STAGE_WORDS_SET = new Set(RELATIONSHIP_STAGE_WORDS);


// === Helper: 判断 Relationships 字段的 value 是否合法——允许两种形式：
//   (a) 纯裸词：词表（阶段词/身份词/血亲词）里的某一个词，原样写；
//   (b) 身份/血亲词(阶段词)：身份/名分词或血亲词后面紧跟半角/全角括号，括号里是一个阶段词，如 "师徒(朋友)"/"师徒（朋友）"。
// 其他任何附加内容（括注理由、单位等）一律不合法。 ===
export function isValidRelationshipWord(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (RELATIONSHIP_ALLOWED_WORDS.has(trimmed)) return true; // 形式 (a)：纯裸词

  const bracketMatch = trimmed.match(/^(.+?)[（(]([^（()）]+)[）)]$/); // 形式 (b)：主词 + 括号阶段词
  if (!bracketMatch) return false;
  const mainWord = bracketMatch[1].trim();
  const stageWord = bracketMatch[2].trim();
  return (
    RELATIONSHIP_RANK_OR_KIN_WORDS.has(mainWord) &&
    RELATIONSHIP_STAGE_WORDS_SET.has(stageWord)
  );
}


// === Helper: 从合法的 Relationships 值里提取"阶段词"——纯阶段词原样返回；
// "身份/血亲词(阶段词)"形式取括号里的阶段词；纯身份/血亲词（没有带括号阶段）返回空字符串。
// 用于把关系值归一成"阶段人设"功能能直接拿去做条件判断的一个词，不合法/取不到的值统一返回空字符串。===
export function extractRelationshipStageWord(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (RELATIONSHIP_STAGE_WORDS_SET.has(trimmed)) return trimmed;
  const bracketMatch = trimmed.match(/^(.+?)[（(]([^（()）]+)[）)]$/);
  if (bracketMatch) {
    const stageWord = bracketMatch[2].trim();
    if (RELATIONSHIP_STAGE_WORDS_SET.has(stageWord)) return stageWord;
  }
  return "";
}


// === Helper: 把 Map 视为"当前状态"，用一批更新做增删改（value 为 [REMOVE] 时删除该 key）===
// warnings/fieldLabel 可选：传入时，遇到"疑似删除标记但格式不对"的 value 会跳过写入并记录一条提示，而不是当普通文字存进去。
export function applyMapUpdates(baseMap, updatesMap, warnings, fieldLabel) {
  updatesMap.forEach((value, key) => {
    if (isRemoveMarker(value)) {
      baseMap.delete(key);
    } else if (looksLikeAttemptedRemove(value)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${value}" 疑似想写删除标记但格式不对（应为 [REMOVE]），已跳过，未做任何修改`,
        );
      }
    } else {
      baseMap.set(key, value);
    }
  });
}


// === Helper: 把数字格式化成字符串，去掉多余的浮点误差/尾随小数点 ===
export function formatNumericValue(num) {
  const rounded = Math.round(num * 1000) / 1000; // 保留最多3位小数，规避浮点误差
  return String(rounded);
}


// === Constants: Inventory 数值格式的两种合法正则，提升为模块级常量供多处复用 ===
export const NUMERIC_DELTA_PATTERN = /^([+-])(\d+(?:\.\d+)?)$/;

export const NUMERIC_HARDSET_PATTERN = /^=(-?\d+(?:\.\d+)?)$/;


// === Helper: 判断是否"疑似想写数值/数量但格式或用法不对"——
// 覆盖两类情况：
//   (a) =N/+N/-N 开头但带了多余括注/单位/理由（如 "=1(上衣口袋,未贴肉佩戴)"）；
//   (b) 裸数字开头，不带任何符号前缀（如 "3日份干粮"、"80x"）——这类值大概率不是合法的物品状态备注，
//       而是把数量、天数等信息错塞进了 Inventory，应引导写作者改写到 Overview，或改用合法的 =N/+N/-N 格式。
// 命中时既不会当作数值运算，也不会当作普通文字整体覆盖，而是交给调用方跳过该条写入并提示。===
export function looksLikeAttemptedNumericButMalformed(rawValue) {
  if (typeof rawValue !== "string") return false;
  const normalized = normalizeNumericToken(rawValue.trim());
  if (
    NUMERIC_DELTA_PATTERN.test(normalized) ||
    NUMERIC_HARDSET_PATTERN.test(normalized)
  )
    return false; // 合法格式，放行
  return /^[+\-=]?\d+(?:\.\d+)?/.test(normalized); // 数字开头（可选符号前缀），但整体不合法
}


// === Helper: 数值感知版的 Map 合并（供 Inventory 使用）——
// value 严格匹配两种格式才会触发数值运算，格式不符一律按普通文字整体覆盖（[REMOVE] 仍然是删除）：
//   +N / -N  → 在旧值基础上加减（旧值非数字或不存在时按 0 起算）
//   =N       → 直接覆盖成 N（N 可以带负号，如 =-5）
//   数字开头但不合法（含多余括注/单位，或裸数字开头）→ 疑似写错，跳过写入并警告，见 looksLikeAttemptedNumericButMalformed
//   其余非数字开头的纯文字 → 视为正常物品状态备注，原样整体覆盖
// 全角 ＋－＝ 和全角数字会先归一化成半角再匹配，未命中任何数值格式时仍保留原始文本（不做归一化覆盖），
// 避免把物品备注等纯文字误改写成归一化后的怪异内容。===
// warnings/fieldLabel 可选，用于收集校验提示；warnOnPlainFallback 参数保留供后续扩展使用——
// Inventory 允许非数值备注是正常用法（如物品状态说明），调用时传 false，不会提示（但数字开头的疑似误写始终会提示，不受此开关影响）。
export function applyNumericMapUpdates(
  baseMap,
  updatesMap,
  warnings,
  fieldLabel,
  warnOnPlainFallback,
) {
  updatesMap.forEach((rawValue, key) => {
    if (isRemoveMarker(rawValue)) {
      baseMap.delete(key);
      return;
    }

    if (looksLikeAttemptedRemove(rawValue)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 疑似想写删除标记但格式不对（应为 [REMOVE]），已跳过，未做任何修改`,
        );
      }
      return;
    }

    const normalized = normalizeNumericToken(rawValue.trim());
    const deltaMatch = normalized.match(NUMERIC_DELTA_PATTERN);
    const hardsetMatch = normalized.match(NUMERIC_HARDSET_PATTERN);

    if (deltaMatch) {
      const sign = deltaMatch[1] === "-" ? -1 : 1;
      const delta = sign * parseFloat(deltaMatch[2]);
      const oldValue = parseFloat(baseMap.get(key));
      const base = Number.isFinite(oldValue) ? oldValue : 0;
      const result = base + delta;
      if (result <= 0) {
        baseMap.delete(key);
        if (warnings) {
          warnings.push(
            `${fieldLabel || ""} "${key}" 数值计算后为 ${formatNumericValue(result)}（≤0），已自动移除该条目`,
          );
        }
      } else {
        baseMap.set(key, formatNumericValue(result));
      }
    } else if (hardsetMatch) {
      const result = parseFloat(hardsetMatch[1]);
      if (result <= 0) {
        baseMap.delete(key);
        if (warnings) {
          warnings.push(
            `${fieldLabel || ""} "${key}" 被硬修正为 ${formatNumericValue(result)}（≤0），已自动移除该条目`,
          );
        }
      } else {
        baseMap.set(key, formatNumericValue(result));
      }
    } else if (looksLikeAttemptedNumericButMalformed(rawValue)) {
      if (warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 疑似想写数量(=N/+N/-N)但格式或用法不对（多余括注/单位，或把非物品数量的数字塞进了 Inventory），已跳过，未做任何修改`,
        );
      }
      // 不写入：避免状态表里出现半数值半文字的怪异内容
    } else {
      baseMap.set(key, rawValue); // 非数字开头的纯文字，按普通文字整体覆盖
      if (warnOnPlainFallback && warnings) {
        warnings.push(
          `${fieldLabel || ""} "${key}" 的值 "${rawValue}" 不是合法的 +N/-N/=N 数值格式，已按普通文字整体覆盖，请检查该属性是否被写错`,
        );
      }
    }
  });
}


// === Helper: 把楼层摘要文本里等于"当前人格名"的整词换回状态表统一约定的字面量 {{user}} ===
// "对话前强调"提示词注入给正文AI之前，酒馆会先把其中的 {{user}} 宏替换成真实人格名，
// 正文AI从始至终都没见过字面量 {{user}}，它在 Relationships/Inventory/Setups 里写"自己"这一方时，
// 写的必然是当前人格名。这里在合并进状态表前统一转换回 {{user}}，让状态表内部数据保持
// extractOtherPartyName / 背包页 PHONE_INVENTORY_SELF_KEY 等下游代码一直依赖的那个约定，
// 不用在每处消费逻辑里都重新适配"真实人格名"。
// 只在紧跟着 "·"（Inventory/Setups 的 owner 分隔符）或 "→"（Relationships 的关系箭头）时才替换，
// 避免误伤人格名恰好出现在物品名、Setups 简介等自由文本内容里的情况。
export function normalizeSelfNameToLiteral(text) {
  if (!text) return text;
  const personaName = getCtx().name1;
  if (!personaName || personaName === "{{user}}") return text;
  const escaped = personaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[；;])\\s*${escaped}(?=\\s*[·→])`, "g");
  return text.replace(pattern, (_match, prefix) => `${prefix}{{user}}`);
}


// === Helper: 把当前 Relationships 里每个角色的"阶段词"同步进酒馆原生聊天变量（/setvar），
// 变量名固定为 `阶段_角色名`，值是 extractRelationshipStageWord 提取出的阶段词（可能是空字符串）。
// 供世界书条目里用 EJS（如 ST-Prompt-Template 扩展的 getvar()）按阶段做条件判断，
// 不用在 EJS 里重复解析状态表原始文本。同步失败只打日志，不影响状态表本身已经保存成功的结果，
// 也不中断循环——某一个角色同步失败不影响其余角色继续同步。
// 是否执行这个同步由控制面板"提示词模板联动"栏的"阶段词开/关"按钮控制，开关值存在
// prompt-template/settings.js 里，默认关闭；关闭时函数开头直接跳过，不影响状态表本身的落盘。===
async function syncRelationshipStagesToVariables(relationships) {
  if (!getPromptTemplateStageSyncEnabled()) return;
  const context = getCtx();
  if (typeof context.executeSlashCommandsWithOptions !== "function") return;
  for (const [key, value] of relationships.entries()) {
    const name = extractOtherPartyName(key);
    if (!name) continue;
    const stageWord = extractRelationshipStageWord(value);
    try {
      await context.executeSlashCommandsWithOptions(
        `/setvar key="阶段_${name}" ${stageWord}`,
      );
    } catch (error) {
      console.error(`[剧情助手] 同步"${name}"关系阶段到变量失败:`, error);
    }
  }
}


// === Helper: 从 "{{user}}→角色名" 这类关系 key 里取出"另一方"角色名（排除 {{user}} 自身）===
export function extractOtherPartyName(relationshipKey) {
  const parts = relationshipKey.split("→").map((s) => s.trim());
  const other = parts.find((p) => p && p !== "{{user}}");
  return other || null;
}


// === Helper: 把状态表结构化对象序列化回世界书条目文本 ===
// busyMap 为可选参数：手机私信插件维护的"当前忙碌角色"表（{角色名: true, ...}），
// 不来自聊天记录全量重放（跟 Relationships/Inventory/Setups 不同源），只在序列化这一步拼进状态表末尾，
// 让正文 AI 每轮都能看到"谁正忙"，从而在这些角色不再登场时输出 Busy: 角色名: [REMOVE] 清除标记。
export function serializeStatusTableContent(state, busyMap) {
  const lines = [
    "<snapshot_table>",
    `Relationships: ${serializeKeyValueList(state.relationships)}`,
    `Inventory: ${serializeKeyValueList(state.inventory)}`,
    `Setups: ${serializeKeyValueList(state.setups)}`,
  ];
  const busyNames = busyMap
    ? Object.keys(busyMap).filter((name) => busyMap[name])
    : [];
  lines.push(`Busy: ${busyNames.map((name) => `${name}: 忙`).join("; ")}`);
  // 固定提醒行：每次序列化都重新生成，不写进任何 Map、不参与解析（不匹配任何字段标签的正则），
  // 纯粹是"贴在状态表末尾、每轮都会被 AI 看到"的说明性提示，告知 Setups 条目的性质（伏笔/线索/约定），
  // 便于剧情LLM理解上下文；Setups 的存量清理（[REMOVE]）已由状态表LLM独立负责，见 status-llm/prompts.js。
  // 只在 Setups 非空时附加，避免空列表时提醒显得多余。
  if (state.setups && state.setups.size > 0) {
    lines.push(
      "（提醒：以上 Setups 为故事发展过程中的伏笔/线索/约定）",
    );
  }
  if (busyNames.length > 0) {
    lines.push(
      '（提醒：以上 Busy 中的角色若本轮未出现在正文场景里，请在摘要块的 Busy 字段输出"角色名: [REMOVE]"清除）',
    );
  }
  lines.push("</snapshot_table>");
  return lines.join("\n");
}


// === Helper: 把某一层解析出的摘要字段合并进状态表（Relationships/Inventory/Setups 按 key 增删改；Time/Location 不写入状态表；
// 角色在 Relationships 里被 [REMOVE]（死亡/永久退场）时，联动清理 Inventory/Setups 中"角色名·xxx"格式的相关条目）===
// warnings 为可选的数组，传入时会收集本次合并中发现的所有格式问题（不合规的部分会被跳过、不写入状态表，
// 但不会阻断其余合法字段的正常合并）。不传 warnings 时行为与之前完全一致，仅静默跳过不合规内容。
// removedOut 为可选的数组，传入时会把本层新death/离场（Relationships被标[REMOVE]）的角色名追加进去，
// 供调用方（rebuildStatusTableFromChat）联动清理这些角色残留的手机"忙碌"标记，不传则不影响原有行为。
export function mergeFloorIntoStatusTable(state, floorFields, warnings, removedOut) {
  const relationshipsText = normalizeSelfNameToLiteral(floorFields.relationships);
  const inventoryText = normalizeSelfNameToLiteral(floorFields.inventory);
  const setupsText = normalizeSelfNameToLiteral(floorFields.setups);

  const relParsed = parseKeyValueListWithSkipped(relationshipsText);
  if (warnings) {
    relParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Relationships 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    relParsed.corrected.forEach((msg) =>
      warnings.push(`Relationships：${msg}`),
    );
  }
  const removedCharacters = [];
  relParsed.map.forEach((value, key) => {
    if (isRemoveMarker(value)) {
      state.relationships.delete(key);
      const other = extractOtherPartyName(key);
      if (other) {
        removedCharacters.push(other);
        if (removedOut) removedOut.push(other);
      }
    } else if (isValidRelationshipWord(value)) {
      state.relationships.set(key, value);
    } else if (warnings) {
      warnings.push(
        `Relationships "${key}" 的值 "${value}" 不在允许的固定关系词表中，且不是 [REMOVE] 标记，已跳过，未做任何修改`,
      );
    }
    // 不传 warnings 时（旧行为兜底）：不合规的值直接跳过，不写入，避免脏数据进入状态表。
  });

  const inventoryParsed = parseKeyValueListWithSkipped(inventoryText);
  const setupsParsed = parseKeyValueListWithSkipped(setupsText);
  if (warnings) {
    inventoryParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Inventory 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    inventoryParsed.corrected.forEach((msg) =>
      warnings.push(`Inventory：${msg}`),
    );
    setupsParsed.skipped.forEach((fragment) =>
      warnings.push(
        `Setups 中的片段 "${fragment}" 无法解析出 key:value 结构，已跳过`,
      ),
    );
    setupsParsed.corrected.forEach((msg) => warnings.push(`Setups：${msg}`));
  }

  applyNumericMapUpdates(
    state.inventory,
    inventoryParsed.map,
    warnings,
    "Inventory",
    false,
  );
  applyMapUpdates(state.setups, setupsParsed.map, warnings, "Setups");

  removedCharacters.forEach((name) => {
    const prefix = `${name}·`;
    Array.from(state.inventory.keys()).forEach((key) => {
      if (key.startsWith(prefix)) state.inventory.delete(key);
    });
    Array.from(state.setups.keys()).forEach((key) => {
      if (key.startsWith(prefix)) state.setups.delete(key);
    });
  });

  return state;
}


// === Helper: 记录"已经提示过格式问题"的楼层，避免全量重放模式下同一层反复弹同一条警告。
// key 用 "messageId::具体问题文本" 拼接——同一层如果问题内容变了（比如用户手动改了这层文本），会当成新问题重新提示一次；
// 只有内容和上次完全一样才会被去重。切换角色卡/刷新页面后该记录清空，属于预期行为（值不大，不做持久化）。===
export const warnedStatusTableIssues = new Set();


// === Helper: 全量重放——以当前 chat 数组里【现存】的所有 AI 楼层为准，从头重新解析并合并出状态表。
// 不再对单一楼层做"增量合并后原地覆盖"，而是每次都重新推导一遍完整状态，天然与当前对话内容保持一致：
// 楼层被删除/回退后，下一次触发时重放范围会自动收窄，不需要额外的"检测回退"分支。===
export async function rebuildStatusTableFromChat() {
  const context = getCtx();
  const chat = context.chat;
  if (!Array.isArray(chat)) return;

  const state = {
    relationships: new Map(),
    inventory: new Map(),
    setups: new Map(),
  };
  const newIssues = []; // 本次重放中新出现（之前没提示过）的问题，收集齐后一次性提示
  const everRemovedCharacters = []; // 整段重放期间，所有被 Relationships [REMOVE]（死亡/永久离场）过的角色名

  chat.forEach((message, idx) => {
    if (!message || message.is_user) return;

    const floorFields = parseFloorSummaryFields(message.mes);
    if (!floorFields) {
      if (detectMalformedSummaryBlock(message.mes)) {
        const issueKey = `${idx}::malformed`;
        if (!warnedStatusTableIssues.has(issueKey)) {
          warnedStatusTableIssues.add(issueKey);
          newIssues.push(
            `第${idx}层似乎输出了摘要模块，但 <details>/<summary> 结构不完整（例如漏写闭合标签），未能解析，本层未计入状态表。`,
          );
        }
      }
      return;
    }

    const floorWarnings = [];
    mergeFloorIntoStatusTable(state, floorFields, floorWarnings, everRemovedCharacters);
    floorWarnings.forEach((w) => {
      const issueKey = `${idx}::${w}`;
      if (!warnedStatusTableIssues.has(issueKey)) {
        warnedStatusTableIssues.add(issueKey);
        newIssues.push(`第${idx}层：${w}`);
      }
    });
  });

  // 手机私信插件的 Busy 状态不参与上面的全量重放（它的来源是用户在手机里主动发消息，不是从聊天记录解析出来的），
  // 只在这里"读取当前值 → 拼进序列化结果"；常规 REMOVE 信号只看【最新一层】AI 楼层，不回溯整段历史——
  // 忙碌状态本身只在"当前"有意义，没必要像 Relationships 那样重放整个对话。
  // 例外：角色死亡/永久离场（Relationships [REMOVE]）这种"确定不会再有下文"的情况，不受上面这条限制，
  // 见下方 everRemovedCharacters 的联动清理。
  const phoneState = getPhoneChatState();

  // 死亡/永久离场角色联动清理"忙碌"标记：这类角色已经确定不会再回复私信，
  // 不等 AI 在某一层想起来补一句 Busy: 角色名: [REMOVE]（它未必会记得），直接用上面重放时已经拿到的
  // "谁被 Relationships [REMOVE] 过"结论同步清掉，避免状态表里一直挂着一条不会再被清除的"角色: 忙"。
  // 注意：这里不走 freedCharacters/handleCharacterBecameFree 那条自动补发私信回复的路径——
  // 角色已经死亡/离场，不该再让手机弹出一条"ta的新消息"。
  let busyCleanupChanged = false;
  everRemovedCharacters.forEach((name) => {
    if (phoneState.busy[name]) {
      delete phoneState.busy[name];
      busyCleanupChanged = true;
    }
  });

  const freedCharacters = [];
  const { idx: latestAiIdx, mes: latestAiMes } = getLastAiFloor();
  if (latestAiIdx !== -1) {
    const latestFields = parseFloorSummaryFields(latestAiMes);
    if (latestFields && latestFields.busy) {
      const { map: busyRemoveMap } = parseKeyValueListWithSkipped(
        latestFields.busy,
      );
      busyRemoveMap.forEach((value, name) => {
        if (isRemoveMarker(value) && phoneState.busy[name]) {
          delete phoneState.busy[name];
          freedCharacters.push(name);
        }
      });
    }
  }

  const newContent = serializeStatusTableContent(state, phoneState.busy);
  const lorebookName = await getOrCreateSummaryLorebook();
  await saveOrOverwriteLorebookEntry(
    lorebookName,
    STATUS_TABLE_TITLE,
    newContent,
    true,
    STATUS_TABLE_ENTRY_DEFAULTS,
  );

  await syncRelationshipStagesToVariables(state.relationships);

  if (freedCharacters.length > 0 || busyCleanupChanged) {
    await persistChatMetadata();
    for (const name of freedCharacters) {
      await handleCharacterBecameFree(name);
    }
  }

  if (newIssues.length > 0) {
    notify(
      "warning",
      `状态表重新计算时发现 ${newIssues.length} 处新的格式问题，相关内容已跳过：\n` +
        newIssues.map((w) => `· ${w}`).join("\n"),
    );
  }
}


// === Event handler: 楼层变化（新增/删除/编辑/重roll）后自动重算状态表（出错不弹窗打断阅读，仅打印控制台）===
export const handleMessageForStatusTable = async () => {
  try {
    await rebuildStatusTableFromChat();
  } catch (error) {
    console.error("[剧情助手] 自动更新状态表时出错:", error);
  }
};


// === Helper: 生成一段楼层范围的"小总结"内容——连续有摘要模块的楼层直接读取并保留 Time/Location/Overview 拼接，
// 连续没有摘要模块的楼层区间才调用 AI 重新总结（方案A：分段回退）。不再提取/生成关系字段——
// 关系状态统一由状态表世界书条目实时持久化（见 mergeFloorIntoStatusTable），小总结只做叙事性回顾，状态存档只做状态快照。===


