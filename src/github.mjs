/**
 * GitHub 客户端 —— 三个职责，一个都不能少：
 *   1) 限流感知：搜索 30/分、core 5000/时（未认证 10/分、60/时，且出口 IP 共享会 403）
 *      —— 用令牌桶主动排队，再按响应头被动纠偏，免费额度下这是常态而非异常。
 *   2) 【省内存 M1】搜索响应 556KB/100条、每条 82 个字段，
 *      在收到的那一刻就投影成 11 个字段（366 字节），原始 JSON 立刻出作用域。
 *   3) 【省内存 M2】README 平均 16.3KB（实测 8.0–25.3KB），
 *      用流式读取读到 4KB 就 cancel，不是读完再截。
 */
import { findKey, keySource, missingKeyHint } from "./keys.mjs";

const API = "https://api.github.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 令牌桶：匀速放行，突发有上限。 */
class Bucket {
  static forRate(perSec, burstSec) {
    const cap = Math.max(1, Math.min(8, Math.ceil(perSec * (burstSec || 5))));
    return new Bucket(cap, perSec);
  }
  constructor(capacity, perMs) {
    this.cap = capacity;
    this.perMs = perMs;          // 每秒补充多少
    this.tokens = capacity;
    this.last = Date.now();
  }
  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.perMs);
    this.last = now;
  }
  async take(isCancelled) {
    for (;;) {
      if (isCancelled && isCancelled()) { const e = new Error("已取消"); e.cancelled = true; throw e; }
      this.#refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const need = (1 - this.tokens) / this.perMs;
      await sleep(Math.max(20, Math.min(1000, Math.ceil(need * 1000))));
    }
  }
  /** 被服务端告知还有多久才能继续时，直接把桶清空。 */
  penalize(ms) {
    this.tokens = 0;
    this.last = Date.now() + ms;
  }
  get available() { this.#refill(); return Math.floor(this.tokens); }
}

/** 只保留有用字段 —— 这是 5.4KB/条 → 366字节/条的边界。 */
function project(it) {
  return {
    id: it.id,
    full_name: it.full_name || "",
    html_url: it.html_url || ("https://github.com/" + (it.full_name || "")),
    desc: String(it.description || "").slice(0, 300),
    stars: Number(it.stargazers_count || 0),
    forks: Number(it.forks_count || 0),
    lang: String(it.language || ""),
    pushed: String(it.pushed_at || "").slice(0, 10),
    created: String(it.created_at || "").slice(0, 10),
    sizeKb: Number(it.size || 0),
    fork: Boolean(it.fork),
    archived: Boolean(it.archived),
    topics: Array.isArray(it.topics) ? it.topics.slice(0, 8) : [],
  };
}

