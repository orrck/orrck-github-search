# Github-search

GitHub 项目发现漏斗：**扩词 → 搜索 → LLM 打分 → 门槛过滤 → 落盘排序**。

给它一句自然语言需求（例如「把 Markdown 转成 PDF 的命令行工具」），它会自动扩出检索关键词、去 GitHub 搜索、用 LLM 逐条打分，最后给你一份按分数排序、可一键导出的清单。

---

## 特性

- **五段漏斗**：扩词 → 搜索 → 粗筛 → LLM 打分 → 门槛过滤，每一段都尽量把免费的手段放在前面
- **零第三方依赖**：只用 Node 内置模块与 `node:sqlite`，不需要 `npm install`
- **分数缓存**：同一个目标重跑时，已打过分的结果直接从库里搬入，**零 GitHub API、零 LLM 调用**
- **免费过滤器前置**：fork / archived / star 不足 / 空库 / 语言不符 / 过期 —— 不花钱就能扔的绝不进扫描队列
- **内存恒定**：长跑不涨内存（见下方「内存纪律」）
- **四种导出格式**：JSON / CSV / Markdown / TXT
- **子进程回收**：扫描每 1000 个项目换一个干净进程，把 RSS 还给系统

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **>= 22.5.0**（依赖内置的 `node:sqlite`） |
| 第三方依赖 | **无**。不需要 `npm install` |
| 网络 | 能访问 GitHub API 与你配置的 LLM 端点 |
| 凭据 | 一个 GitHub Token；一份 LLM API Key |

---

## 快速开始

```bash
# 1. 进入项目
cd Github-search

# 2. 配置凭据（见下方「配置」章节）
export GITHUB_TOKEN=ghp_xxxxxxxx

# 3. 启动 Web 服务
npm start
```

启动后终端会打印：

```text
Github-search 已启动  http://127.0.0.1:8097
```

浏览器打开该地址，按「使用方式」操作即可。

---

## 从端口架设 Web

### 默认绑定

服务**默认只监听本机回环**，不对外：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `GITHUB_SEARCH_PORT` | `8097` | 监听端口 |
| `GITHUB_SEARCH_HOST` | `127.0.0.1` | 监听地址 |

改端口：

```bash
GITHUB_SEARCH_PORT=9000 npm start
```

### 远程访问（推荐：SSH 隧道）

服务没有鉴权，**推荐用 SSH 隧道**而不是直接对外暴露：

```bash
# 在你自己的电脑上执行
ssh -N -L 8097:127.0.0.1:8097 用户名@服务器地址
# 然后本地浏览器打开 http://127.0.0.1:8097
```

### 直接对外暴露

```bash
GITHUB_SEARCH_HOST=0.0.0.0 GITHUB_SEARCH_PORT=8097 npm start
```

> ⚠️ **警告：本服务没有任何身份验证。**
> 一旦监听 `0.0.0.0`，同网络内任何人都能提交扫描任务、
> 改写你的 LLM 配置、读取全部扫描结果与导出数据。
> 如果必须对外，请务必自行在前面加一层带鉴权的反向代理（Nginx / Caddy + Basic Auth 或 mTLS），
> 并用防火墙限制来源 IP。

### 常驻运行（systemd 示例）

```ini
[Unit]
Description=Github-search — GitHub 项目发现漏斗
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/Github-search
Environment=GITHUB_SEARCH_PORT=8097
Environment=GITHUB_SEARCH_HOST=127.0.0.1
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## 配置

所有配置都有默认值，**只有凭据是必须的**。

### 1. GitHub Token（必须）

用来调 GitHub 搜索与仓库详情 API。未认证的限额极低，实际上必须配。

解析顺序（自上而下，先命中先用）：

1. 环境变量 `GITHUB_TOKEN`
2. `$DABAI_SECRETS_FILE` 指向的文件
3. `~/.config/dabai/secrets.env`
4. `/opt/dabai/secrets.env`
5. `~/.dsh/.credentials.yaml` 的 `refs:` 段

以上文件格式都是 `KEY=value` 一行一条（第 5 项是 YAML 的 `refs:` 段 `KEY: value`）。

最省事的做法：

```bash
mkdir -p ~/.config/dabai
echo 'GITHUB_TOKEN=ghp_xxxxxxxx' >> ~/.config/dabai/secrets.env
chmod 600 ~/.config/dabai/secrets.env
```

> Token 只在进程内存里使用，**不会写入任何文件**。Web 界面只显示脱敏值。

### 2. LLM（必须）

两种配法，任选其一。

**方式 A：界面表单（推荐）**

打开 Web 界面，填 Base URL / 模型名 / API Key，点「测试」，通过后保存。
会写到 `data/llm.json`（权限 600）：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKeyEnv": "LLM_API_KEY",
  "temperature": 0.2,
  "timeoutMs": 120000
}
```

