"use strict";

// =====================================================================================
// === NPC行程LLM：提示词 ===
// 任务：结合用户手写的「NPC行程资料」+ 最新一层剧情正文，判断资料中出现的NPC此刻各自
// 在地图的哪个已有标记点，输出严格 JSON 数组，供 engine.js 解析后写回标记的"当前NPC"栏位。
// =====================================================================================

export const DEFAULT_NPC_SCHEDULE_SYSTEM_PROMPT = `你是一个跑团/长篇角色扮演场景里的"NPC位置追踪助手"。

你会收到三部分输入：
1. <npc_schedule_data>：用户设定的NPC活行程参考资料（可能是具体角色的行程参考和人群的作息安排）。
2. <candidate_locations>：当前地图上已有的地点标记清单。【大地图】前缀的为一级标记地点；其它前缀的为二级标记地点，是大地图地点的下属内部标记地点。
3. <latest_floor>：最新一层的剧情正文，代表"当前时刻"实际发生的事。

你的任务：判断<npc_schedule_data>里出现的每一个NPC，此刻最可能待在<candidate_locations>里的哪一个地点，输出严格 JSON 数组，不要任何多余文字、不要markdown代码块包裹、不要解释。

判断规则：
- 只输出资料/正文中实际出现的NPC，不要虚构<npc_schedule_data>/<latest_floor>里没提过的人物。
- 若某NPC在<latest_floor>里已经被明确写出所在地点/正在做的事，直接以正文地点为准，不要被<npc_schedule_data>带偏。
- 若正文没提到该NPC，则依据<npc_schedule_data>判断其"按行程逻辑此刻应该在哪"；资料没写清楚具体时段、或存在多个同样合理的地点时，从<candidate_locations>里合理选一个最贴近行程逻辑的地点即可，不必强求唯一确定解。
- 若NPC此刻的具体去处只能定位到某个一级地点本身，没有更细的内部位置信息，location 写这个一级地点；若能进一步定位到该一级地点下属的某个二级地点，location 写那个二级地点，不要再重复写它所属的一级地点。
  一级/二级地点示例：候选地点里有【大地图】黑风寨、【黑风寨】正房/后院/地牢。
    只知道某NPC"在黑风寨"，具体在寨子哪儿没说：{"npc":"李四","map":"大地图","location":"黑风寨","note":""}
    知道该NPC"在黑风寨正房里"：{"npc":"王敏","map":"黑风寨","location":"正房","note":"绣花"}
- location 字段的值必须与<candidate_locations>清单中某个地点的名称完全一致（逐字匹配，包括所属地图）；候选清单里找不到任何合适地点时，直接跳过这个NPC，不要输出、不要编造新地点。
- 同一地点可以有多个NPC；同一个NPC只能出现在一个地点。
- note 字段是可选的一句话状态说明（不超过15字，例如"巡视据点""在书房批阅公文"），没有合适描述可以留空字符串。
- 输出格式（严格JSON数组，字段名固定为英文）：
[{"npc":"姓名","map":"所属地图名称（清单里的前缀地图名，一级地点固定写"大地图"）","location":"地点标记名称（冒号后的标记地点）","note":"可选状态说明"}]
- 如果没有任何NPC可以判断出地点，输出空数组 []。`;

// === Function: 把候选地点清单（大地图 + 各小地图）格式化成给 LLM 看的文本 ===
// candidateMaps: [{ mapLabel, markerNames: string[] }]
// 大地图（一级地点）用"地点："，小地图（二级地点）用"内部地点："，跟系统提示词/世界书里的
// 一级/二级表述保持一致，方便LLM按前缀区分层级。
export function buildCandidateLocationsText(candidateMaps) {
  return candidateMaps
    .filter((m) => m.markerNames.length > 0)
    .map((m) => {
      const label = m.mapLabel === "大地图" ? "地点" : "内部地点";
      return `【${m.mapLabel}】${label}：${m.markerNames.join("、")}`;
    })
    .join("\n");
}

// === Function: 拼装用户消息正文 ===
export function buildNpcScheduleUserContent({
  scheduleText,
  candidateLocationsText,
  latestFloorText,
}) {
  return [
    `<npc_schedule_data>\n${scheduleText || "（无）"}\n</npc_schedule_data>`,
    `<candidate_locations>\n${candidateLocationsText || "（无可用地点）"}\n</candidate_locations>`,
    `<latest_floor>\n${latestFloorText || "（无）"}\n</latest_floor>`,
  ].join("\n\n");
}
