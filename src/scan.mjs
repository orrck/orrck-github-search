#!/usr/bin/env node
/**
 * 扫描引擎 —— 以【子进程】方式运行：node src/scan.mjs --run=3
 *
 * 为什么是子进程：Node 的堆只涨不跌。实测 arr.length=0 之后 434MB 一点没还给系统。
 * 自动模式要跑几天，所以每 1000 个项目主动退出，由服务端重启一个干净的进程。
 * 状态全在 SQLite 里，重启零交接成本。
 *
 * 内存纪律（按重要性排序）：
 *   M1 搜索响应 556KB 在 github.mjs 里当场投影成 445B/条，原始 JSON 不外流
 *   M2 README 流式读到 4KB 就 cancel，不读完再截
 *   M3 逐条流式，绝不把结果攒进数组
 *   M4 提完 (score, one_line) 后 readme/分析对象立刻出作用域，不保留
 *   M5 缓冲区满 100 条就落盘并清空，峰值恒定 44KB，与运行时长无关
 *   M7 已见集合只在 SQLite 里，内存中没有任何 Set
 *   M8 每 1000 个项目回收子进程
 */
import { Store } from "./db.mjs";
import { GitHub } from "./github.mjs";
import { LlmClient, extractJson } from "./llm.mjs";
import { findKey } from "./keys.mjs";
import * as P from "./prompt.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLUSH = 100;             // 每 100 个项目落盘一次（用户明确要求）
const RECYCLE_AFTER = 1000;    // 之后退出，交给服务端重启 —— 把 RSS 还给系统
const README_BYTES = 4096;
const EXIT_RECYCLE = 75;
// 单次扩词的上限 —— 【是上限，不是配额】。
// 让模型一次把它真正想得出的角度给全（原来只要 16/15 个，够不着就把前沿饿死了），
// 同时明确告诉它：凑数的近义词是负收益。
const EXPAND_MAX = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { run: 0, maxProjects: 0, db: join(ROOT, "data", "scan.db"), once: false };
  for (const a of argv.slice(2)) {
    let m;
    if ((m = a.match(/^--run=(\d+)$/))) o.run = Number(m[1]);
    else if ((m = a.match(/^--max-projects=(\d+)$/))) o.maxProjects = Number(m[1]);
    else if ((m = a.match(/^--db=(.+)$/))) o.db = m[1];
    else if (a === "--once") o.once = true;
  }
  return o;
}

/** LLM 配置：表单存的 data/llm.json 优先，其次环境变量/dabai 密钥链。 */
function loadLlmConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(ROOT, "data", "llm.json"), "utf8")); } catch (e) { /* 还没有 */ }
  return {
    baseUrl: file.baseUrl || process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
    // apiKeyEnv 优先：配置里只写环境变量名，值从密钥链（含 DSH 凭证库）现取。
    // 这样换 key 不用改 Github-search 的任何文件。
    apiKey: (file.apiKeyEnv ? findKey(file.apiKeyEnv) : "") ||
      file.apiKey || process.env.LLM_API_KEY || findKey("LLM_API_KEY") || "",
    model: file.model || process.env.LLM_MODEL || "deepseek-chat",
    temperature: file.temperature === undefined ? 0.2 : Number(file.temperature),
    apiKeyEnv: file.apiKeyEnv || "",
    timeoutMs: Number(file.timeoutMs || 120000),
  };
}

/** 免费额度：github.mjs 里按响应头被动纠偏，这里只管开跑。 */
function loadGithubConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(ROOT, "data", "github.json"), "utf8")); } catch (e) { /* 用默认 */ }
  return { searchPerMin: Number(file.searchPerMin || 0) || undefined, corePerHour: Number(file.corePerHour || 0) || undefined };
}

