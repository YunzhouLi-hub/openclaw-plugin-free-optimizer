# Free Optimizer 🦞

> Auto-discover free models across 9 platforms, benchmark in real-time, and dynamically route to the fastest one.

<p align="center">
  <img src="Picture/ScreenShot_2026-04-29_163456_689.png" alt="Free Optimizer Screenshot" width="600">
</p>

---

## One-Liner

An OpenClaw plugin. Set `model: free-opt/auto` and it automatically picks the fastest free model from a pool to handle your conversations.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Supported Platforms & Free Models](#supported-platforms--free-models)
- [CLI Commands](#cli-commands)
- [Configuration Reference](#configuration-reference)
- [Ranking Table](#ranking-table)
- [Ranking Rules](#ranking-rules)
- [Health Check & Auto-Switching](#health-check--auto-switching)
- [Development](#development)
- [FAQ](#faq)

---

## How It Works

```
Every 60 minutes (cron)
  │
  ├── Scans 9 platforms → discovers currently available free models
  │
  ├── Sends a chat request to each model → measures TTFT (Time To First Token)
  │    │    └─ Also collects the response → quality score (0-5 stars)
  │    └── Auto-retry on failure, 2 attempts with exponential backoff
  │
  ├── Ranks results (see rules below)
  │
  ├── Sets the fastest model as "active model"
  │
  └── Saves to local cache — next request reads from cache
```

**On every chat request (milliseconds)**:

```
1. Check cache → was the fastest model benchmarked in the last 5 min?
   ├─ ✅ Yes → route request directly
   └─ ❌ No (but stale data exists within 30 min)
         └─ Route with stale data, trigger background re-benchmark
              └─ When done, switch to the new fastest model automatically
```

**Worst case — all models fail**:
→ Falls back to `openrouter/free` to guarantee zero request loss

---

## Quick Start

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) ≥ 1.0.0
- Node.js ≥ 18
- At least one API Key (recommended for China: NVIDIA / Cloudflare / GitHub — no proxy needed)

### 1. Install

```bash
# Clone or copy to plugin directory
cp -r openclaw-plugin-free-optimizer ~/.openclaw/plugins/free-optimizer

# Enter plugin directory
cd ~/.openclaw/plugins/free-optimizer

# Install dependencies
npm install

# Build TypeScript
npm run build

# Verify — run tests (all should pass)
npm test
```

### 2. Configure API Keys

**Option A: Environment variables (recommended)**

```bash
# Copy the example config
cp .env.example ~/.openclaw/env

# Edit and fill in your keys
nano ~/.openclaw/env

# Example content:
export FREE_OPT_NVIDIA_KEY="nvapi-xxxxx"
export FREE_OPT_CLOUDFLARE_KEY="cfat_xxxxx"
export CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id"
export FREE_OPT_GITHUB_KEY="ghp_xxxxx"
```

**Option B: Edit config.json directly**

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
      "accountId": "your-cloudflare-account-id"
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

### 3. Set the Main Model

In your OpenClaw configuration, set the model to:

```
model: free-opt/auto
```

### 4. Verify Installation

Run this in your OpenClaw chat:

```
/free-opt_test
```

Expected output:
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

## Supported Platforms & Free Models

| Platform | Provider ID | Direct from China | Typical Models | Highlights |
|----------|-------------|-------------------|----------------|------------|
| **OpenRouter** | `openrouter` | ✅ | DeepSeek R1/V3, Llama 4, Qwen3 | Largest model pool, variable quality |
| **NVIDIA NIM** | `nvidia` | ✅ | Llama 3.3 70B, Kimi K2.5, Nemotron | Strong reasoning models, stable latency |
| **Cloudflare Workers AI** | `cloudflare` | ✅ | Llama 3.2 1B/3B, Mistral 7B | Lowest latency (400-1000ms), smaller models |
| **GitHub Models** | `github` | ✅ | GPT-4o Mini, Llama 3.3 70B, DeepSeek R1 | Microsoft ecosystem, requires GitHub PAT |
| **Google AI Studio** | `google` | ❌ (GFW) | Gemini 2.5 Pro/Flash, Gemma 3 | Large free quota, high quality, needs proxy |
| **Groq** | `groq` | ❌ (GFW) | Llama 3.3 70B, Qwen3 32B | Fastest (<200ms), needs proxy |
| **Mistral AI** | `mistral` | ❌ (GFW) | Mistral Large, Codestral | Strong at coding/French, needs proxy |
| **HuggingFace** | `huggingface` | ❌ (GFW) | Various open-source models | Maximum freedom, needs proxy |
| **Cerebras** | `cerebras` | ❌ (GFW) | Llama 3.3 70B | Fastest inference chip, needs proxy |

> 💡 **Tip for China users**: Start with NVIDIA + Cloudflare + GitHub — no proxy required.

---

## CLI Commands

All commands run in the OpenClaw chat window.

| Command | Description | Duration |
|---------|-------------|----------|
| `/free-opt_test` | **Run a full benchmark cycle** | ~30-60s |
| `/free-opt_status` | **View current ranking & active model** | Instant |
| `/free-opt_health` | **Check if the active model is alive** | ~1-3s |
| `/free-opt_list` | **List all discovered free models** | Instant |

```
# Daily routine:
/free-opt_test      ← Morning benchmark
/free-opt_status    ← Check who's fastest at any time
/free-opt_health    ← Periodic health check
```

---

## Configuration Reference

Full `config.json` structure:

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

### benchmark Field Reference

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master plugin switch |
| `intervalMinutes` | `60` | Background benchmark interval (minutes) |
| `maxResponseTimeMs` | `15000` | Model timeout threshold (skips if no response) |
| `concurrency` | `3` | Number of models to benchmark simultaneously |
| `prompt` | `What is the capital of France? Reply in one word.` | Benchmark probe prompt |
| `maxTokens` | `10` | Max tokens in benchmark response (shorter = faster) |
| `retryOnFailure` | `2` | Retry attempts on 429/5xx/network errors |
| `retryDelayMs` | `3000` | Retry delay with exponential backoff (3s→6s→12s) |
| `includeModels` | `[]` | **Only benchmark these models** (partial match `providerId/modelId`) |
| `excludeModels` | `[]` | **Skip these models** |
| `includeProviders` | `[]` | **Only benchmark these providers** (e.g. `["nvidia", "github"]`) |
| `excludeProviders` | `[]` | **Skip these providers** |
| `minParamB` | `0` | **Minimum parameters** (set `70` to only benchmark ≥70B models) |
| `minContextTokens` | `0` | **Minimum context window** (set `131072` for ≥128k models) |
| `pinnedModel` | `""` | **Pin a specific model** (format `"nvidia/meta/llama-3.3-70b-instruct"`) |
| `preferredModels` | `[]` | **Prefer these models** (partial match, e.g. `["nvidia/llama-3.3"]`) |
| `avoidModels` | `[]` | **Avoid these models** (partial match, e.g. `["cloudflare/mistral"]`) |

### Filter Examples

```jsonc
// Scenario 1: Only NVIDIA 70B+ models
{ "includeProviders": ["nvidia"], "minParamB": 70 }

// Scenario 2: Skip large models and Cloudflare
{ "excludeProviders": ["cloudflare"], "minParamB": 0, "maxContextTokens": 0 }

// Scenario 3: Pin NVIDIA Llama, no benchmarking
{ "pinnedModel": "nvidia/meta/llama-3.3-70b-instruct" }

// Scenario 4: Prefer NVIDIA Llama, avoid Cloudflare Mistral
{ "preferredModels": ["nvidia/llama-3.3"], "avoidModels": ["cloudflare/mistral"] }
```

---

## Ranking Table

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

| Column | Meaning |
|--------|---------|
| **Rank** | Position (`-` = benchmark failed) |
| **Model** | `providerId/modelId` |
| **TTFT** | Time to first token (lower = faster) |
| **Qual** | Quality score ★★★★★ (0-5, based on correctness & conciseness) |
| **Tag** | ⭐ = preferred / 🚫 = avoid (blank = normal) |
| **Ctx** | Context window size |
| **Age** | Time since last benchmark |

---

## Ranking Rules

Priority order (top to bottom):

| Priority | Rule |
|----------|------|
| 1 | **Successful responses** > failures |
| 2 | **preferred ⭐** > normal > **avoid 🚫** |
| 3 | **Quality score** — higher stars first |
| 4 | **TTFT** — lower latency first |
| 5 | **Context window** — larger first |

---

## Health Check & Auto-Switching

**Health check** (`/free-opt_health`):
1. Benchmarks only the active model
2. If alive → shows "✅ Alive and well"
3. If dead → **runs a full benchmark cycle automatically** → switches to new fastest

**Auto-switching** (zero intervention):
- Every chat request picks rank #1 from the latest ranking
- No cooldown, no "must be X% faster" threshold
- Ranking changes → next request immediately uses the new winner

**Cache TTL**:

| State | Time Range | Behavior |
|-------|-----------|----------|
| Fresh | ≤ 5 min | Use cache directly, no re-benchmark |
| Stale | 5-30 min | Route with stale data, trigger background re-benchmark |
| Expired | > 30 min | Force full re-benchmark |

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run all tests (17 unit + integration)
npm test

# Unit tests only (fast)
npx vitest run

# Live benchmark (requires API keys)
npm run test:benchmark

# Full pipeline (discover → benchmark → rank, requires API keys)
npm run test:e2e

# Type check (same as build)
tsc --noEmit
```

### Project Structure

```
free-optimizer/
├── index.ts                  # Plugin entry point: provider, commands, services
├── config.json               # Runtime config (benchmark, ranking, routing)
├── openclaw.plugin.json      # Plugin manifest & config schema
├── .env.example              # API key environment variable template
├── .gitignore
├── package.json
├── tsconfig.json
│
├── lib/
│   ├── benchmarker.ts        # Benchmark engine (TTFT, quality score, concurrency)
│   ├── ranker.ts             # Ranking engine (sort, fallback chain, table print)
│   └── types.ts              # All type definitions
│
├── providers/
│   ├── registry.ts           # Provider registry
│   ├── openrouter.ts         # OpenRouter discovery
│   ├── google.ts             # Google AI Studio discovery
│   └── openai-compatible.ts  # Groq/Cerebras/Mistral/NVIDIA/Cloudflare/GitHub/HuggingFace
│
├── __tests__/                # Unit tests
│   ├── benchmarker.test.ts
│   ├── ranker.test.ts
│   └── openrouter-discovery.test.ts
│
├── tests/                    # Integration tests (live)
│   ├── benchmark-test.mjs
│   ├── e2e-pipeline.mjs
│   └── openrouter-discovery.test.mjs
│
└── types/                    # OpenClaw SDK types
    └── openclaw-plugin-sdk.d.ts
```

---

## FAQ

**Q: Plugin doesn't work. Model shows "free-opt/auto unavailable"?**
A: Run `/free-opt_test` to confirm at least one model passes benchmark. If all fail, check your API keys and network connectivity.

**Q: Ranking table is all "Error: Timeout"?**
A: Likely GFW blocking. Try configuring only NVIDIA / Cloudflare / GitHub.

**Q: How do I benchmark only specific models?**
A: Set `"includeModels": ["llama-3.3", "deepseek"]` in config.json.

**Q: How do I disable a specific platform?**
A: Set `"excludeProviders": ["openrouter", "google"]`.

---

## License

MIT
