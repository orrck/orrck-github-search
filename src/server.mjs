#!/usr/bin/env node
/**
 * HTTP 服务 —— 两个职责：
 *   1) 表单与结果界面（index.html 每次请求读盘，改界面不用重启）
 *   2) 扫描子进程的监护人：启动、回收重启、崩溃收尾
 *
 * 扫描本身不在这里跑。Node 的堆只涨不跌，长跑必须靠换进程（见 scan.mjs 文件头）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, goalHash } from "./db.mjs";
import { LlmClient } from "./llm.mjs";
import { findKey } from "./keys.mjs";
import { GitHub } from "./github.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const DB = join(DATA, "scan.db");
const SCAN = join(ROOT, "src", "scan.mjs");
const PORT = Number(process.env.GITHUB_SEARCH_PORT || 8097);
const HOST = process.env.GITHUB_SEARCH_HOST || "127.0.0.1";
const EXIT_RECYCLE = 75;

mkdirSync(DATA, { recursive: true });

const store = new Store(DB);
/** 与 scan.mjs 同一套解析：apiKeyEnv 优先，值从密钥链现取，不落盘。 */
function llmConfigFromFile() {
  const f = loadJson("llm.json", {});
  const key = (f.apiKeyEnv ? findKey(String(f.apiKeyEnv)) : "") || f.apiKey || "";
  return { baseUrl: f.baseUrl, model: f.model, apiKey: key, temperature: f.temperature, timeoutMs: f.timeoutMs };
}
const llm = new LlmClient(llmConfigFromFile());
const llmFileCfg = loadJson("llm.json", {});
let gh = new GitHub(loadJson("github.json", {}));
let cfg = Object.assign({
  seenRetentionDays: 180,     // 阀门 A：超过这个天数的 seen 行删掉
  maxDbMb: 1024,              // 阀门 B：库超过这个大小就从最旧的开始删
}, loadJson("config.json", {}));

const children = new Map();     // runId -> { proc, restarts, startedAt }
const logs = new Map();         // runId -> string[]（有界环形缓冲，最多 200 行）
let lastMaint = null;
let rateCache = { at: 0, data: null };

function loadJson(name, dflt) {
  try { return JSON.parse(readFileSync(join(DATA, name), "utf8")); } catch (e) { return dflt; }
}
function saveJson(name, obj, mode) {
  const p = join(DATA, name);
  writeFileSync(p, JSON.stringify(obj, null, 2), { mode: mode || 0o600 });
  return p;
}
function pushLog(runId, chunk) {
  let arr = logs.get(runId);
  if (!arr) { arr = []; logs.set(runId, arr); }
  for (const line of String(chunk).split("\n")) {
    if (!line.trim()) continue;
    arr.push(line.slice(0, 400));
  }
  // 有界：日志也是内存，只留最近 200 行
  if (arr.length > 200) arr.splice(0, arr.length - 200);
}