/** 免费过滤器：不花一分钱就能扔掉的，绝不进 seen 表（seen 只装真正花过钱的项目）。 */
export function passesFilter(it, run) {
  if (it.fork) return "fork";
  if (it.archived) return "archived";
  if (Number(it.stars) < Number(run.min_stars || 0)) return "stars";
  if (it.sizeKb === 0) return "empty";
  if (run.lang && String(it.lang).toLowerCase() !== String(run.lang).toLowerCase()) return "lang";
  if (Number(run.max_age_days) > 0 && it.pushed) {
    const cutoff = new Date(Date.now() - Number(run.max_age_days) * 86400000).toISOString().slice(0, 10);
    if (it.pushed < cutoff) return "stale";
  }
  return "";
}

async function main() {
  const opt = parseArgs(process.argv);
  if (!opt.run) { console.error("用法: node src/scan.mjs --run=<id>"); process.exit(2); }

  const store = new Store(opt.db);
  const run = store.getRun(opt.run);
  if (!run) { console.error("run " + opt.run + " 不存在"); process.exit(2); }

  const llm = new LlmClient(loadLlmConfig());
  const gh = new GitHub(loadGithubConfig());
  store.patchRun(run.id, { pid: process.pid });

  // 收到信号不要立刻死：把缓冲区落盘、把 run 标停，再退。
  // 服务端已经是 detached 启动，正常情况下这里不会被触发；
  // 只有人明确 kill 这个进程时才会走到。
  let killed = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { if (!killed) { killed = true; console.log("收到 " + sig + "，优雅退出中（缓冲区会落盘）"); } });
  }
  const cancelled = () => killed || store.isStopRequested(run.id);
  // 本地时区，别用 toISOString（那是 UTC，日志时间会对不上）
  const hhmmss = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()); };
  const log = (msg) => console.log("[" + hhmmss() + "] run#" + run.id + " " + msg);

  log("启动 pid=" + process.pid + " 模式=" + run.mode + " 门槛=" + run.threshold + " 目标n=" + run.want_n +
      " LLM=" + (llm.configured ? llm.model : "【未配置】") + " GitHub=" + (gh.configured ? "已认证" : "【未认证，60次/小时】"));

  // 回收：本 run 上次留下的在飞状态全部放回（这个进程是它唯一的属主），
  // 外加其它已停止的 run 留下的陈旧在飞状态（超 30 分钟的）。
  const back = store.reclaimRun(run.id);
  const back2 = store.reclaimStale(run.goal_hash, 30);
  // 【补充】属主已死的占位行，按属主判据回收，不受 30 分钟窗口限制。
  // 少了这一步，别的目标留下的占位会让同目标重跑静默跳过这些项目。
  const back3 = store.reclaimDeadOwners(run.goal_hash);
  if (back) log("回收本 run 上次未评完的 " + back + " 条");
  if (back2) log("回收其它任务遗留的 " + back2 + " 条");
  if (back3) log("回收属主已死的占位 " + back3 + " 条");

  // 【先判目标，再扩词】。分数缓存已经凑够的话，扩词那一次 LLM 调用纯属白花 ——
  // 实测同目标重跑时缓存里已经有十几个达标项目，want_n 却填得比它小。
  {
    const have = store.countHits(run.id);
    if (run.mode === "target" && have >= Number(run.want_n)) {
      store.finishRun(run.id, "分数缓存里已有 " + have + " 个达标项目，已达目标 " + run.want_n + "，无需搜索", "done");
      log("开局即达标：缓存 " + have + " ≥ 目标 " + run.want_n + "，不扩词、不搜索、不花额度");
      store.close();
      return;
    }
  }

  // 心跳：限流可能要等十几分钟，期间也要让服务端知道我还活着，别被误判成已死
  let lastUsage = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  const flushUsage = () => {
    const d = {
      llm_calls: llm.usage.calls - lastUsage.calls,
      tokens_in: llm.usage.prompt - lastUsage.prompt,
      tokens_out: llm.usage.completion - lastUsage.completion,
      tokens_cached: llm.usage.cached - lastUsage.cached,
    };
    lastUsage = { calls: llm.usage.calls, prompt: llm.usage.prompt, completion: llm.usage.completion, cached: llm.usage.cached };
    if (d.llm_calls || d.tokens_in || d.tokens_out) { try { store.bumpRun(run.id, d); } catch (e) { /* 忽略 */ } }
  };
  const hb = setInterval(() => { try { store.touch(run.id); flushUsage(); } catch (e) { /* 忽略 */ } }, 20000);

  // 【必须最先做】把用户那两三个关键词先用 LLM 扩成几十个近似词。
  // 之前的实现只在"前沿枯竭"时才扩词 —— 那样一个 run 会拿着 2 个原始词
  // 先翻满 20 页、白评两千个项目，扩词等于没做。
  if (!store.hasExpanded(run.id)) {
    const n = await expandKeywords(run, store, llm, log, true);
    log(n ? ("初始扩词：+" + n + " 个搜索词，现在共 " + store.countKeywords(run.id) + " 个")
          : "初始扩词失败或没产出，先用原始关键词开跑");
  }
  hb.unref();
  store.touch(run.id);

  let sinceRecycle = 0;
  let buf = [];
  let idleRounds = 0;

  const flush = async (arr) => {
    if (!arr.length) return;
    // 先整批摘出来并立刻清空 —— arr 马上回到 0 长度
    const batch = arr.splice(0, arr.length);
    let work = batch;
    if (run.funnel && batch.length > 1) work = await coarseFilter(batch, run, llm, store, log);
    const conc = Math.max(1, Math.min(6, Number(run.concurrency || 3)));
    for (let i = 0; i < work.length; i += conc) {
      const chunk = work.slice(i, i + conc);
      await Promise.all(chunk.map((it) => scoreOne(it, run, llm, gh, store, log, cancelled)));
      // chunk 在这里出作用域，详细分析不保留
    }
    store.patchRun(run.id, { qualified: store.countHits(run.id) });
    store.checkpoint();   // 每 100 条截断一次 WAL，别让它自己长成几个 G
    return store.countHits(run.id);
  };

  for (;;) {
    if (cancelled()) {
      await flush(buf);
      store.finishRun(run.id, killed ? "进程被终止（已优雅落盘）" : "手动停止");
      log("收到停止请求，退出");
      break;
    }
    if (run.mode === "target" && store.countHits(run.id) >= Number(run.want_n)) {
      await flush(buf); store.finishRun(run.id, "已凑够 " + run.want_n + " 个达标项目", "done"); log("达标停止"); break;
    }
    if (opt.maxProjects > 0 && sinceRecycle >= opt.maxProjects) { await flush(buf); store.finishRun(run.id, "达到测试上限", "done"); log("测试上限"); break; }
    if (sinceRecycle >= RECYCLE_AFTER) { await flush(buf); store.patchRun(run.id, { pid: 0 }); log("回收子进程（已处理 " + sinceRecycle + " 个项目），退出码 " + EXIT_RECYCLE); store.close(); process.exit(EXIT_RECYCLE); }

    const kw = store.nextKeyword(run.id);
    if (!kw) {
      // 前沿枯竭 → 让 LLM 基于已有产出再扩一轮新词
      const added = await expandKeywords(run, store, llm, log, false);
      if (!added) { await flush(buf); store.finishRun(run.id, "前沿枯竭：扩词也扩不出新词了", "done"); log("前沿枯竭，退出"); break; }
      log("前沿枯竭 → 又扩出 " + added + " 个新词");
      continue;
    }

    let page;
    try {
      page = await gh.search(kw.q, kw.page, 100, cancelled);
    } catch (e) {
      if (e.cancelled) continue;
      if (e.waitMs) { log("限流，等 " + Math.round(e.waitMs / 1000) + "s：" + e.message.slice(0, 90)); await sleep(e.waitMs); continue; }
      log("搜索出错：" + e.message.slice(0, 160));
      store.retireKeyword(run.id, kw.q);
      await sleep(2000);
      continue;
    }
    if (cancelled()) continue;
    if (page.exhausted) { store.retireKeyword(run.id, kw.q); log("词已翻到 1000 条上限，退休：" + kw.q); continue; }
    if (!page.items.length) { store.keywordYield(run.id, kw.q, 0); continue; }
    store.advanceKeyword(run.id, kw.q, page.totalCount);

    let admitted = 0;
    let filtered = 0;
    let stopEarly = "";
    for (const it of page.items) {
      // 停止条件必须逐条判：一页有 100 条，凑够了还继续评就是白烧钱
      if (run.mode === "target" && store.countHits(run.id) >= Number(run.want_n)) { stopEarly = "target"; break; }
      if (opt.maxProjects > 0 && sinceRecycle >= opt.maxProjects) { stopEarly = "limit"; break; }
      if (passesFilter(it, run)) { filtered++; continue; }     // 免费扔掉，不进 seen 表
      const prev = store.lookSeen(it.id, run.goal_hash);
      if (prev) {
        // 已经打过分 —— 零 API 零 LLM，直接按本次门槛复判
        if (prev.score !== null && prev.score !== undefined && Number(prev.score) >= Number(run.threshold)) {
          if (store.copyHit(run.id, it.id)) store.bumpRun(run.id, { reused: 1, scanned: 1 });
        }
        continue;
      }
      if (!store.claim(it.id, run.goal_hash, run.id)) continue;
      buf.push(it);
      admitted++;
      sinceRecycle++;
      if (buf.length >= FLUSH) { await flush(buf); log("落盘一批，累计处理 " + sinceRecycle + " 个"); }
    }
    store.keywordYield(run.id, kw.q, admitted);
    store.bumpRun(run.id, { scanned: admitted });
    await flush(buf);
    if (stopEarly === "target") { store.finishRun(run.id, "已凑够 " + run.want_n + " 个达标项目", "done"); log("达标停止（页内提前刹车，没白评剩下的）"); break; }
    if (stopEarly === "limit") { store.finishRun(run.id, "达到测试上限", "done"); log("测试上限 " + opt.maxProjects); break; }

    if (admitted === 0 && filtered === page.items.length) idleRounds++;
    else idleRounds = 0;
    if (idleRounds > 60) { store.finishRun(run.id, "连续 60 页全被过滤器挡掉，没有新项目可评", "done"); log("空转停止"); break; }
    if (opt.once) { store.finishRun(run.id, "单轮测试结束", "done"); break; }
  }

  clearInterval(hb);
  flushUsage();
  const st = store.stats();
  log("结束。已评分=" + (store.getRun(run.id).scored || 0) + " 达标=" + store.countHits(run.id) + " 复用=" + (store.getRun(run.id).reused || 0) +
      " seen=" + st.seen + " 库=" + (st.mainBytes / 1048576).toFixed(2) + "MB");
  store.close();
}