推荐用 `apiKeyEnv`：**配置里只写变量名，值从上面那套密钥链现取**，换 key 时不用改任何文件。

**方式 B：环境变量**

```bash
export LLM_BASE_URL=https://api.deepseek.com/v1
export LLM_MODEL=deepseek-chat
export LLM_API_KEY=sk-xxxxxxxx
```

默认值：Base URL `https://api.deepseek.com/v1`，模型 `deepseek-chat`。

### 3. 其它可调参数

| 文件 | 字段 | 默认 | 说明 |
|---|---|---|---|
| `data/github.json` | `searchPerMin` | 自动 | 搜索 API 每分钟上限，不填则按响应头被动纠偏 |
| `data/github.json` | `corePerHour` | 自动 | 核心 API 每小时上限 |
| `data/config.json` | `seenRetentionDays` | `180` | 已见项目记录的保留天数 |
| `data/config.json` | `maxDbMb` | `1024` | 库体积上限，超了从最旧的开始删 |

---

## 使用方式

### 第 1 步：启动服务

```bash
npm start
```

### 第 2 步：打开界面并配置 LLM

浏览器访问 `http://127.0.0.1:8097`，在顶部表单填入 LLM 的 Base URL、模型名、API Key，点「测试」确认连通后保存。

> 未配置 LLM 时无法创建任务（接口会直接拒绝）。

### 第 3 步：提交查询

在表单里填两项：

- **查询目标**：一句自然语言需求。写得越具体，扩词与打分越准。
- **关键词**：初始检索词，逗号分隔。

可选筛选：语言、最低 star、最大距今更新天数、分数门槛、目标条数、并发数。

点「开始扫描」后，服务会**另起一个子进程**跑扫描，并在页面上实时显示日志与进度。

### 第 4 步：查看结果

结果页按分数从高到低列出达标项目，每行显示：

- 排名、分数
- **仓库名（可点击直达）**
- 一句话介绍
- star 数、语言、最后更新日期

列表不能展开 —— LLM 的详细分析在打分后就丢弃了，页面只保留结论。要逐个项目细看，用导出。

### 第 5 步：导出

结果页右上角有导出按钮，支持四种格式。详见下一节。

### 停止任务

结果页有「停止」按钮，会优雅收尾（缓冲区里的项目先落盘再退出）。

---

## 导出格式与字段

四种格式**都包含仓库链接**，但字段数量不同。

| 字段 | JSON | CSV | MD | TXT |
|---|:-:|:-:|:-:|:-:|
| 排名 / 序号 | — | ✅ | ✅ | ✅ |
| 仓库名 `full_name` | ✅ | ✅ | ✅ | ✅ |
| **仓库链接** `html_url` | ✅ | ✅ | ✅ 可点击 | ✅ |
| 分数 `score` | ✅ | ✅ 三位小数 | ✅ 两位小数 | ✅ 两位小数 |
| 一句话介绍 `one_line` | ✅ | ✅ | ✅ | ✅ |
| star `stars` | ✅ | ✅ | ✅ | ✅ |
| 语言 `lang` | ✅ | ✅ | ✅ | ✅ |
| 最后更新 `pushed` | ✅ | ✅ | ✅ | ❌ |
| 描述 `descr` | ✅ | ✅ | ❌ | ❌ |
| 标签 `topics` | ✅ | ❌ | ❌ | ❌ |
| README 长度 `readme_len` | ✅ | ❌ | ❌ | ❌ |
| `repo_id` / `run_id` / `ts` | ✅ | ❌ | ❌ | ❌ |

- **JSON** 最全（13 个字段），还带一个 `run` 头（查询目标 / 关键词 / 门槛 / 合格条数）与 `exportedAt`
- **CSV** 9 列，带 BOM，Excel 直接打开不乱码
- **MD** 7 列，链接是可点击的 markdown 链接
- **TXT** 最少，适合肉眼速览

> 需要按 `topics` 做二次筛选，只能用 JSON。

导出文件名形如 `Github-search-run25-2026-10-10.csv`。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 单页面板 |
| GET | `/api/state` | 运行状态：LLM 配置（脱敏）、GitHub 限额、各任务概况 |
| POST | `/api/llm` | 保存 LLM 配置 |
| POST | `/api/llm/test` | 测试 LLM 连通性 |
| POST | `/api/github` | 保存 GitHub 配置 |
| POST | `/api/config` | 保存 `config.json` |
| POST | `/api/maintain` | 手动触发清理（seen 过期行 / 库瘦身） |
| POST | `/api/runs` | **新建扫描任务**，body 见下 |
| GET | `/api/runs/:id` | 任务详情：状态、关键词、分数直方图、最近日志 |
| POST | `/api/runs/:id/stop` | 停止任务 |
| GET | `/api/results` | 结果列表（支持 `minScore` / `lang` / `minStars` / `q` / `limit`） |
| GET | `/api/export` | 导出（`run` / `format` / 同上筛选参数） |

