/**
 * 提示词。三条规矩：
 *
 * 1) 【不许出现门槛数值】一旦模型知道 0.8 过线，它就会全打 0.81 —— okxdesk 上实测过：
 *    提示词里写了「最小信心度 0.65」，9 次真实开仓报的分数是 0.66~0.68，方差为零。
 *    分数必须是「真实判断」，过滤是通道的事，不是模型的事。
 *
 * 2) 【锚点校准】每次调用都带同样的 3 个锚点例子，让尺度跨调用稳定 ——
 *    否则第 1 个项目和第 500 个项目的 0.7 不是同一个 0.7。
 *    锚点是固定文本，顺带成为可缓存前缀（okxdesk 实测前缀缓存命中 1408/1582 token）。
 *
 * 3) 【要区分度】明确要求分数别挤在一起，并且界面上画直方图验证。
 */

/** 系统前缀：三次调用完全一致，别改 —— 改了缓存就失效。 */
export const SYSTEM = [
  "你是一个技术选型助理。用户给一个「查询目标」，你要判断某个 GitHub 仓库对这个目标的实用价值。",
  "",
  "【打分口径】0 到 1 的小数，凭你的真实判断填：",
  "  0.90-1.00  正是用户要的东西，可以直接拿来用",
  "  0.75-0.89  高度相关，稍作改造就能用",
  "  0.60-0.74  相关，但只能作为参考或部分借鉴",
  "  0.40-0.59  沾边：主题相关，但解决的不是同一个问题",
  "  0.20-0.39  基本不相关",
  "  0.00-0.19  完全无关：教程、课程作业、awesome 清单、空壳仓库、个人练习",
  "",
  "【锚点】下面三个例子用来校准你的尺度，每次调用都一样，请对齐它们：",
  '  例1  描述="A multi-agent LLM framework for automated financial trading, with backtesting"',
  '       目标="找能直接跑的 LLM 交易 agent"  → 0.92',
  '  例2  描述="A curated list of papers and links about LLM agents"，同一目标 → 0.25（清单不是项目）',
  '  例3  描述="Tutorial: build your first LLM agent in 30 minutes"，同一目标 → 0.35（教程不是可用框架）',
  "",
  "【硬要求】",
  "- 如实打分。分数必须有区分度：如果每个仓库都给 0.7 上下，这个分数就没有任何信息量。",
  "- 不要因为 star 多就给高分，也不要因为 star 少就给低分。",
  "- 不要揣测「多少分算合格」，也不要为了让某个项目通过而调分。你只负责如实评估。",
  "- 一句话介绍用中文，不超过 100 个汉字，必须说清「它是什么」+「为什么符合或不符合目标」，不要照抄 description。",
  "- 只输出 JSON，不要任何解释文字、不要 markdown 围栏。",
].join("\n");

/** 第一步：把用户关键词扩成一组 GitHub 搜索 query。 */
export function expandPrompt(keywords, goal, want) {
  return [
    "用户关键词：" + String(keywords || "").replace(/\n/g, " / "),
    "查询目标：" + String(goal || ""),
    "",
    "把关键词扩展成一组 GitHub 搜索能用的 query。要求：",
    "- 覆盖英文同义词、上位词、下位词、相邻技术和常见命名习惯；中文关键词给出对应英文说法（GitHub 上英文项目占绝大多数）。",
    "",
    "【最重要的一条】GitHub 搜索是 AND —— 你给的每个词都必须出现在仓库里，每多一个词就砍掉一大批结果。实测：",
    '    "cyber threat intelligence agent"                             → 156 条',
    '    "cyber threat intelligence agent language:Python stars:>50"   →   0 条',
    "同一个词，加了语言和 stars 就从 156 条变成 0 条。所以每个 query 控制在 2~4 个词。",
    "堆 5 个以上的词、再加限定符，几乎必然搜出 0 条 —— 那种词进 frontier 就是纯浪费。",
    "",
    "- 限定符（language: / stars:>N / topic: / pushed:>…）默认【不要用】。",
    "  只有当某个词本身就太宽（比如单一个 security）才拿它收窄，而且【一个 query 最多用一个】。",
    "  不要给所有 query 都加语言或 stars —— 那会把整批词一起变成 0 条。",
    "- 词与词之间的结果集要尽量不重叠 —— 不要 10 个词搜出来是同一批仓库。",
    "  靠【换个角度、换个叫法】来错开，不要靠调 stars 阈值来切。",
    "- 单个 query 在 GitHub 上最多只能翻到 1000 条结果，所以宁可多切几个窄词，也不要一个宽词。",
    "- 不要用 from: / org: / user: 这类需要额外信息的限定符。",
    "",
    "只输出 JSON：",
    '{"queries":[{"q":"搜索词","why":"这个词想覆盖什么"}]}',
    "最多给 " + (want || 50) + " 个 —— 这是上限，不是配额。",
    "只为真正不同的角度出词：只想得出 12 个结果集互不重叠的 query 就给 12 个。",
    "编近义词凑数是负收益 —— 那些词搜出来的是同一批仓库，白白消耗搜索额度。",
    "q 里面不要带引号，why 不超过 15 个字。",
  ].join("\n");
}