/**
 * 粗筛一个子批。核心难点是「content_filter 会毒化整批」：一个敏感仓库被拒，
 * 同批 15 条全部作废、全推给精评，而精评要抓 README —— 未认证下 60 次/小时，
 * 是全流程最贵的资源。粗筛存在的全部意义就是省它，一次误伤就白干。
 * 实测 run#19：cirosantilli/china-dictatorship 一个词就把整批打回精评。
 * 所以撞上内容过滤时二分劈开重试，把毒源隔离成单条标 blocked，保住其余各条。
 * 只在失败路径上付费 —— 干净批次的行为与以前逐字一致。
 */
async function coarseChunk(chunk, run, llm, store, log, depth) {
  if (!chunk.length) return [];
  let scores = null;
  try {
    const out = await llm.json([
      { role: "system", content: P.SYSTEM },
      { role: "user", content: P.coarsePrompt(run.goal, chunk) },
    ], { maxTokens: 8000 });
    if (out.finishReason !== "length" && out.json && Array.isArray(out.json.scores)) scores = out.json.scores;
    else log("粗筛输出被截断或格式不符，本批全部放行");
  } catch (e) {
    const filtered = e && e.finishReason === "content_filter";
    if (filtered && chunk.length > 1 && depth < 4) {
      const mid = Math.ceil(chunk.length / 2);
      log("粗筛撞内容过滤，二分隔离毒源（" + chunk.length + " → " + mid + "+" + (chunk.length - mid) + "）");
      const a = await coarseChunk(chunk.slice(0, mid), run, llm, store, log, depth + 1);
      const b = await coarseChunk(chunk.slice(mid), run, llm, store, log, depth + 1);
      return a.concat(b);
    }
    if (filtered && chunk.length === 1) {
      // 单独一条还被拒 = 就是它。和精评同款：blocked 不在回收名单里，等于永久跳过。
      store.markScored(chunk[0].id, run.goal_hash, null, "blocked");
      log("粗筛跳过（内容过滤，永久不再重试）：" + chunk[0].full_name);
      return [];
    }
    log("粗筛失败（本批全部放行，交给精评）：" + e.message.slice(0, 120));
  }
  if (!scores) return chunk.slice();
  const survivors = [];
  const byIdx = new Map();
  for (const s of scores) byIdx.set(Number(s.i), P.clampScore(s.score));
  for (let k = 0; k < chunk.length; k++) {
    const it = chunk[k];
    const sc = byIdx.has(k) ? byIdx.get(k) : null;
    // 拿不到分就放行 —— 粗筛宁可放过，不许错杀
    if (sc === null) { survivors.push(it); continue; }
    if (sc >= Number(run.coarse_threshold)) survivors.push(it);
    else { store.markScored(it.id, run.goal_hash, sc, "coarse_reject"); store.bumpRun(run.id, { rejected: 1 }); }
  }
  return survivors;
}