`POST /api/runs` 的 body：

```json
{
  "goal": "一句自然语言需求",
  "keywords": "初始,检索,关键词",
  "mode": "target",
  "wantN": 20,
  "threshold": 0.6,
  "coarseThreshold": 0.3,
  "concurrency": 3,
  "minStars": 0,
  "maxAgeDays": 0,
  "lang": "",
  "maxHits": 0,
  "funnel": false,
  "force": false
}
```

> `goal` 与 `keywords` 必填。同一目标 + 同一筛选条件若已有任务在跑，会返回 **409**
> 并提示冲突任务号 —— 两个进程抢同一份 GitHub 额度只会互相拖慢。
> 确实要并行就带 `force: true`。

---

## 模块结构

```text
src/
  server.mjs      HTTP 服务：界面 + 扫描子进程的监护人（启动/回收/崩溃收尾）
  scan.mjs        扫描引擎，以子进程运行：node src/scan.mjs --run=<id>
  github.mjs      GitHub 搜索、详情、README 抓取；限流纠偏与令牌轮换
  llm.mjs         LLM 客户端（含 JSON 提取与重试）
  prompt.mjs      扩词提示词 + 打分提示词
  db.mjs          SQLite（node:sqlite）建表与全部读写，含分数缓存与 seen 表
  keys.mjs        密钥解析（环境变量 / dabai 密钥链 / DSH 凭证库）
  web/index.html  单页面板（每次请求读盘，改界面不用重启）
```

**调用关系**：`server.mjs` 常驻并托管界面；每次新建任务它 `spawn` 一个 `scan.mjs` 子进程；
扫描每 1000 个项目主动退出（退出码 75），由 `server.mjs` 拉起新进程。状态全在 SQLite 里，重启零交接成本。

---

## 数据落盘

全部运行时数据在 `data/`（已在 `.gitignore` 中，不会被提交）：

| 文件 | 内容 |
|---|---|
| `scan.db` | SQLite 主库：任务、命中、关键词、已见项目、分数缓存 |
| `llm.json` | LLM 配置（权限 600） |
| `github.json` | GitHub 限额配置 |
| `config.json` | 清理策略 |
| `expand-raw-run*.txt` | 每轮扩词的原始输出，用于事后复盘 |

库有两道自动阀门：`seenRetentionDays`（默认 180 天）与 `maxDbMb`（默认 1024 MB）。

---

## 内存纪律

长跑不涨内存是这个项目的硬约束，实现上有几条不能碰的规矩（见 `scan.mjs` 文件头注释）：

- **M1** 搜索响应当场投影成小对象，原始 JSON 不外流
- **M2** README 流式读到 4 KB 就 cancel，不读完再截
- **M3** 逐条流式处理，绝不把结果攒进数组
- **M4** 提完 `(score, one_line)` 后立刻让大对象出作用域
- **M5** 缓冲区满 100 条就落盘并清空，**峰值恒定 44 KB，与运行时长无关**
- **M7** 已见集合只存在 SQLite 里，内存中没有任何 `Set`
- **M8** 每 1000 个项目回收子进程，把 RSS 还给系统

改这块代码前请先读 `scan.mjs` 顶部的注释。

---

## 已知限制

- **无鉴权**：见上文「从端口架设 Web」的警告
- **单机单进程写库**：SQLite 直连，没有做多实例并发写
- **同目标不建议并行**：会互相抢 GitHub 额度，接口默认拦 409
- **详细分析不留存**：LLM 的完整理由在打分后丢弃，只保留一句话结论
- **免费过滤依赖仓库元数据**：GitHub 返回的 `fork` / `archived` / `size` 不准时会误判
- **界面列表不可展开**：设计如此，需要细节请用导出

---

## 作者

**Orrck Hermos**（GitHub: [@orrck](https://github.com/orrck)）

## 关于 AI 辅助编码

本项目的代码在编写过程中**使用了 AI 编程工具**。AI 参与了代码生成、重构与文档撰写。
所有代码均已由作者审阅，但请自行评估其是否适用于你的场景，尤其是在生产环境中使用前。

## 许可

本项目采用 **MIT License**，版权归 **orrck** 所有。详见 [LICENSE](LICENSE)。

