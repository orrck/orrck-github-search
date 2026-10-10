/**
 * LLM 客户端 —— OpenAI 兼容，只用内置 fetch。
 * 相对 okxdesk/src/llm/client.mjs 的增量：
 *   1) 429/5xx 按 Retry-After 退避（免费额度下这是常态，不是异常）
 *   2) 累计用量统计（token），界面能看到花了多少
 *   3) 容错 JSON 提取（模型爱包 \`\`\`json 围栏）
 */
import { findKey } from "./keys.mjs";

/** 从可能带围栏/前后废话的文本里抠出第一个 JSON 值。 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) { /* 继续扫描 */ }
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LlmClient {
  constructor(cfg) {
    cfg = cfg || {};
    this.baseUrl = String(cfg.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
    this.apiKey = String(cfg.apiKey || "");
    this.model = String(cfg.model || "deepseek-chat");
    this.timeoutMs = Number(cfg.timeoutMs || 120000);
    this.temperature = cfg.temperature === undefined ? 0.2 : Number(cfg.temperature);
    // deepseek-flash 会烧不可见的推理 token。给少了会出现 finish_reason=length、
    // 可见内容为空 —— nof1 上实测过 22% 的生成栽在这上面。宁可给宽。
    this.maxTokens = Number(cfg.maxTokens || 8000);
    // u2-flash 的隐藏推理会失控。实测同一个扩词提示词：
    //   开推理 → 160s，finish=length，正文 0 字，39609 字推理全是退化循环
    //   关推理 → 11s，finish=stop，正文 1418 字，16 个词
    // 取值透传给 reasoning_effort；空串 = 不传该字段，保持模型默认。
    this.reasoning = String(cfg.reasoning || "");
    this.usage = { calls: 0, prompt: 0, completion: 0, cached: 0, errors: 0, retries: 0 };
    this.lastError = "";
  }

  get configured() { return Boolean(this.apiKey); }

  /** 运行时改配置，改完立刻生效，不必重启。只覆盖传入的字段。 */
  setConfig(c) {
    if (!c) return;
    if (c.baseUrl) this.baseUrl = String(c.baseUrl).trim().replace(/\/+$/, "");
    if (c.model) this.model = String(c.model).trim();
    if (c.apiKey) this.apiKey = String(c.apiKey).trim();
    if (c.temperature !== undefined && c.temperature !== null && Number.isFinite(Number(c.temperature))) {
      this.temperature = Number(c.temperature);
    }
    if (c.maxTokens) {
      const m = Number(c.maxTokens);
      if (Number.isFinite(m) && m > 0) this.maxTokens = m;
    }
    if (c.reasoning !== undefined) this.reasoning = String(c.reasoning || "");
    if (c.timeoutMs) {
      const t = Number(c.timeoutMs);
      if (Number.isFinite(t) && t > 0) this.timeoutMs = t;
    }
  }

  /** 脱敏描述 —— 接口返回用这个，永远不回传 apiKey 原文。 */
  describe() {
    const k = this.apiKey;
    const mask = !k ? "" : (k.length <= 8 ? "*".repeat(k.length) : k.slice(0, 4) + "****" + k.slice(-4));
    return {
      configured: this.configured,
      baseUrl: this.baseUrl,
      model: this.model,
      apiKeyMasked: mask,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      usage: Object.assign({}, this.usage),
      lastError: this.lastError,
    };
  }

  /**
   * 发一次对话。
   * @returns {Promise<{text:string, finishReason:string, usage:object|null, startedAt:number, latencyMs:number}>}
   */
  async chat(messages, opts) {
    opts = opts || {};
    if (!this.apiKey) throw new Error("未配置 LLM API Key");
    const body = {
      model: opts.model || this.model,
      messages: messages,
      temperature: opts.temperature === undefined ? this.temperature : opts.temperature,
      max_tokens: opts.maxTokens || this.maxTokens,
      stream: false,
    };
    const reasoning = opts.reasoning !== undefined ? opts.reasoning : this.reasoning;
    if (reasoning) body.reasoning_effort = reasoning;
    if (opts.jsonMode) body.response_format = { type: "json_object" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + this.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      this.usage.errors++;
      this.lastError = e.name === "AbortError" ? ("超时 " + this.timeoutMs + "ms") : ("网络错误 " + e.message);
      const err = new Error(this.lastError);
      err.retryable = true;
      throw err;
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    const text = await res.text();

    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }

    if (!res.ok || (json && json.error)) {
      const msg = (json && json.error && json.error.message) || text.slice(0, 200);
      this.usage.errors++;
      this.lastError = "HTTP " + res.status + ": " + msg;
      const err = new Error("LLM 错误（HTTP " + res.status + "）: " + msg);
      err.status = res.status;
      // 429 / 5xx / 网络 = 值得重试；401/403/余额不足 = 重试没意义
      err.retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 120000);
      throw err;
    }
    if (!json) {
      this.usage.errors++;
      this.lastError = "返回非 JSON: " + text.slice(0, 200);
      const err = new Error(this.lastError);
      err.retryable = true;
      throw err;
    }
    const choice = json.choices && json.choices[0];
    if (!choice) {
      this.usage.errors++;
      this.lastError = "返回没有 choices";
      const err = new Error(this.lastError);
      err.retryable = true;
      throw err;
    }
    const u = json.usage || {};
    this.usage.calls++;
    this.usage.prompt += Number(u.prompt_tokens || 0);
    this.usage.completion += Number(u.completion_tokens || 0);
    this.usage.cached += Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0);
    this.lastError = "";
    return {
      text: (choice.message && choice.message.content) || "",
      finishReason: choice.finish_reason || "",
      usage: json.usage || null,
      startedAt: t0,
      latencyMs: latencyMs,
    };
  }

  /** 带退避重试。retryable 才重试，业务错误直接抛。 */
  async chatRetry(messages, opts, maxRetries) {
    const n = maxRetries === undefined ? 3 : maxRetries;
    let lastErr = null;
    for (let i = 0; i <= n; i++) {
      try { return await this.chat(messages, opts); }
      catch (e) {
        lastErr = e;
        if (!e.retryable) break;
        if (i >= n) break;
        this.usage.retries++;
        const wait = e.retryAfterMs || Math.min(2000 * Math.pow(2, i), 30000);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /** 要求 JSON 输出；jsonMode 不被支持时自动降级到纯文本解析。 */
  async json(messages, opts) {
    // 有些模型（u2-flash 实测）推理开销极大，截断时「给更多预算」只会让它更久地
    // rambling —— 翻倍到 12000 会跑成 4 分钟。调用方能自己抢救时就跳过这条重试。
    const noLenRetry = Boolean(opts && opts.noLengthRetry);
    const o = Object.assign({}, opts || {});
    let out;
    try {
      out = await this.chatRetry(messages, Object.assign({}, o, { jsonMode: true, maxTokens: o.maxTokens || this.maxTokens }));
    } catch (e) {
      if (e.status === 400) out = await this.chatRetry(messages, o);
      else throw e;
    }
    let parsed = extractJson(out.text);
    if (parsed === null && out.finishReason === "length" && !noLenRetry) {
      // 预算被推理 token 吃光、可见输出为空 —— 翻倍再来一次
      const want = Math.min(32000, Math.max(2000, Number(o.maxTokens || this.maxTokens)) * 2);
      out = await this.chatRetry(messages, Object.assign({}, o, { maxTokens: want }));
      parsed = extractJson(out.text);
    }
    if (parsed === null) {
      const err = new Error("模型输出无法解析成 JSON（finish=" + out.finishReason + "）: " + String(out.text).slice(0, 200));
      err.retryable = false;
      err.finishReason = out.finishReason;
      throw err;
    }
    out.json = parsed;
    return out;
  }
}