/** 两段漏斗第一段：只凭列表摘要批量粗筛，一次调用评一批，省下 80% 的 README 请求。 */
async function coarseFilter(batch, run, llm, store, log) {
  const CH = 15;
  const survivors = [];
  for (let i = 0; i < batch.length; i += CH) {
    const part = await coarseChunk(batch.slice(i, i + CH), run, llm, store, log, 0);
    for (const it of part) survivors.push(it);
  }
  return survivors;
}

/** 精评单个项目。详细分析不落任何地方 —— 只留 (repo_id, score, one_line)。 */
async function scoreOne(it, run, llm, gh, store, log, cancelled) {
  let readme = "";
  try {
    readme = await gh.readme(it.full_name, README_BYTES, cancelled);
  } catch (e) {
    if (e.cancelled) return;
    if (e.waitMs) { await sleep(Math.min(e.waitMs, 60000)); }
    readme = "";
  }
  it.readmeLen = readme.length;

  let out;
  try {
    out = await llm.json([
      { role: "system", content: P.SYSTEM },
      { role: "user", content: P.finePrompt(run.goal, it, readme) },
    ], { maxTokens: 4000 });
  } catch (e) {
    // nof1 上实测过：输出预算太小 → finish_reason=length → 可见内容为空。
    // 这种项目不能当"已评"，标记成 failed 等回收重试。
    // 但【内容过滤】是永久性的：同一个仓库名每次都会被同一个过滤器拒绝，
    // 标成 failed 只会让它永远重试、每轮白烧一次请求（实测 Fuck-XueXiQiangGuo）。
    // 用 blocked —— 它不在 reclaimStale/reclaimRun 的回收名单里，等于永久跳过。
    // 只认结构化字段。之前拿正则去猜错误文本，把 finish=length（推理吃光预算，
    // 和内容过滤毫无关系）也判成了永久拉黑 —— 实测误伤了 zpc1314521/PCL2。
    const blocked = e && e.finishReason === "content_filter";
    if (blocked) {
      store.markScored(it.id, run.goal_hash, null, "blocked");
      log("评分跳过（服务商内容过滤 finish=content_filter）：" + it.full_name);
    } else {
      store.markScored(it.id, run.goal_hash, null, "failed");
      store.bumpRun(run.id, { failed: 1 });
      log("评分失败（留待重试）：" + it.full_name + " —— " + e.message.slice(0, 110));
    }
    return;
  }
  if (out.finishReason === "length") {
    store.markScored(it.id, run.goal_hash, null, "failed");
    store.bumpRun(run.id, { failed: 1 });
    log("输出被截断，留待重试：" + it.full_name);
    return;
  }
  const score = P.clampScore(out.json && out.json.score);
  if (score === null) {
    store.markScored(it.id, run.goal_hash, null, "failed");
    store.bumpRun(run.id, { failed: 1 });
    return;
  }
  const one = P.clipOneLine(out.json && out.json.why);
  if (score >= Number(run.threshold)) {
    store.addHit(run.id, it, score, one);
    store.markScored(it.id, run.goal_hash, score, "hit");
    store.bumpRun(run.id, { scored: 1, qualified: 1 });
    log("达标 " + score.toFixed(2) + "  " + it.full_name);
  } else {
    store.markScored(it.id, run.goal_hash, score, "reject");
    store.bumpRun(run.id, { scored: 1, rejected: 1 });
  }
  // readme / out 到这里出作用域，什么都不留
}