/** README 里对判断没用的噪声：徽章行、纯图片行、HTML 注释、连续空行。 */
export function cleanReadme(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((ln) => {
      const s = ln.trim();
      if (!s) return true;
      if (/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)$/.test(s)) return false;   // [![alt](img)](link)
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(s)) return false;                      // ![alt](img)
      if (/^<p align="center">/i.test(s)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class GitHub {
  constructor(cfg) {
    cfg = cfg || {};
    this.token = cfg.token !== undefined ? cfg.token : findKey("GITHUB_TOKEN");
    this.tokenSource = cfg.token !== undefined ? "(显式传入)" : keySource("GITHUB_TOKEN");
    const authed = Boolean(this.token);
    // 官方文档值：认证 30 搜索/分、5000 core/时；未认证 10/分、60/时。
    // 留一成余量，避免卡在边界上被 403。
    const spm = cfg.searchPerMin || (authed ? 26 : 8);
    const cph = cfg.corePerHour || (authed ? 4500 : 55);
    this.searchBucket = Bucket.forRate(spm / 60);
    this.coreBucket = Bucket.forRate(cph / 3600);
    this.stats = {
      searches: 0, readmes: 0, readmeMiss: 0, errors: 0, rateLimited: 0,
      bytesIn: 0, bytesSaved: 0, lastReset: 0, searchRemaining: null, coreRemaining: null,
      lastError: "",
    };
    this.lastRateLimit = null;
  }

  get configured() { return Boolean(this.token); }

  header(accept) {
    const h = { "User-Agent": "ghscan/1.0", "Accept": accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.token) h.Authorization = "Bearer " + this.token;
    return h;
  }

  /** 记录每次响应头里的额度，用于界面显示与被动纠偏。 */
  #observe(res) {
    const rem = res.headers.get("x-ratelimit-remaining");
    const lim = res.headers.get("x-ratelimit-limit");
    const reset = res.headers.get("x-ratelimit-reset");
    const resType = res.headers.get("x-ratelimit-resource") || "core";
    if (rem !== null) {
      this.stats.lastReset = Number(reset || 0) * 1000;
      if (resType === "search") this.stats.searchRemaining = Number(rem);
      else this.stats.coreRemaining = Number(rem);
      if (Number(rem) === 0 && Number(reset)) {
        const waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
        (resType === "search" ? this.searchBucket : this.coreBucket).penalize(waitMs);
      }
    }
    return { rem: rem === null ? null : Number(rem), limit: lim === null ? null : Number(lim), reset: reset === null ? null : Number(reset), resource: resType };
  }

  async #fetch(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 30000);
    try {
      const res = await fetch(url, { headers: (opts && opts.headers) || this.header(), signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /rate_limit —— 这个端点不计入额度，可以随时查。 */
  async probeRateLimit() {
    try {
      const res = await this.#fetch(API + "/rate_limit", { timeoutMs: 10000 });
      const j = await res.json();
      this.lastRateLimit = {
        authed: Boolean(this.token),
        core: j.resources && j.resources.core,
        search: j.resources && j.resources.search,
        checkedAt: Date.now(),
      };
      return this.lastRateLimit;
    } catch (e) {
      this.lastRateLimit = { authed: Boolean(this.token), error: e.message, checkedAt: Date.now() };
      return this.lastRateLimit;
    }
  }

  /** 按查询串的 q 参数直接构造 URL，避免二次编码问题。 */
  #searchUrl(q, page, perPage) {
    return API + "/search/repositories?q=" + encodeURIComponent(q) +
      "&per_page=" + (perPage || 100) + "&page=" + (page || 1);
  }

  /**
   * 搜索。返回投影后的数组（每条 366 字节），原始 556KB JSON 不返回给调用方。
   * @returns {Promise<{items:Array, totalCount:number, incomplete:boolean}>}
   */
  async search(q, page, perPage, isCancelled) {
    await this.searchBucket.take(isCancelled);
    const url = this.#searchUrl(q, page, perPage);
    let res;
    try {
      res = await this.#fetch(url, { timeoutMs: 30000 });
    } catch (e) {
      this.stats.errors++;
      const err = new Error("搜索请求失败: " + e.message);
      err.retryable = true;
      throw err;
    }
    const info = this.#observe(res);
    this.stats.searches++;

    if (res.status === 422) {
      // "Only the first 1000 search results are available" —— 该 query 已翻到底
      const body = await res.text();
      const err = new Error("该查询已到 GitHub 1000 条上限（HTTP 422）: " + body.slice(0, 120));
      err.exhausted = true;
      return { items: [], totalCount: 0, incomplete: false, exhausted: true, rateInfo: info };
    }
    if (res.status === 403 || res.status === 429) {
      const body = await res.text();
      this.stats.rateLimited++;
      const ra = Number(res.headers.get("retry-after"));
      let waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
      if (!waitMs && info.reset) waitMs = Math.max(1000, info.reset * 1000 - Date.now() + 1000);
      if (!waitMs) waitMs = 60000;
      waitMs = Math.min(waitMs, 15 * 60 * 1000);
      this.searchBucket.penalize(waitMs);
      const err = new Error("GitHub 拒绝（HTTP " + res.status + "）: " + body.slice(0, 160) + " —— 等待 " + Math.round(waitMs / 1000) + "s 后重试");
      err.retryable = true;
      err.waitMs = waitMs;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text();
      this.stats.errors++;
      const err = new Error("搜索失败 HTTP " + res.status + ": " + body.slice(0, 200));
      err.retryable = res.status >= 500;
      throw err;
    }

    const text = await res.text();
    this.stats.bytesIn += text.length;
    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      this.stats.errors++;
      throw new Error("搜索返回非 JSON: " + text.slice(0, 200));
    }
    const raw = Array.isArray(json.items) ? json.items : [];
    // 投影 ⇒ 之后 raw 就可以被回收；原始 82 字段一个都不外流
    const items = raw.map(project);
    this.stats.bytesSaved += Math.max(0, text.length - items.length * 366);
    return { items, totalCount: Number(json.total_count || 0), incomplete: Boolean(json.incomplete_results), exhausted: false, rateInfo: info };
  }

  /**
   * 取 README，流式截断到 maxBytes（默认 4KB）。
   * 平均 16.3KB、最大 25.3KB 的正文在这里被挡在内存之外。
   */
  async readme(fullName, maxBytes, isCancelled) {
    const cap = maxBytes || 4096;
    await this.coreBucket.take(isCancelled);
    let res;
    try {
      res = await this.#fetch(API + "/repos/" + fullName + "/readme", {
        headers: this.header("application/vnd.github.raw"),
        timeoutMs: 25000,
      });
    } catch (e) {
      this.stats.errors++;
      return "";
    }
    this.#observe(res);
    if (res.status === 404) { this.stats.readmeMiss++; return ""; }
    if (res.status === 403 || res.status === 429) {
      this.stats.rateLimited++;
      const info = { reset: Number(res.headers.get("x-ratelimit-reset") || 0) };
      let waitMs = info.reset ? Math.max(1000, info.reset * 1000 - Date.now() + 1000) : 60000;
      waitMs = Math.min(waitMs, 15 * 60 * 1000);
      this.coreBucket.penalize(waitMs);
      const err = new Error("取 README 被拒（HTTP " + res.status + "）—— 等待 " + Math.round(waitMs / 1000) + "s");
      err.retryable = true;
      err.waitMs = waitMs;
      throw err;
    }
    if (!res.ok) { this.stats.errors++; return ""; }

    // 流式读，读满就 cancel —— 不把整篇 README 读进内存
    let got = 0;
    const chunks = [];
    try {
      const reader = res.body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        const room = cap - got;
        if (room <= 0) { try { await reader.cancel(); } catch (e) { /* 已断开 */ } break; }
        const buf = Buffer.from(step.value);
        const slice = buf.subarray(0, room);
        chunks.push(slice);
        got += slice.length;
        if (got >= cap) { try { await reader.cancel(); } catch (e) { /* 已断开 */ } break; }
      }
    } catch (e) {
      if (!chunks.length) { this.stats.errors++; return ""; }
    }
    this.stats.readmes++;
    const text = Buffer.concat(chunks).toString("utf8");
    const wasTruncated = got >= cap;
    return wasTruncated ? text + "\n\n[README 已截断至 " + Math.round(cap / 1024) + "KB]" : text;
  }

  describe() {
    return {
      configured: this.configured,
      tokenSource: this.tokenSource || (this.configured ? "" : missingKeyHint("GITHUB_TOKEN")),
      searchTokens: this.searchBucket.available,
      coreTokens: this.coreBucket.available,
      stats: Object.assign({}, this.stats),
    };
  }
}