// ------------------------------------------------------------ 子进程监护
function spawnScan(runId) {
  const prev = children.get(runId);
  const restarts = prev ? prev.restarts + 1 : 0;
  if (restarts > 200) { store.finishRun(runId, "重启次数过多，放弃", "failed"); return; }
  // detached: 让扫描进程自成一个进程组。
  // 否则服务端收到 SIGINT/SIGTERM 时会连带把扫描一起带走
  //（终端 Ctrl+C、systemd 默认 KillMode=control-group 都是这个行为），
  // 跑了几小时的扫描会因为重启服务而白费。
  const proc = spawn(process.execPath, [SCAN, "--run=" + runId, "--db=" + DB], {
    cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  children.set(runId, { proc, restarts, startedAt: Date.now() });
  pushLog(runId, "── 扫描进程启动 pid=" + proc.pid + (restarts ? "（第 " + restarts + " 次回收重启）" : ""));
  proc.stdout.on("data", (d) => pushLog(runId, d));
  proc.stderr.on("data", (d) => pushLog(runId, d));
  proc.on("exit", (code, signal) => {
    children.delete(runId);
    const run = store.getRun(runId);
    if (!run) return;
    if (code === EXIT_RECYCLE) {
      pushLog(runId, "── 回收退出（内存归还），1 秒后重启");
      if (run.status === "running") setTimeout(() => { if (store.getRun(runId) && store.getRun(runId).status === "running") spawnScan(runId); }, 1000);
      return;
    }
    if (run.status === "running") {
      pushLog(runId, "── 扫描进程退出 code=" + code + " signal=" + (signal || "-"));
      // 退出码 0 = 正常收工但没自己写终态（极少见），其余一律算异常。
      // 用 failed 而不是 stopped，前端才会画红点 —— 「崩了」和「手动停」不该同色。
      store.finishRun(runId, "扫描进程退出（code " + code + "）", code === 0 ? "done" : "failed");
    } else {
      pushLog(runId, "── 扫描进程退出（正常收工）");
    }
  });
}
function stopScan(runId) {
  const c = children.get(runId);
  if (c && c.proc && !c.proc.killed) { try { c.proc.kill("SIGTERM"); } catch (e) { /* 已退出 */ } }
}

// ------------------------------------------------------------ 维护定时器
// 只盯 seen 一张表。DELETE 之后还得还页 + 截断 WAL，否则文件不会变小。
setInterval(() => {
  try {
    lastMaint = Object.assign({ at: Date.now() }, store.maintain(cfg));
    if (lastMaint.byAge + lastMaint.bySize > 0) {
      console.log("[维护] 删 seen 行 " + (lastMaint.byAge + lastMaint.bySize) +
        "，库 " + (lastMaint.before / 1048576).toFixed(1) + "MB → " + (lastMaint.after / 1048576).toFixed(1) + "MB");
    } else {
      store.checkpoint();
    }
  } catch (e) { console.error("[维护] 失败：" + e.message); }
}, 10 * 60 * 1000).unref();

// ------------------------------------------------------------ HTTP
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > (max || 262144)) { reject(new Error("请求体过大")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => {
      if (!parts.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
      catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}
function serveFile(res, abs, type) {
  try {
    const buf = readFileSync(abs);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(buf);
  } catch (e) { res.writeHead(404); res.end("not found"); }
}

/** 本地时间戳。别用 toISOString —— 那是 UTC，导出文件上的时间会差 8 小时。 */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const path = url.pathname;
  try {
    if (path === "/" || path === "/index.html") return serveFile(res, join(ROOT, "src", "web", "index.html"), MIME[".html"]);

    // ------------------------------------------------------------------ 状态
    if (path === "/api/state" && req.method === "GET") {
      sweepAdopted();
      if (Date.now() - rateCache.at > 60000) {
        const rl = await gh.probeRateLimit();
        rateCache = { at: Date.now(), data: rl };
      }
      const runs = store.listRuns(40).map((r) => Object.assign({}, r, {
        running: children.has(r.id) || (r.status === "running" && !store.isStale(r.id, STALE_MS)),
        adopted: !children.has(r.id) && r.status === "running" && !store.isStale(r.id, STALE_MS),
        log: (logs.get(r.id) || []).slice(-25),
      }));
      return send(res, 200, {
        ok: true,
        llm: llm.describe(),
        github: Object.assign(gh.describe(), { rateLimit: rateCache.data }),
        db: store.stats(),
        config: cfg,
        maintenance: lastMaint,
        runs,
      });
    }

    // ------------------------------------------------------------- LLM 配置
    if (path === "/api/llm" && req.method === "POST") {
      const b = await readBody(req, 8192);
      llm.setConfig(b);
      // 落盘 0600；GET 永远只回脱敏值
      // 保留已有的 apiKeyEnv：界面只改模型/地址时不该把间接引用冲掉。
      // 只有用户显式填了新 key 才把它写进文件。
      const keep = Object.assign({}, llmFileCfg);
      if (b.apiKey) { keep.apiKey = llm.apiKey; delete keep.apiKeyEnv; }
      else if (b.apiKeyEnv !== undefined) keep.apiKeyEnv = String(b.apiKeyEnv || "");
      keep.baseUrl = llm.baseUrl; keep.model = llm.model;
      keep.temperature = llm.temperature; keep.timeoutMs = llm.timeoutMs;
      if (!keep.apiKey) delete keep.apiKey;
      saveJson("llm.json", keep, 0o600);
      Object.assign(llmFileCfg, keep);
      return send(res, 200, { ok: true, llm: llm.describe() });
    }

    if (path === "/api/github" && req.method === "POST") {
      const b = await readBody(req, 8192);
      saveJson("github.json", { searchPerMin: Number(b.searchPerMin || 0), corePerHour: Number(b.corePerHour || 0) }, 0o600);
      gh = new GitHub(loadJson("github.json", {}));
      rateCache = { at: 0, data: null };
      return send(res, 200, { ok: true, github: gh.describe() });
    }

    /** 一发冒烟测试：确认 api 地址/key/模型真的能出 JSON，不用等扫描跑起来才发现配错。 */
    if (path === "/api/llm/test" && req.method === "POST") {
      const t0 = Date.now();
      try {
        const out = await llm.json([
          { role: "system", content: "只输出 JSON。" },
          { role: "user", content: '回复 {"ok":true,"n":42}' },
        ], { maxTokens: 200 });
        return send(res, 200, { ok: true, ms: Date.now() - t0, finishReason: out.finishReason, json: out.json, usage: out.usage, model: out.model });
      } catch (e) {
        return send(res, 200, { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 400) });
      }
    }

    // -------------------------------------------------------------- 维护配置
    if (path === "/api/config" && req.method === "POST") {
      const b = await readBody(req, 8192);
      if (b.seenRetentionDays !== undefined) cfg.seenRetentionDays = Math.max(0, Number(b.seenRetentionDays) || 0);
      if (b.maxDbMb !== undefined) cfg.maxDbMb = Math.max(0, Number(b.maxDbMb) || 0);
      saveJson("config.json", cfg, 0o600);
      return send(res, 200, { ok: true, config: cfg });
    }
    if (path === "/api/maintain" && req.method === "POST") {
      lastMaint = Object.assign({ at: Date.now() }, store.maintain(cfg));
      return send(res, 200, { ok: true, maintenance: lastMaint, db: store.stats() });
    }

    // ------------------------------------------------------------------ 任务
    if (path === "/api/runs" && req.method === "POST") {
      const b = await readBody(req, 65536);
      const goal = String(b.goal || "").trim();
      const keywords = String(b.keywords || "").trim();
      if (!goal) return send(res, 400, { ok: false, error: "查询目标不能为空" });
      if (!keywords) return send(res, 400, { ok: false, error: "关键词不能为空" });
      if (!llm.configured) return send(res, 400, { ok: false, error: "还没配置 LLM API（先填上面的表单并测试通过）" });
      // 【同目标并发护栏】。同一目标起多个 run 会各起一个扫描子进程，
      // 它们抢同一个 GitHub 额度、互相把对方刚占位的项目跳过去，
      // 结果是三个 run 都慢、都不完整（实测同时跑了 3 个）。
      // 分数缓存本来就保证重跑零成本，正确做法是让上一个跑完或先停掉它。
      const ghash = goalHash(goal, { lang: String(b.lang || ""), minStars: Number(b.minStars || 0), maxAgeDays: Number(b.maxAgeDays || 0) });
      if (!b.force) {
        const dup = store.listRuns(60).find(function (r) {
          return r.goal_hash === ghash && (r.status === "running" || r.status === "stopping");
        });
        if (dup) {
          return send(res, 409, {
            ok: false,
            error: "同目标的任务 #" + dup.id + " 正在运行（状态 " + dup.status + "）。" +
              "再起一个会两个进程抢同一个 GitHub 额度、互相拖慢。" +
              "请先停掉它，或等它跑完；确实要强行并行就带 force=true。",
            conflictRunId: dup.id,
          });
        }
      }
      const run = store.createRun({
        goal, keywords,
        mode: b.mode === "auto" ? "auto" : "target",
        wantN: Number(b.wantN || 20), threshold: Number(b.threshold === undefined ? 0.6 : b.threshold),
        concurrency: Number(b.concurrency || 3), funnel: b.funnel ? 1 : 0,
        coarseThreshold: Number(b.coarseThreshold === undefined ? 0.3 : b.coarseThreshold),
        minStars: Number(b.minStars || 0), maxAgeDays: Number(b.maxAgeDays || 0),
        lang: String(b.lang || ""), maxHits: Number(b.maxHits || 0),
      });
      // 同目标重跑：开局就把以前达标的搬进来，不必等扫描重新遇到它们。
      // 判据是【本次门槛】而不是「上次进没进」，所以改门槛也免费生效。
      let carried = 0;
      try { carried = store.carryOverHits(run.id, run.goal_hash, run.threshold); } catch (e) { /* 不影响新建 */ }
      if (carried) {
        store.bumpRun(run.id, { reused: carried, qualified: carried });
        pushLog(run.id, "── 同目标已有 " + carried + " 个达标项目，直接从分数缓存搬入（零 API 零 LLM）");
      }
      pushLog(run.id, "── 新建任务：" + goal.slice(0, 60) + " | 模式=" + run.mode + " 门槛=" + run.threshold + " n=" + run.want_n);
      spawnScan(run.id);
      return send(res, 200, { ok: true, run: store.getRun(run.id) });
    }

    let m;
    if ((m = path.match(/^\/api\/runs\/(\d+)\/stop$/)) && req.method === "POST") {
      const id = Number(m[1]);
      store.stopRun(id, "手动停止");
      stopScan(id);
      return send(res, 200, { ok: true, run: store.getRun(id) });
    }
    if ((m = path.match(/^\/api\/runs\/(\d+)$/)) && req.method === "GET") {
      const id = Number(m[1]);
      const run = store.getRun(id);
      if (!run) return send(res, 404, { ok: false, error: "任务不存在" });
      return send(res, 200, {
        ok: true, run, running: children.has(id),
        keywords: store.listKeywords(id, 300),
        histogram: store.scoreHistogram(id, 10),
        log: (logs.get(id) || []).slice(-100),
      });
    }

    // ------------------------------------------------------------------ 结果
    if (path === "/api/results" && req.method === "GET") {
      const runId = Number(url.searchParams.get("run") || 0);
      if (!runId) return send(res, 400, { ok: false, error: "缺 run 参数" });
      const rows = store.listHits(runId, {
        minScore: url.searchParams.get("minScore"),
        lang: url.searchParams.get("lang") || "",
        minStars: url.searchParams.get("minStars") || 0,
        q: url.searchParams.get("q") || "",
        limit: Math.min(2000, Number(url.searchParams.get("limit") || 200)),
      });
      return send(res, 200, { ok: true, run: store.getRun(runId), rows, total: store.countHits(runId) });
    }

    /** 导出 —— 结果页不能展开，但要能整批取走去逐个查。 */
    if (path === "/api/export" && req.method === "GET") {
      const runId = Number(url.searchParams.get("run") || 0);
      const fmt = (url.searchParams.get("format") || "md").toLowerCase();
      if (!runId) return send(res, 400, { ok: false, error: "缺 run 参数" });
      const run = store.getRun(runId);
      const rows = store.listHits(runId, {
        minScore: url.searchParams.get("minScore"),
        lang: url.searchParams.get("lang") || "",
        minStars: url.searchParams.get("minStars") || 0,
        q: url.searchParams.get("q") || "",
        limit: Math.min(5000, Number(url.searchParams.get("limit") || 1000)),
      });
      const stamp = "Github-search-run" + runId + "-" + new Date().toISOString().slice(0, 10);
      let body, type, ext;
      if (fmt === "json") {
        body = JSON.stringify({ run: { id: run.id, goal: run.goal, keywords: run.keywords, threshold: run.threshold, mode: run.mode, qualified: rows.length }, exportedAt: new Date().toISOString(), rows }, null, 2);
        type = "application/json; charset=utf-8"; ext = "json";
      } else if (fmt === "csv") {
        const head = ["排名", "分数", "仓库", "地址", "一句话介绍", "star", "语言", "最后更新", "描述"];
        const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
        body = "\uFEFF" + [head.map(esc).join(",")].concat(rows.map((r, i) => [i + 1, Number(r.score).toFixed(3), r.full_name, r.html_url, r.one_line, r.stars, r.lang, r.pushed, r.descr].map(esc).join(","))).join("\r\n");
        type = "text/csv; charset=utf-8"; ext = "csv";
      } else if (fmt === "txt") {
        body = "查询目标：" + run.goal + "\n关键词：" + run.keywords + "\n门槛：>=" + run.threshold + "   导出 " + rows.length + " 条\n\n" +
          rows.map((r, i) => (i + 1) + ". [" + Number(r.score).toFixed(2) + "] " + r.full_name + "  ★" + r.stars + "  " + (r.lang || "?") + "\n   " + r.one_line + "\n   " + r.html_url).join("\n\n") + "\n";
        type = "text/plain; charset=utf-8"; ext = "txt";
      } else {
        body = "# " + run.goal + "\n\n> 关键词：" + run.keywords + "　门槛：≥" + run.threshold + "　导出 " + rows.length + " 条　" + localStamp() + "\n\n" +
          "| # | 分数 | 仓库 | 一句话介绍 | ★ | 语言 | 最后更新 |\n|--:|--:|---|---|--:|---|---|\n" +
          rows.map((r, i) => "| " + (i + 1) + " | " + Number(r.score).toFixed(2) + " | [" + r.full_name + "](" + r.html_url + ") | " + String(r.one_line).replace(/\|/g, "\\|") + " | " + r.stars + " | " + (r.lang || "") + " | " + (r.pushed || "") + " |").join("\n") + "\n";
        type = "text/markdown; charset=utf-8"; ext = "md";
      }
      res.writeHead(200, { "Content-Type": type, "Content-Disposition": 'attachment; filename="' + stamp + "." + ext + '"', "Cache-Control": "no-store" });
      return res.end(body);
    }

    // ------------------------------------------------------------------ 静态
    if (path.startsWith("/web/")) {
      const rel = normalize(path.slice(5)).replace(/^(\.\.[\/\\])+/, "");
      const abs = join(ROOT, "src", "web", rel);
      if (!abs.startsWith(join(ROOT, "src", "web"))) { res.writeHead(403); return res.end("forbidden"); }
      const ext = abs.slice(abs.lastIndexOf("."));
      return serveFile(res, abs, MIME[ext] || "application/octet-stream");
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  } catch (e) {
    send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

/**
 * 启动时的对齐：不能无脑把所有 running 标成停止。
 * 扫描是独立子进程，服务重启时它可能还活着 —— 无脑标停会让它下一轮就自杀。
 * 这里按 runs.pid 判断存活：活着的接管（继续读库显示进度），死了的才收尾。
 * 注意接管的 run 拿不到 stdout 句柄，日志标签页会是空的，这是可接受的代价。
 */
const STALE_MS = 180000;   // 心跳 3 分钟没跳才算死
function reconcileRuns() {
  let adopted = 0, reaped = 0;
  for (const r of store.listRuns(200)) {
    if (r.status !== "running" && r.status !== "stopping") continue;
    if (!store.isStale(r.id, STALE_MS)) { adopted++; }
    else { store.finishRun(r.id, "心跳已停（服务重启时收尾）"); reaped++; }
  }
  return { adopted, reaped };
}
const rec = reconcileRuns();
if (rec.adopted || rec.reaped) console.log("[启动] 接管仍在运行的 " + rec.adopted + " 个扫描进程，收尾 " + rec.reaped + " 个已死的");

/** 被接管的 run 退出后没有 exit 回调，靠这里按 pid 兜底发现。 */
function sweepAdopted() {
  for (const r of store.listRuns(200)) {
    // stopping 也要收：子进程收到停止请求后自行退出，这里同样拿不到 exit 回调，
    // 不收尾就会永远卡在「停止中」——run#13 就是这么卡住的。
    if (r.status !== "running" && r.status !== "stopping") continue;
    if (children.has(r.id)) continue;
    if (!store.isStale(r.id, STALE_MS)) continue;
    if (r.status === "stopping") store.finishRun(r.id, r.stop_reason || "手动停止");
    else { store.finishRun(r.id, "心跳已停 3 分钟"); pushLog(r.id, "── 心跳停了，判定扫描进程已退出"); }
  }
}

server.listen(PORT, HOST, () => {
  const st = store.stats();
  console.log("Github-search 已启动  http://" + HOST + ":" + PORT);
  console.log("  库 " + st.file + "  " + (st.totalBytes / 1048576).toFixed(2) + "MB  seen=" + st.seen + "  hits=" + st.hits);
  console.log("  LLM " + (llm.configured ? llm.model + " @ " + llm.baseUrl : "【未配置】"));
  console.log("  GitHub " + (gh.configured ? "已认证" : "【未认证：搜索 10/分、core 60/时，且出口 IP 共享会 403】"));
  console.log("  磁盘阀门 保留 " + cfg.seenRetentionDays + " 天 / 上限 " + cfg.maxDbMb + "MB");
});

/**
 * 退出策略：**不杀正在跑的扫描**，让它们继续跑，重启服务后由心跳自动接管。
 * 理由：自动模式是奔着几天去的，重启一次服务就把扫描弄死等于白烧钱。
 * 扫描进程会脱离本进程被 init 收编，状态全在库里，不需要父进程活着。
 * 想真停就用界面上的「停止当前任务」，或 POST /api/runs/:id/stop。
 */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (children.size) {
      console.log("[退出] " + children.size + " 个扫描子进程继续运行（脱离本进程）；重启服务会自动接管");
    }
    try { store.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  });
}