/**
 * 扩词。initial=true 用用户原始关键词扩第一轮；
 * initial=false 在前沿枯竭时带着"已搜过的词 + 目前最好结果 + 分数分布"再扩一轮。
 * 两种情况下喂给模型的摘要都是有界的（最多 150 个词 + 12 条结果），绝不把历史全塞进去。
 */
/**
 * 抢救式提取搜索词 —— 纯字符串扫描，不用正则（少一层转义就少一个坑）。
 *
 * 扩词场景【不需要】完整 JSON：被截断的 queries 数组，前半截里每个 q 都是
 * 能直接用的搜索词，丢掉尾巴一两条完全无所谓。
 * 所以解析失败时不该重试（重试要再等一分钟），直接把能捞的捞出来。
 * u2-flash 这种推理开销大的模型尤其明显：实测 6000 token 预算下经常撞截断。
 */
export function salvageQueries(text) {
  const out = [];
  const seen = Object.create(null);
  const s = String(text || String.fromCharCode());
  const DQ = 34;   // 双引号 
  const BS = 92;   // 反斜杠
  const SP = 32, CO = 58, TAB = 9;
  const QK = String.fromCharCode(DQ) + String.fromCharCode(113) + String.fromCharCode(DQ);
  let i = 0;
  while (i < s.length) {
    i = s.indexOf(QK, i);
    if (i < 0) break;
    let j = i + QK.length;
    while (j < s.length && (s.charCodeAt(j) === SP || s.charCodeAt(j) === CO || s.charCodeAt(j) === TAB)) j++;
    if (s.charCodeAt(j) !== DQ) { i = j; continue; }
    j++;
    let buf = String.fromCharCode();
    while (j < s.length && s.charCodeAt(j) !== DQ) {
      if (s.charCodeAt(j) === BS) { j++; if (j < s.length) buf += s[j]; }
      else buf += s[j];
      j++;
    }
    const v = buf.trim();
    if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    i = j + 1;
  }
  return out;
}

