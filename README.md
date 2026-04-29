# Free Optimizer 🦞

> 自动发现 9 大平台的免费模型，实时测速，动态切换到最快那个。

---

## 一句话

一个 OpenClaw 插件。装上它之后你只需要设 `model: free-opt/auto`，它自动从一个池子里挑最快的免费模型来处理你的聊天。

---

## 目录

- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [支持的平台 & 免费模型](#支持的平台--免费模型)
- [CLI 命令](#cli-命令)
- [配置详解](#配置详解)
- [排行榜解读](#排行榜解读)
- [模型排名规则](#模型排名规则)
- [健康检查 & 自动切换](#健康检查--自动切换)
- [开发](#开发)

---

## 工作原理

```
定时（每60分钟）
  │
  ├── 扫描 9 个平台 → 发现当前可用的免费模型
  │
  ├── 对所有模型发一次聊天请求 → 测量 TTFT（首字延迟）
  │    │    └─ 同时收集回复 → 质量评分（0-5星）
  │    └── 失败自动重试 2 次（指数退避）
  │
  ├── 按规则排名（见下方规则）
  │
  ├── 把最快的设为"active model"
  │
  └── 保存到本地缓存，下次请求直接走缓存
```

**每次聊天请求进来时（毫秒级）**：

```
1. 查缓存 → 最快模型是否在 5 分钟内测过速？
   ├─ ✅ 是 → 直接发请求
   └─ ❌ 否（但 30 分钟内有过旧数据）
         └─ 先用旧数据路由请求，同时后台开始重新测速
              └─ 测完后自动切到新的最快模型
```

**极低概率——所有模型都挂了**：
→ 回退到 `openrouter/free` 路由，保证不丢请求

---

## 快速开始

### 前置条件

- [OpenClaw](https://github.com/openclaw/openclaw) ≥ 1.0.0
- Node.js ≥ 18
- 至少一个平台的 API Key（推荐 NVIDIA / Cloudflare / GitHub，国内直连无障碍）

### 1. 安装

```bash
# 克隆或复制到插件目录
cp -r openclaw-plugin-free-optimizer ~/.openclaw/plugins/free-optimizer

# 进入插件目录
cd ~/.openclaw/plugins/free-optimizer

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 验证——跑测试（应该全部通过）
npm test
```

### 2. 配置 API Key

**方法一：环境变量（推荐）**

```bash
# 复制示例配置
cp .env.example ~/.openclaw/env

# 编辑，填入你的 Key
nano ~/.openclaw/env

# 内容示例：
export FREE_OPT_NVIDIA_KEY="nvapi-xxxxx"
export FREE_OPT_CLOUDFLARE_KEY="cfat_xxxxx"
export CLOUDFLARE_ACCOUNT_ID="你的Cloudflare AccountID"
export FREE_OPT_GITHUB_KEY="ghp_xxxxx"
```

**方法二：直接编辑 config.json**

```bash
nano ~/.openclaw/plugins/free-optimizer/config.json
```

```json
{
  "apiKeys": {
    "nvidia": {
      "enabled": true,
      "apiKey": "nvapi-xxxxx"
    },
    "cloudflare": {
      "enabled": true,
      "apiKey": "cfat_xxxxx",
      "accountId": "你的Cloudflare AccountID"
    }
  },
  "benchmark": {
    "enabled": true,
    "intervalMinutes": 60,
    "maxResponseTimeMs": 15000,
    "concurrency": 3
  }
}
```

### 3. 设置主模型

在 OpenClaw 配置把模型设为：

```
model: free-opt/auto
```

### 4. 验证安装

在 OpenClaw 聊天窗口执行：

```
/free-opt_test
```

应该看到：
```
┌──────┬────────────────────────────────────────────────┬────────┬─────────┬──────┬──────────┬────────────┐
│ Rank │ Model                                          │ TTFT   │ Qual   │ Tag │ Ctx      │ Age        │
├──────┼────────────────────────────────────────────────┼────────┼─────────┼──────┼──────────┼────────────┤
│    1 │ cloudflare/@cf/meta/llama-3.2-3b-instruct      │ 444ms  │ ★★★★★  │      │   128K   │ 12s        │
│    2 │ nvidia/meta/llama-3.3-70b-instruct             │ 692ms  │ ★★★★★  │  ⭐  │    65K   │ 2s         │
...
└──────┴────────────────────────────────────────────────┴────────┴─────────┴──────┴──────────┴────────────┘

🏆 Best model: cloudflare/@cf/meta/llama-3.2-3b-instruct (preferred ⭐) (444ms TTFT, fresh)
```

---

## 支持的平台 & 免费模型

| 平台 | Provider ID | 国内直连 | 典型模型 | 特点 |
|------|-------------|---------|----------|------|
| **OpenRouter** | `openrouter` | ✅ | DeepSeek R1/V3, Llama 4, Qwen3 | 模型池最大，但质量参差 |
| **NVIDIA NIM** | `nvidia` | ✅ | Llama 3.3 70B, Kimi K2.5, Nemotron | 推理模型丰富，延迟稳定 |
| **Cloudflare Workers AI** | `cloudflare` | ✅ | Llama 3.2 1B/3B, Mistral 7B | 延迟最低（400-1000ms），但模型小 |
| **GitHub Models** | `github` | ✅ | GPT-4o Mini, Llama 3.3 70B, DeepSeek R1 | 微软系模型，需要 GitHub PAT |
| **Google AI Studio** | `google` | ❌（GFW） | Gemini 2.5 Pro/Flash, Gemma 3 | 免费额度大，质量高，需代理 |
| **Groq** | `groq` | ❌（GFW） | Llama 3.3 70B, Qwen3 32B | 速度最快（<200ms），需代理 |
| **Mistral AI** | `mistral` | ❌（GFW） | Mistral Large, Codestral | 编码/法语强，需代理 |
| **HuggingFace** | `huggingface` | ❌（GFW） | 各种开源模型 | 模型最自由，需代理 |
| **Cerebras** | `cerebras` | ❌（GFW） | Llama 3.3 70B | 最快推理芯片，需代理 |

> 💡 **建议**：国内用户先配 NVIDIA + Cloudflare + GitHub，这三个不需要代理。

---

## CLI 命令

所有命令在 OpenClaw 聊天窗口执行。

| 命令 | 作用 | 耗时 |
|------|------|------|
| `/free-opt_test` | **立刻跑一次全面测速** | ~30-60秒 |
| `/free-opt_status` | **查看当前排名 & active model** | 瞬间 |
| `/free-opt_health` | **只测 active model 是否活着** | ~1-3秒 |
| `/free-opt_list` | **列出已发现的所有免费模型** | 瞬间 |

```
# 日常最常用的组合：
/free-opt_test      ← 起床跑一遍
/free-opt_status    ← 随时查看谁最快
/free-opt_health    ← 隔段时间检查一下别死
```

---

## 配置详解

完整的 `config.json` 长这样：

```json
{
  "apiKeys": {
    "openrouter": { "enabled": true, "apiKey": "sk-or-v1-xxxxx" },
    "nvidia": { "enabled": true, "apiKey": "nvapi-xxxxx" },
    "cloudflare": { "enabled": true, "apiKey": "cfat_xxxxx", "accountId": "4dd1efxxxxxxxxxxxxxxxxxxxxxx" },
    "github": { "enabled": true, "apiKey": "ghp_xxxxx" }
  },
  "benchmark": {
    "enabled": true,
    "intervalMinutes": 60,
    "maxResponseTimeMs": 15000,
    "concurrency": 3,
    "prompt": "What is the capital of France? Reply in one word.",
    "maxTokens": 10,
    "retryOnFailure": 2,
    "retryDelayMs": 3000,

    "includeModels": [],
    "excludeModels": [],
    "includeProviders": [],
    "excludeProviders": [],
    "minParamB": 0,
    "minContextTokens": 0,
    "pinnedModel": "",
    "preferredModels": [],
    "avoidModels": []
  },
  "routing": {
    "healthCheckEnabled": true,
    "healthCheckIntervalMs": 30000
  }
}
```

### benchmark 字段详解

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 插件功能开关 |
| `intervalMinutes` | `60` | 后台每小时跑一次全面测速 |
| `maxResponseTimeMs` | `15000` | 模型超时阈值（15秒没响应跳过） |
| `concurrency` | `3` | 同时测速多少个模型 |
| `prompt` | `What is the capital of France? Reply in one word.` | 测速用的提示词 |
| `maxTokens` | `10` | 测速回复长度（越小越快） |
| `retryOnFailure` | `2` | 失败重试次数（429/5xx/网络错误） |
| `retryDelayMs` | `3000` | 重试等待（指数退避：3s→6s→12s） |
| `includeModels` | `[]` | **只测这些模型**（部分匹配 `providerId/modelId`） |
| `excludeModels` | `[]` | **跳过这些模型** |
| `includeProviders` | `[]` | **只测这些平台**（写 `["nvidia", "github"]`） |
| `excludeProviders` | `[]` | **跳过这些平台** |
| `minParamB` | `0` | **最少参数**（写 `70` 只测 ≥70B 的模型） |
| `minContextTokens` | `0` | **最少上下文**（写 `131072` 只测 ≥128k 的模型） |
| `pinnedModel` | `""` | **固定模型**（格式 `"nvidia/meta/llama-3.3-70b-instruct"`） |
| `preferredModels` | `[]` | **优先使用**（写 `["nvidia/llama-3.3"]`，部分匹配） |
| `avoidModels` | `[]` | **尽量避免**（写 `["cloudflare/mistral"]`） |

### 过滤场景举例

```jsonc
// 场景 1：我只用 NVIDIA 的 70B+ 模型
{ "includeProviders": ["nvidia"], "minParamB": 70 }

// 场景 2：跳过大模型和 Cloudflare
{ "excludeProviders": ["cloudflare"], "minParamB": 0, "maxContextTokens": 0 }

// 场景 3：固定用 NVIDIA Llama，不测速
{ "pinnedModel": "nvidia/meta/llama-3.3-70b-instruct" }

// 场景 4：NVIDIA Llama 优先，Cloudflare Mistral 不用
{ "preferredModels": ["nvidia/llama-3.3"], "avoidModels": ["cloudflare/mistral"] }
```

---

## 排行榜解读

```
┌──────┬────────────────────────────────────────────────┬────────┬─────────┬──────┬──────────┬────────────┐
│ Rank │ Model                                          │ TTFT   │ Qual   │ Tag │ Ctx      │ Age        │
├──────┼────────────────────────────────────────────────┼────────┼─────────┼──────┼──────────┼────────────┤
│    1 │ cloudflare/@cf/meta/llama-3.2-3b-instruct      │ 444ms  │ ★★★★★  │      │   128K   │ 12s        │
│    2 │ nvidia/meta/llama-3.3-70b-instruct             │ 957ms  │ ★★★★★  │  ⭐  │    65K   │ 2s         │
│    3 │ github/DeepSeek-R1                             │ 1123ms │ ★★★★★  │      │   128K   │ 1m         │
│    - │ google/gemma-4-31b-it                          │    -   │  ???   │      │   262K   │            │
│      │ Error: Timeout 15000ms                         │        │         │      │          │            │
└──────┴────────────────────────────────────────────────┴────────┴─────────┴──────┴──────────┴────────────┘
```

| 列 | 含义 |
|----|------|
| **Rank** | 排名（`-` = 测速失败） |
| **Model** | `平台/模型ID` |
| **TTFT** | 首字延迟（越低越快） |
| **Qual** | 质量评分 ★★★★★（0-5星，基于回答是否正确简洁） |
| **Tag** | ⭐ = preferred / 🚫 = avoid（空 = 正常） |
| **Ctx** | 上下文窗口大小 |
| **Age** | 距上次测速多久了 |

---

## 模型排名规则

从上到下决定谁排第 1：

| 优先级 | 条件 |
|--------|------|
| 1 | **响应成功** > 失败（失败的排最后） |
| 2 | **preferred ⭐** > 正常 > **avoid 🚫** |
| 3 | **质量评分** — 高星在前 |
| 4 | **TTFT** — 延迟低在前 |
| 5 | **上下文** — 窗口大在前 |

---

## 健康检查 & 自动切换

**健康检查**：执行 `/free-opt_health` 会：
1. 只测 active model
2. 如果活着 → 显示 "✅ 活得好好的"
3. 如果死了 → **自动跑一次全量测速** → 切到新的最快模型

**自动切换**（无需人工干预）：
- 每次聊天请求进来，`free-opt` 从最新排名里选第 1 名
- 没有冷却期，没有"必须快 X%"的条件
- 排名变了，下个请求立刻切过去

**缓存 TTL**：

| 状态 | 时间范围 | 行为 |
|------|---------|------|
| Fresh（新鲜） | 5 分钟内 | 直接用缓存，不测速 |
| Stale（稍旧） | 5-30 分钟 | 先用旧数据，后台重新测速 |
| Expired（过期） | 超 30 分钟 | 强制全量测速 |

---

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run build

# 跑全部测试（17 个单元 + 集成测试）
npm test

# 只跑单元测试（快）
npx vitest run

# 跑实时测速（需要 API Key）
npm run test:benchmark

# 跑全链路（发现→测速→排名，需要 API Key）
npm run test:e2e

# 类型检查（等价于 build）
tsc --noEmit
```

### 项目结构

```
free-optimizer/
├── index.ts                  # 插件入口，注册 provider/commands/services
├── config.json               # 运行时配置（benchmark, ranking, routing）
├── openclaw.plugin.json      # 插件清单 & 配置 schema
├── .env.example              # API Key 环境变量模板
├── .gitignore
├── package.json
├── tsconfig.json
│
├── lib/
│   ├── benchmarker.ts        # 测速引擎（TTFT 测量、质量评分、并发控制）
│   ├── ranker.ts             # 排名引擎（排序、fallback chain、排行榜打印）
│   └── types.ts              # 所有类型定义
│
├── providers/
│   ├── registry.ts           # 平台注册中心
│   ├── openrouter.ts         # OpenRouter 发现
│   ├── google.ts             # Google AI Studio 发现
│   └── openai-compatible.ts  # Groq/Cerebras/Mistral/NVIDIA/Cloudflare/GitHub/HuggingFace
│
├── __tests__/                # 单元测试
│   ├── benchmarker.test.ts
│   ├── ranker.test.ts
│   └── openrouter-discovery.test.ts
│
├── tests/                    # 集成测试（实时）
│   ├── benchmark-test.mjs
│   ├── e2e-pipeline.mjs
│   └── openrouter-discovery.test.mjs
│
└── types/                    # OpenClaw SDK 类型
    └── openclaw-plugin-sdk.d.ts
```

---

## 常见问题

**Q: 插件不工作，model 显示 "free-opt/auto unavailable"？**
A: 先跑 `/free-opt_test` 确认有模型通过了测速。如果全部失败，检查 API Key 和网络。

**Q: 排行榜里全是 "Error: Timeout"？**
A: 大概率是 GFW 拦截了。试试只配 NVIDIA / Cloudflare / GitHub。

**Q: 如何只测我想要的模型？**
A: 在 config.json 设 `"includeModels": ["llama-3.3", "deepseek"]`。

**Q: 如何禁用某个平台？**
A: 设 `"excludeProviders": ["openrouter", "google"]`。

---

## 许可

MIT