/** 第二步（可选的两段漏斗）：只凭列表里的摘要批量粗筛，一次调用评一批。 */
export function coarsePrompt(goal, items) {
  const lines = items.map((it, i) => {
    return [
      "#" + i,
      "  仓库: " + it.full_name,
      "  描述: " + (it.desc || "(无描述)"),
      "  语言: " + (it.lang || "?") + " | star: " + it.stars + " | 最后更新: " + (it.pushed || "?") +
        " | 归档: " + (it.archived ? "是" : "否"),
      "  topics: " + ((it.topics && it.topics.length) ? it.topics.join(", ") : "(无)"),
    ].join("\n");
  }).join("\n");
  return [
    "查询目标：" + String(goal || ""),
    "",
    "下面 " + items.length + " 个仓库只有列表摘要，还没有读 README。逐个判断它们对目标的实用价值。",
    "这是粗筛，宁可放过也不要错杀：不确定就给中间分，后面还会看 README 精评。",
    "",
    lines,
    "",
    "只输出 JSON，序号必须和我给的一一对应、一个都不能少：",
    '{"scores":[{"i":0,"score":0.00,"why":"不超过30字"}]}',
  ].join("\n");
}

/** 第三步：读完 README 后的精评 —— 最终分数和那一句话介绍都出自这里。 */
export function finePrompt(goal, it, readme) {
  const md = readme ? cleanForPrompt(readme) : "";
  return [
    "查询目标：" + String(goal || ""),
    "",
    "仓库：" + it.full_name,
    "描述：" + (it.desc || "(无描述)"),
    "语言：" + (it.lang || "?") + "  |  star：" + it.stars + "  |  最后更新：" + (it.pushed || "?") +
      "  |  创建：" + (it.created || "?") + "  |  归档：" + (it.archived ? "是" : "否"),
    "Topics：" + ((it.topics && it.topics.length) ? it.topics.join(", ") : "(无)"),
    "",
    md ? ("README：\n---\n" + md + "\n---") : "README：(没有 README，或读取失败 —— 只能凭描述判断，请在 why 里注明)",
    "",
    "判断这个仓库对目标的实用价值。",
    "",
    "只输出 JSON：",
    '{"score":0.00,"why":"一句话介绍，不超过 100 个汉字"}',
    "why 必须同时说清这两件事：它是什么；它为什么符合（或不符合）目标。",
  ].join("\n");
}

/** README 再压一道：去掉纯链接行和图片行，省 token 也去噪。 */
export function cleanForPrompt(md) {
  return String(md)
    .split("\n")
    .filter((ln) => {
      const s = ln.trim();
      if (!s) return true;
      if (/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)$/.test(s)) return false;   // 徽章 [![alt](img)](link)，括号嵌套，通用链接正则抓不到
      if (/^\[[^\]]*\]\([^)]*\)$/.test(s)) return false;              // 纯链接行
      if (/^[-*]\s*\[[^\]]*\]\([^)]*\)/.test(s)) return false;        // 列表里的链接
      if (/^(<img|!\[)/i.test(s)) return false;                          // 图片
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 4200);
}

/** 把模型给的分夹到 [0,1] 并保证是数字。 */
export function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/** 一句话介绍强制截断到 100 字（模型经常超）。 */
export function clipOneLine(s) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length <= 100 ? t : t.slice(0, 99) + "…";
}