async function expandKeywords(run, store, llm, log, initial) {
  const kws = store.listKeywords(run.id, 400);
  const depth = initial ? 1 : (Math.max(0, ...kws.map((k) => Number(k.depth || 0))) + 1);
  if (!initial && depth > Number(run.max_depth || 2)) return 0;
  if (kws.length >= Number(run.max_keywords || 200)) return 0;

  if (initial) {
    // 【不走 llm.json()，直接拿原文】。json() 解析失败会抛异常，
    // 那样原始文本就丢了、没法抢救；而截断的文本恰恰是最该抢救的东西。
    let raw0 = "";
    try {
      const r0 = await llm.chatRetry([
        { role: "system", content: P.SYSTEM },
        { role: "user", content: P.expandPrompt(run.keywords, run.goal, EXPAND_MAX) },
      // 【6000 是实测出来的，不是拍的】u2-flash 每次先烧约 2800 token 的隐藏推理
      // 才吐正文，吞吐约 50 tok/s。实测：
      //   max_tokens=2500 → 53s，finish=length，content 为空（预算全被推理吃光）
      //   max_tokens=6000 → 65s，finish=stop，正文 2816 字，正常产出
      //   max_tokens=12000 → 反而让它跑到 240s 超时，触发重试后一轮要 8 分钟
      // 给宽不等于更快：模型会用它来 rambling。够用就好。
      // 【2026-10-06 定论】问题不是预算，是 u2-flash 的隐藏推理失控。
      // 实测同一提示词：开推理 → 160s、finish=length、正文 0 字，39609 字推理
      // 全是 "maybe include X not." 的退化循环；加 reasoning_effort:"none" →
      // 11s、finish=stop、正文 1418 字、稳定解析出 16 个词。别再调 maxTokens 了。
      ], { maxTokens: 10000, reasoning: "none" });
      raw0 = r0.text || "";
      // 原始输出落盘：上次失败时 raw0 只活在内存里，事后只能靠推断复盘。
      try {
        writeFileSync(join(ROOT, "data", "expand-raw-run" + run.id + ".txt"),
          "finish=" + r0.finishReason + "  chars=" + raw0.length + "\n\n" + raw0.slice(0, 200000));
      } catch (e) { /* 诊断用，失败不影响主流程 */ }
      if (r0.finishReason === "length") log("初始扩词输出撞上 maxTokens 被截断，改走抢救式提取");
    } catch (e) { log("初始扩词调用失败：" + e.message.slice(0, 140)); return 0; }
    const parsed0 = extractJson(raw0);
    let q0 = (parsed0 && Array.isArray(parsed0.queries) ? parsed0.queries : [])
      .map((x) => (typeof x === "string" ? x : x && x.q)).filter(Boolean);
    if (!q0.length) {
      q0 = salvageQueries(raw0);
      if (q0.length) log("抢救式提取到 " + q0.length + " 个搜索词（尾巴被截断，不影响使用）");
    }
    const room0 = Number(run.max_keywords || 200) - kws.length;
    return store.addKeywords(run.id, q0.slice(0, Math.max(0, room0)), "llm-d1", 1);
  }

  const seenWords = kws.slice(0, 150).map((k) => k.q);
  const topHits = store.listHits(run.id, { limit: 12 })
    .map((h) => "- " + h.full_name + " (" + Number(h.score).toFixed(2) + ") " + h.one_line);
  const hist = store.scoreHistogram(run.id, 5);
  const digest = [
    "查询目标：" + run.goal,
    "",
    "已经搜过的 " + seenWords.length + " 个词（不要重复，也不要产出和它们结果重叠的词）：",
    seenWords.join(" / "),
    "",
    topHits.length ? ("目前找到的最好结果：\n" + topHits.join("\n")) : "目前还没有达标结果。",
    "",
    hist.n ? ("已评分 " + hist.n + " 个，分数区间 " + Number(hist.min).toFixed(2) + "~" + Number(hist.max).toFixed(2) +
      "，均值 " + hist.mean.toFixed(2) + "。") : "",
    "",
    "现在换一批完全不同的搜索角度，最多再给 " + EXPAND_MAX + " 个新 query —— 这是上限，不是配额。",
    "想一想前面这些词可能漏掉了什么：别的叫法、别的技术栈、别的社区用词、更窄的子领域。",
    "只想得出 8 个结果集互不重叠的角度就给 8 个。编近义词凑数是负收益：",
    "那些词搜出来的是同一批仓库，白白消耗搜索额度，还会把真正的空白角度挤掉。",
    "只输出 JSON：",
    '{"queries":[{"q":"搜索词","why":"想覆盖什么"}]}',
  ].join("\n");

  let out;
  try {
    out = await llm.json([
      { role: "system", content: P.SYSTEM },
      { role: "user", content: digest },
    ], { maxTokens: 8000 });
  } catch (e) {
    log("扩词失败：" + e.message.slice(0, 140));
    return 0;
  }
  const qs = (out.json && Array.isArray(out.json.queries) ? out.json.queries : [])
    .map((x) => (typeof x === "string" ? x : x && x.q)).filter(Boolean);
  const room = Number(run.max_keywords || 200) - kws.length;
  const added = store.addKeywords(run.id, qs.slice(0, Math.max(0, room)), "llm-d" + depth, depth);
  if (added) store.patchRun(run.id, {});
  return added;
}

// 【只在直接执行时跑 main】。否则 import 本模块做测试会立刻触发一次扫描：
// 既拿不到纯函数，还会在测试里意外启动子进程。
if (process.argv[1] && /scan\.mjs$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("扫描进程异常：" + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
