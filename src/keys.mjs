/**
 * 密钥解析 —— 复用 dabai 既有约定，不另造一套。
 * 顺序：环境变量 → $DABAI_SECRETS_FILE → ~/.config/dabai/secrets.env → /opt/dabai/secrets.env
 * 与 deploy/gitguard/safe_push.py、deploy/release/publish.py 保持一致。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.DABAI_SECRETS_FILE || "",
  join(homedir(), ".config", "dabai", "secrets.env"),
  "/opt/dabai/secrets.env",
].filter(Boolean);

function parseEnv(text) {
  const map = Object.create(null);
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s[0] === "#") continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (v.length > 1) {
      const a = v[0], b = v[v.length - 1];
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) v = v.slice(1, -1);
    }
    map[k] = v;
  }
  return map;
}

// 多个文件合并，靠前的优先；按 mtime+size 缓存，新写进去的 key 不用重启就能读到
let _cache = null;
function merged() {
  const sig = [];
  const maps = [];
  const paths = [];
  for (const p of CANDIDATES) {
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size === 0) continue;
      sig.push(p + ":" + st.mtimeMs + ":" + st.size);
      maps.push(parseEnv(readFileSync(p, "utf8")));
      paths.push(p);
    } catch { /* 不存在就跳过 */ }
  }
  const key = sig.join("|");
  if (_cache && _cache.key === key) return _cache;
  const map = Object.create(null);
  for (const m of maps) for (const k of Object.keys(m)) if (!(k in map)) map[k] = m[k];
  _cache = { key, map, paths };
  return _cache;
}

/**
 * DSH 的凭证库（~/.dsh/.credentials.yaml）。
 * 只解析 refs: 段里的 "KEY: value"，不引 YAML 解析器 —— 这个文件的
 * 结构足够简单，而为它拉一个依赖不值得。
 * 加这一层是为了【不复制密钥】：provider 配置里写 apiKeyEnv: UNISOUND_API_KEY，
 * 值始终从 DSH 那一份取。你在 DSH 里换了 key，这边自动跟着变。
 */
const DSH_CREDS = join(homedir(), ".dsh", ".credentials.yaml");

function dshSecrets() {
  try {
    const st = statSync(DSH_CREDS);
    const key = "dsh:" + st.mtimeMs + ":" + st.size;
    if (_dsh && _dsh.key === key) return _dsh.map;
    const text = readFileSync(DSH_CREDS, "utf8");
    const map = Object.create(null);
    let inRefs = false;
    for (const line of text.split("\n")) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs && /^[A-Za-z_]/.test(line)) { inRefs = false; continue; }   // 下一个顶级键
      if (!inRefs) continue;
      const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/);
      if (m) map[m[1]] = clean(m[2]);
    }
    _dsh = { key, map };
    return map;
  } catch (e) { return Object.create(null); }
}
let _dsh = null;

function clean(v) {
  return String(v == null ? "" : v).trim().replace(/^["']|["']$/g, "");
}

/** 取密钥值；找不到返回空串。 */
export function findKey(name) {
  const env = clean(process.env[name]);
  if (env) return env;
  const m = merged().map;
  if (m[name]) return clean(m[name]);
  const d = dshSecrets();
  return d[name] ? clean(d[name]) : "";
}

/** 密钥来自哪里（用于界面显示，不泄露值）。 */
export function keySource(name) {
  if (clean(process.env[name])) return "环境变量";
  if (dshSecrets()[name]) return DSH_CREDS;
  const c = merged();
  for (const p of c.paths) {
    // 找到第一个真正含该 key 的文件
    try {
      const m = parseEnv(readFileSync(p, "utf8"));
      if (m[name]) return p;
    } catch { /* ignore */ }
  }
  return "";
}

/** 提示用户该往哪写 —— 与 safe_push.py 的报错文案对齐。 */
export function missingKeyHint(name) {
  return "缺 " + name + "：可写到 " + (CANDIDATES[1] || "~/.config/dabai/secrets.env") +
    "（" + name + "=xxx），或设成环境变量。系统级： sudo dabai-secrets set " + name + " xxx";
}

export function secretsCandidates() { return CANDIDATES.slice(); }
