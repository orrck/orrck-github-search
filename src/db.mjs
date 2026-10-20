/**
 * SQLite 存储层。
 *
 * 磁盘无限增长只可能来自一张表：seen（每看过一个项目就 +1 行）。
 *   - 实测 1 行 ≈ 27 字节（repo_id + goal_hash + state + score + ts）
 *   - hits 不是问题：门槛本身就是过滤器，过门槛的天然稀少
 *   - frontier 有硬上限（词数 ≤ 200、深度 ≤ 2）
 * 所以维护任务只盯 seen：保留期 + 库体积上限，双保险。
 */
import { DatabaseSync } from "node:sqlite";
import { statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 2;

export function goalHash(goal, opts) {
  const o = opts || {};
  const sig = [String(goal || "").trim().toLowerCase(), o.lang || "", o.minStars || 0, o.maxAgeDays || 0, o.extra || ""].join("|");
  return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

const now = () => Date.now();

export class Store {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    const fresh = !exists(file);
    this.db = new DatabaseSync(file);
    // 顺序有讲究：auto_vacuum 必须在建第一张表之前设，事后改要整库 VACUUM。
    if (fresh) this.db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    // WAL 默认不封顶。实测：关掉自动 checkpoint 后，写入 50 次×2000 行
    // 产生 98MB WAL 而主库还是 0 —— WAL 一个人就能吃光磁盘。
    this.db.exec("PRAGMA journal_size_limit=16777216");
    this.db.exec("PRAGMA wal_autocheckpoint=1000");
    this.db.exec("PRAGMA cache_size=-2000");   // 页缓存封顶 2MB
    this.db.exec("PRAGMA mmap_size=0");        // 映射页算进 RSS，内存封顶的进程必须关
    this.db.exec("PRAGMA busy_timeout=8000");  // 服务端与扫描子进程是两个进程，必须等锁
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL, goal_hash TEXT NOT NULL, keywords TEXT NOT NULL,
        mode TEXT DEFAULT 'target', want_n INTEGER DEFAULT 20, threshold REAL DEFAULT 0.6,
        concurrency INTEGER DEFAULT 3, funnel INTEGER DEFAULT 0, coarse_threshold REAL DEFAULT 0.3,
        min_stars INTEGER DEFAULT 0, max_age_days INTEGER DEFAULT 0, lang TEXT DEFAULT '',
        max_hits INTEGER DEFAULT 0, max_keywords INTEGER DEFAULT 200, max_depth INTEGER DEFAULT 2,
        status TEXT DEFAULT 'running', stop_reason TEXT,
        scanned INTEGER DEFAULT 0, scored INTEGER DEFAULT 0, qualified INTEGER DEFAULT 0,
        rejected INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, reused INTEGER DEFAULT 0,
        started_at INTEGER, ended_at INTEGER, last_tick INTEGER, pid INTEGER,
        stats TEXT
      );
      CREATE TABLE IF NOT EXISTS frontier(
        run_id INTEGER NOT NULL, q TEXT NOT NULL, page INTEGER DEFAULT 1,
        origin TEXT DEFAULT 'user', depth INTEGER DEFAULT 0,
        hits INTEGER DEFAULT 0, dry INTEGER DEFAULT 0, total_count INTEGER DEFAULT 0,
        retired INTEGER DEFAULT 0, created_at INTEGER,
        PRIMARY KEY(run_id, q)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ix_frontier_run ON frontier(run_id, retired, page);
      CREATE TABLE IF NOT EXISTS seen(
        repo_id INTEGER NOT NULL, gh TEXT NOT NULL, run_id INTEGER NOT NULL,
        state TEXT NOT NULL, score REAL, ts INTEGER NOT NULL,
        PRIMARY KEY(repo_id, gh)
      ) WITHOUT ROWID;
      -- 只留这一个索引。40 万行实测每行字节数：
      --   无索引 58B | 只有 ts 94B | run+ts 125B | run+ts+state 162B
      -- 按 run 的进度统计改放 runs 行里的计数器，省掉 42% 体积。
      CREATE INDEX IF NOT EXISTS ix_seen_ts ON seen(ts);
      CREATE TABLE IF NOT EXISTS hits(
        run_id INTEGER NOT NULL, repo_id INTEGER NOT NULL,
        full_name TEXT NOT NULL, html_url TEXT NOT NULL,
        score REAL NOT NULL, one_line TEXT NOT NULL,
        stars INTEGER, lang TEXT, pushed TEXT, descr TEXT, topics TEXT, readme_len INTEGER,
        ts INTEGER NOT NULL,
        PRIMARY KEY(run_id, repo_id)
      );
      CREATE INDEX IF NOT EXISTS ix_hits_rank ON hits(run_id, score DESC, stars DESC);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    `);
    this.db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('schema',?)").run(String(SCHEMA_VERSION));
    // seen 行数用 meta 计数器维护：stats() 每 5 秒被界面轮询一次，
    // 不能每次都 COUNT(*) 全表扫（40 万行 = 0.3 秒，轮询会拖垮进程）。
    // token 统计：LLM 调用发生在扫描子进程里，服务端看不到，所以落库由子进程写。
    // 用 ALTER 是为了兼容已经建好的库。
    for (const col of ["llm_calls INTEGER DEFAULT 0", "tokens_in INTEGER DEFAULT 0",
                       "tokens_out INTEGER DEFAULT 0", "tokens_cached INTEGER DEFAULT 0"]) {
      try { this.db.exec("ALTER TABLE runs ADD COLUMN " + col); } catch (e) { /* 已存在 */ }
    }
    if (this.metaGet("seen_total") === null) {
      this.db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('seen_total',?)")
        .run(String(Number(this.db.prepare("SELECT COUNT(*) c FROM seen").get().c || 0)));
    }
  }

  metaGet(k) { const r = this.db.prepare("SELECT v FROM meta WHERE k=?").get(String(k)); return r ? r.v : null; }
  metaBump(k, delta) {
    if (!delta) return;
    this.db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+? AS TEXT)")
      .run(String(k), String(delta), Number(delta));
  }

  // ---------------------------------------------------------------- runs
  createRun(r) {
    const t = now();
    /*
      【第四轮盲审】门槛默认值必须用「缺省才取默认」而不是 `||`。
      `Number(r.threshold || 0.6)` 会把用户显式填的 0 变成 0.6 —— 而界面的输入框
      允许 min=0，语义上「0 = 门槛不拦任何东西」。被悄悄改成 0.6/0.3 属于静默改需求。
    */
    const pick = (v, d) => (v === undefined || v === null || v === "") ? d : Number(v);
    const h = goalHash(r.goal, r);
    const info = this.db.prepare(`INSERT INTO runs(goal,goal_hash,keywords,mode,want_n,threshold,
        concurrency,funnel,coarse_threshold,min_stars,max_age_days,lang,max_hits,max_keywords,max_depth,
        status,started_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'running', ?)`).run(
      String(r.goal || ""), h, String(r.keywords || ""), r.mode === "auto" ? "auto" : "target",
      Number(r.wantN || 20), pick(r.threshold, 0.6), Number(r.concurrency || 3),
      r.funnel ? 1 : 0, pick(r.coarseThreshold, 0.3), Number(r.minStars || 0),
      Number(r.maxAgeDays || 0), String(r.lang || ""), Number(r.maxHits || 0),
      Number(r.maxKeywords || 200), Number(r.maxDepth || 2), t);
    const id = Number(info.lastInsertRowid);
    this.addKeywords(id, splitKeywords(r.keywords), "user", 0);
    return this.getRun(id);
  }

  getRun(id) {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(Number(id));
    if (!r) return null;
    const f = this.db.prepare("SELECT COUNT(*) c, SUM(retired) ret, SUM(hits) h FROM frontier WHERE run_id=?").get(Number(id));
    r.frontier = { total: Number(f.c || 0), retired: Number(f.ret || 0), hits: Number(f.h || 0) };
    return r;
  }

  listRuns(limit) {
    return this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(Number(limit || 30));
  }

  patchRun(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => k + "=?").join(",");
    this.db.prepare("UPDATE runs SET " + sets + " WHERE id=?").run(...keys.map((k) => fields[k]), Number(id));
  }

  bumpRun(id, delta) {
    const cols = Object.keys(delta);
    if (!cols.length) return;
    const sets = cols.map((c) => c + "=" + c + "+?").join(",");
    this.db.prepare("UPDATE runs SET " + sets + ", last_tick=? WHERE id=?").run(...cols.map((c) => Number(delta[c]) || 0), now(), Number(id));
  }

  stopRun(id, reason, status) {
    this.patchRun(id, { status: status || "stopping", stop_reason: reason || "手动停止" });
  }

  /**
   * 心跳。判断"扫描进程还活着吗"不能靠 process.kill(pid, 0)：
   * 实测在后台任务/命名空间边界下它会抛 ESRCH，把正在跑的扫描误判成已死并弄停。
   * 心跳只依赖数据库，跨进程跨命名空间都成立。
   */
  touch(id) { this.db.prepare("UPDATE runs SET last_tick=? WHERE id=?").run(now(), Number(id)); }

  /** 心跳超过 staleMs 没跳 = 进程真的没了。 */
  isStale(id, staleMs) {
    const r = this.db.prepare("SELECT last_tick FROM runs WHERE id=?").get(Number(id));
    if (!r || !r.last_tick) return true;
    return now() - Number(r.last_tick) > Number(staleMs || 180000);
  }

  /**
   * 收尾。status 决定前端画什么颜色 —— 这是三种【语义不同】的结局：
   *   done    跑到了目标 / 前沿枯竭 / 测试上限 —— 正常结束，前端绿点「已完成」
   *   failed  进程异常退出 / 重启失控 —— 前端红点「失败」
   *   stopped 用户手动停 / 服务重启收尾 —— 前端灰点「已停止」
   * 历史遗留：早期只有 stopped 一种终态，导致前端 done/failed 两个分支是死代码，
   * 「凑够了 20 个」和「扫描进程崩了」在界面上长得一模一样。
   * 默认 stopped 是为了兼容旧调用点（reapStaleRuns 等）不必全改。
   */
  finishRun(id, reason, status) {
    this.patchRun(id, {
      status: status || "stopped",
      stop_reason: reason || "",
      ended_at: now(),
    });
  }

  /** 扫描子进程每轮开头问一次：还是 running 就继续，否则收工退出。 */
  isStopRequested(id) {
    const r = this.db.prepare("SELECT status FROM runs WHERE id=?").get(Number(id));
    return !r || r.status !== "running";
  }

  /** 上次进程崩了留下的 running 状态，启动时清掉，避免界面显示假的"运行中"。 */
  reapStaleRuns() {
    const rows = this.db.prepare("SELECT id FROM runs WHERE status IN ('running','stopping')").all();
    for (const r of rows) this.finishRun(r.id, "服务重启，标记为已停止");
    return rows.length;
  }

  // ------------------------------------------------------------ frontier
  addKeywords(runId, list, origin, depth) {
    const ins = this.db.prepare("INSERT OR IGNORE INTO frontier(run_id,q,page,origin,depth,created_at) VALUES(?,?,1,?,?,?)");
    let added = 0;
    const t = now();
    this.db.exec("BEGIN");
    try {
      for (const q of list) {
        const s = String(q || "").trim().slice(0, 240);
        if (!s) continue;
        const info = ins.run(Number(runId), s, origin || "user", Number(depth || 0), t);
        if (Number(info.changes) > 0) added++;
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return added;
  }

  countKeywords(runId) {
    const r = this.db.prepare("SELECT COUNT(*) c FROM frontier WHERE run_id=?").get(Number(runId));
    return Number(r.c || 0);
  }

  /** 是否已经做过 LLM 扩词（depth>=1）。子进程回收重启时用它避免重复扩词。 */
  hasExpanded(runId) {
    const r = this.db.prepare("SELECT COUNT(*) c FROM frontier WHERE run_id=? AND depth>=1").get(Number(runId));
    return Number(r.c || 0) > 0;
  }

  nextKeyword(runId) {
    return this.db.prepare(`SELECT * FROM frontier WHERE run_id=? AND retired=0
      ORDER BY page ASC, depth ASC, created_at ASC LIMIT 1`).get(Number(runId)) || null;
  }

  advanceKeyword(runId, q, totalCount) {
    this.db.prepare("UPDATE frontier SET page=page+1, total_count=? WHERE run_id=? AND q=?")
      .run(Number(totalCount || 0), Number(runId), String(q));
  }

  /** 这一页产出为零 → dry+1；连续两页空就退休，不再浪费额度。 */
  keywordYield(runId, q, got, admitted) {
    const row = this.db.prepare("SELECT dry FROM frontier WHERE run_id=? AND q=?").get(Number(runId), String(q));
    if (!row) return;
    const dry = admitted > 0 ? 0 : Number(row.dry || 0) + 1;
    this.db.prepare("UPDATE frontier SET dry=?, hits=hits+?, retired=CASE WHEN ?>=2 THEN 1 ELSE retired END WHERE run_id=? AND q=?")
      .run(dry, Number(admitted || 0), dry, Number(runId), String(q));
  }

  retireKeyword(runId, q, why) {
    this.db.prepare("UPDATE frontier SET retired=1 WHERE run_id=? AND q=?").run(Number(runId), String(q));
  }

  listKeywords(runId, limit) {
    return this.db.prepare("SELECT * FROM frontier WHERE run_id=? ORDER BY retired ASC, hits DESC, page ASC LIMIT ?")
      .all(Number(runId), Number(limit || 300));
  }

  // ---------------------------------------------------------------- seen
  /** 占位。返回 true = 第一次见（该花 LLM 钱了）。 */
  claim(repoId, gh, runId) {
    const info = this.db.prepare("INSERT OR IGNORE INTO seen(repo_id,gh,run_id,state,ts) VALUES(?,?,?,'claimed',?)")
      .run(Number(repoId), String(gh), Number(runId), now());
    const added = Number(info.changes) > 0;
    if (added) this.metaBump("seen_total", 1);
    return added;
  }

  lookSeen(repoId, gh) {
    return this.db.prepare("SELECT state,score FROM seen WHERE repo_id=? AND gh=?").get(Number(repoId), String(gh)) || null;
  }

  markScored(repoId, gh, score, state) {
    this.db.prepare("UPDATE seen SET state=?, score=?, ts=? WHERE repo_id=? AND gh=?")
      .run(state, score === null || score === undefined ? null : Number(score), now(), Number(repoId), String(gh));
  }

  /**
   * 把没评成功的行删掉，放回重试队列。
   * claimed = 进程中途崩了；failed = LLM 输出被截断或解析失败。
   * 两种都不能算"已评过"，否则那批项目被静默吃掉
   * （nof1 上实测过：输出预算太小导致 22% 的生成 finish_reason=length、可见内容为空）。
   */
  reclaimStale(gh, minutes) {
    const cutoff = now() - Number(minutes || 30) * 60000;
    const info = this.db.prepare("DELETE FROM seen WHERE gh=? AND state IN ('claimed','failed') AND ts<?").run(String(gh), cutoff);
    const n = Number(info.changes || 0);
    if (n) this.metaBump("seen_total", -n);
    return n;
  }

  /**
   * 回收【属主已死】的占位行。
   *
   * reclaimStale 是按「目标 + 30 分钟」回收的，所以另一个目标留下的占位
   * 在 30 分钟内碰不到 —— 而 lookSeen 只看 score，这些行 score 为 null，
   * 于是同目标重跑时它们会被【静默跳过】（实测残留了 193 条，最老 60 分钟）。
   *
   * 这里换一个无懈可击的判据：占位行的属主 run 已经不在跑了。
   * 属主死了就等于没人认领，回收它不可能造成重复评分 ——
   * 不像「按时间抢」，那会在并发同目标时误伤正在跑的那一轮。
   */
  reclaimDeadOwners(gh) {
    const info = this.db.prepare(
      "DELETE FROM seen WHERE gh=? AND state IN ('claimed','failed') " +
      "AND run_id IN (SELECT id FROM runs WHERE status NOT IN ('running','stopping'))"
    ).run(String(gh));
    const n = Number(info.changes || 0);
    if (n) this.metaBump("seen_total", -n);
    return n;
  }

  seenTotal() { return Number(this.metaGet("seen_total") || 0); }

  /**
   * 回收【本 run】所有在飞未决的行（claimed / failed）。
   * 扫描进程启动时调用：此刻本 run 不可能有别的属主，所以无脑回收是安全的
   * —— 被强杀时 buf 里那些已 claim 但没来得及评分的项目，否则会因为
   * lookSeen 只看 score 而被静默跳过。
   */
  reclaimRun(runId) {
    const info = this.db.prepare("DELETE FROM seen WHERE run_id=? AND state IN ('claimed','failed')").run(Number(runId));
    const n = Number(info.changes || 0);
    if (n) this.metaBump("seen_total", -n);
    return n;
  }

  /** 分数直方图 —— 判断"这个分数有没有区分力"用。 */
  scoreHistogram(runId, buckets) {
    const n = Number(buckets || 10);
    const rows = this.db.prepare("SELECT score FROM seen WHERE run_id=? AND score IS NOT NULL").all(Number(runId));
    const bins = new Array(n).fill(0);
    let sum = 0, max = -1, min = 2;
    for (const r of rows) {
      const s = Number(r.score);
      sum += s;
      if (s > max) max = s;
      if (s < min) min = s;
      const i = Math.max(0, Math.min(n - 1, Math.floor(s * n)));
      bins[i]++;
    }
    const mean = rows.length ? sum / rows.length : 0;
    let varAcc = 0;
    for (const r of rows) varAcc += Math.pow(Number(r.score) - mean, 2);
    const sd = rows.length ? Math.sqrt(varAcc / rows.length) : 0;
    return { n: rows.length, bins, min: rows.length ? min : null, max: rows.length ? max : null, mean, sd };
  }

  // ---------------------------------------------------------------- hits
  addHit(runId, it, score, oneLine) {
    this.db.prepare(`INSERT OR REPLACE INTO hits(run_id,repo_id,full_name,html_url,score,one_line,
        stars,lang,pushed,descr,topics,readme_len,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      Number(runId), Number(it.id), String(it.full_name), String(it.html_url),
      Number(score), String(oneLine).slice(0, 160),
      Number(it.stars || 0), String(it.lang || ""), String(it.pushed || ""),
      String(it.desc || "").slice(0, 300), JSON.stringify(it.topics || []),
      Number(it.readmeLen || 0), now());
    const capRow = this.db.prepare("SELECT max_hits FROM runs WHERE id=?").get(Number(runId));
    const cap = capRow ? Number(capRow.max_hits || 0) : 0;
    if (cap > 0) {
      // 结果上限（0 = 不限）。默认不限：门槛本身就是过滤器，过门槛的稀少，且这正是用户要的产出。
      this.db.prepare(`DELETE FROM hits WHERE run_id=? AND repo_id NOT IN
        (SELECT repo_id FROM hits WHERE run_id=? ORDER BY score DESC, stars DESC LIMIT ?)`).run(Number(runId), Number(runId), cap);
    }
  }

  /**
   * 复用已打过分的结果：把别处存的 (score, one_line) 拷进本次 run，零 API 零 LLM。
   * 这条正好兑现"打完分只留一句话+仓库"——留下的两个字段就是重跑需要的全部。
   */
  copyHit(runId, repoId) {
    const info = this.db.prepare(`INSERT OR REPLACE INTO hits(run_id,repo_id,full_name,html_url,score,one_line,
        stars,lang,pushed,descr,topics,readme_len,ts)
      SELECT ?, repo_id, full_name, html_url, score, one_line, stars, lang, pushed, descr, topics, readme_len, ?
      FROM hits WHERE repo_id=? ORDER BY ts ASC LIMIT 1`).run(Number(runId), now(), Number(repoId));
    return Number(info.changes || 0) > 0;
  }

  /**
   * 同目标重跑时，把以前达标的项目【直接搬进新 run】—— 零 API、零 LLM。
   *
   * copyHit 只在扫描重新遇到某个仓库时才复用，意味着重跑同目标要从头再搜一遍
   * 才能把旧成果捡回来。但分数缓存的意义恰恰是「不用再搜」：
   * seen 里存着 (repo_id → score)，直接按【本次门槛】复判、整批搬过来就行。
   *
   * 顺带把门槛的变化也免费处理了：
   *   门槛调高 → 低分的自然被筛掉
   *   门槛调低 → 以前被拒的、分数够的，这次直接进来
   * 因为这里的判据是 score >= 本次 threshold，而不是「上次进没进」。
   */
  carryOverHits(runId, goalHash, threshold) {
    const info = this.db.prepare(`INSERT OR REPLACE INTO hits(run_id,repo_id,full_name,html_url,score,one_line,
        stars,lang,pushed,descr,topics,readme_len,ts)
      SELECT ?, h.repo_id, h.full_name, h.html_url, h.score, h.one_line,
             h.stars, h.lang, h.pushed, h.descr, h.topics, h.readme_len, ?
      FROM hits h
      WHERE h.repo_id IN (SELECT repo_id FROM seen WHERE gh=? AND score IS NOT NULL AND score>=?)
      GROUP BY h.repo_id`)
      .run(Number(runId), now(), String(goalHash), Number(threshold));
    // GROUP BY 不能省：hits 里同一个仓库在每个历史 run 各有一行，
    // 不加的话 SELECT 会返回 N 倍的行数，而 INSERT OR REPLACE 每次覆盖都计一次
    // changes —— 数据是对的（主键去重），但返回的计数会被放大
    //（实测报 26、实际 10）。这个数会写进 reused/qualified 显示给用户。
    return Number(info.changes || 0);
  }

  countHits(runId) {
    return Number(this.db.prepare("SELECT COUNT(*) c FROM hits WHERE run_id=?").get(Number(runId)).c || 0);
  }

  listHits(runId, opt) {
    const o = opt || {};
    const where = ["run_id=?"];
    const args = [Number(runId)];
    if (o.minScore !== undefined && o.minScore !== null && o.minScore !== "") { where.push("score>=?"); args.push(Number(o.minScore)); }
    if (o.lang) { where.push("lang=?"); args.push(String(o.lang)); }
    if (o.minStars) { where.push("stars>=?"); args.push(Number(o.minStars)); }
    if (o.q) { where.push("(full_name LIKE ? OR one_line LIKE ? OR descr LIKE ?)"); const like = "%" + o.q + "%"; args.push(like, like, like); }
    args.push(Number(o.limit || 200));
    return this.db.prepare("SELECT * FROM hits WHERE " + where.join(" AND ") + " ORDER BY score DESC, stars DESC LIMIT ?").all(...args);
  }

  // ----------------------------------------------------------- 维护
  fileSizes() {
    const g = (p) => { try { return statSync(p).size; } catch (e) { return 0; } };
    return { main: g(this.file), wal: g(this.file + "-wal"), shm: g(this.file + "-shm") };
  }

  stats() {
    const s = this.fileSizes();
    const c = (t) => Number(this.db.prepare("SELECT COUNT(*) c FROM " + t).get().c || 0);
    return {
      file: this.file, mainBytes: s.main, walBytes: s.wal, totalBytes: s.main + s.wal,
      runs: c("runs"), frontier: c("frontier"), seen: this.seenTotal(), hits: c("hits"),
      pageCount: Number(this.db.prepare("PRAGMA page_count").get().page_count || 0),
      freelist: Number(this.db.prepare("PRAGMA freelist_count").get().freelist_count || 0),
      autoVacuum: Number(this.db.prepare("PRAGMA auto_vacuum").get().auto_vacuum || 0),
    };
  }

  /**
   * 维护：只盯 seen 这一张会无限长的表。
   *   A) 保留期：超过 N 天的删除（正在跑的 run 不动）
   *   B) 体积上限：超了就按时间从旧到新整批删
   *   C) 删完 incremental_vacuum 还页 + WAL TRUNCATE（DELETE 本身不会让文件变小）
   */
  maintain(opt) {
    const o = opt || {};
    const retentionDays = Number(o.seenRetentionDays || 0);
    const maxBytes = Number(o.maxDbMb || 0) * 1048576;
    const out = { byAge: 0, bySize: 0, vacuumed: 0, before: 0, after: 0 };
    out.before = this.fileSizes().main;
    const active = this.db.prepare("SELECT id FROM runs WHERE status IN ('running','stopping')").all().map((r) => Number(r.id));
    const notActive = active.length ? " AND run_id NOT IN (" + active.join(",") + ")" : "";

    if (retentionDays > 0) {
      const cutoff = now() - retentionDays * 86400000;
      const info = this.db.prepare("DELETE FROM seen WHERE ts<?" + notActive).run(cutoff);
      out.byAge = Number(info.changes || 0);
    }
    if (maxBytes > 0 && this.fileSizes().main > maxBytes) {
      // 一轮删 5 万行，删到降下来为止；每轮都重新看文件大小
      for (let round = 0; round < 200; round++) {
        if (this.fileSizes().main <= maxBytes) break;
        const info = this.db.prepare(`DELETE FROM seen WHERE (repo_id,gh) IN
          (SELECT repo_id,gh FROM seen WHERE 1=1` + notActive + " ORDER BY ts ASC LIMIT 50000)").run();
        const n = Number(info.changes || 0);
        out.bySize += n;
        if (n === 0) break;
      }
    }
    const removed = out.byAge + out.bySize;
    if (removed > 0) {
      this.metaBump("seen_total", -removed);
      // DELETE 不会让文件变小，必须显式还页（auto_vacuum=INCREMENTAL 才有效）
      const free = Number(this.db.prepare("PRAGMA freelist_count").get().freelist_count || 0);
      if (free > 0) {
        try { this.db.exec("PRAGMA incremental_vacuum(" + Math.min(free, 20000) + ")"); out.vacuumed = free; }
        catch (e) { out.vacuumed = -1; }
      }
    }
    this.checkpoint();
    out.after = this.fileSizes().main;
    return out;
  }

  checkpoint() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { /* 有读事务时截断不了，下轮再来 */ }
  }

  close() { try { this.checkpoint(); } catch (e) { /* ignore */ } try { this.db.close(); } catch (e) { /* ignore */ } }
}

function exists(p) {
  try { statSync(p); return true; } catch (e) { return false; }
}

export function splitKeywords(text) {
  return String(text || "")
    .split(/[\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
