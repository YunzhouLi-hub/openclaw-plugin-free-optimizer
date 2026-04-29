/**
 * End-to-end test: Discovery → Benchmark → Ranking pipeline.
 *
 * Run with: node tests/e2e-pipeline.mjs [API_KEY]
 *
 * If API_KEY is not provided, runs in mock mode with simulated benchmark data.
 */

// ======================== Discovery Logic ========================

async function discoverFreeModels(baseUrl) {
  const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);

  const json = await res.json();
  const freeModels = [];

  for (const m of json.data) {
    const isFree = m.id.endsWith(':free') ||
      (parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0);
    if (!isFree) continue;

    freeModels.push({
      providerId: 'openrouter',
      modelId: m.id,
      displayName: m.name || m.id,
      contextLength: m.context_length,
      isFree: true,
      pricing: { prompt: parseFloat(m.pricing.prompt), completion: parseFloat(m.pricing.completion) },
      modality: m.architecture?.modality ?? 'text',
      discoveredAt: Date.now(),
    });
  }

  return freeModels;
}

// ======================== Benchmark Logic ========================

async function benchmarkModel(apiKey, baseUrl, modelId, maxResponseTime = 15000) {
  const result = { modelId, ttftMs: 0, success: false, error: null, probedAt: Date.now() };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxResponseTime);
  const startTime = performance.now();

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Say hi.' }],
        max_tokens: 10,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) { result.error = `HTTP ${res.status}`; return result; }
    if (!res.body) { result.error = 'No stream'; return result; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') { result.error = 'No content'; return result; }

        try {
          const data = JSON.parse(dataStr);
          const content = data.choices?.[0]?.delta?.content;
          if (content && content.length > 0) {
            result.ttftMs = Math.round(performance.now() - startTime);
            result.success = true;
            return result;
          }
        } catch { /* continue */ }
      }
    }
    result.error = 'No token received';
  } catch (err) {
    result.error = err.name === 'AbortError' ? `Timeout ${maxResponseTime}ms` : err.message;
    result.ttftMs = Math.round(performance.now() - startTime);
  } finally {
    clearTimeout(timeout);
  }

  return result;
}

async function benchmarkBatch(models, apiKey, baseUrl, concurrency = 3) {
  const results = [];
  const queue = [...models];

  async function worker() {
    while (queue.length > 0) {
      const model = queue.shift();
      const r = await benchmarkModel(apiKey, baseUrl, model);
      r.modelInfo = model; // attach original model data
      results.push(r);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, () => worker()));

  return results.sort((a, b) => {
    if (a.success && b.success) return a.ttftMs - b.ttftMs;
    if (a.success) return -1;
    if (b.success) return 1;
    return 0;
  });
}

// ======================== Ranking Logic ========================

function rankModels(models, benchmarks) {
  const benchMap = new Map();
  for (const b of benchmarks) benchMap.set(b.modelId, b);

  const ranked = models.map(m => {
    const b = benchMap.get(m.modelId);
    return {
      model: m,
      ttftMs: b?.success ? b.ttftMs : Infinity,
      success: b?.success ?? false,
      error: b?.error,
      rank: null,
    };
  });

  ranked.sort((a, b) => {
    if (a.success !== b.success) return a.success ? -1 : 1;
    if (a.ttftMs !== b.ttftMs) return a.ttftMs - b.ttftMs;
    return b.model.contextLength - a.model.contextLength;
  });

  let rank = 0;
  for (const e of ranked) if (e.success) e.rank = ++rank;
  return ranked;
}

// ======================== E2E Pipeline ========================

async function main() {
  const apiKey = process.argv[2] || process.env.OPENROUTER_API_KEY || '';
  const baseUrl = 'https://openrouter.ai/api/v1';
  const CONCURRENT_BENCHMARKS = 3;

  console.log('=== E2E Pipeline: Discovery → Benchmark → Ranking ===\n');

  // Step 1: Discover
  console.log('📡 Step 1: Discovering free models from OpenRouter...');
  try {
    const freeModels = await discoverFreeModels(baseUrl);
    console.log(`   Found ${freeModels.length} free models`);

    if (freeModels.length === 0) {
      console.log('   No free models found. Exiting.');
      return;
    }

    // Pick a representative subset for benchmarking (avoid rate limits)
    const benchSubset = freeModels
      .filter(m => {
        // Prioritize interesting models
        const id = m.modelId.toLowerCase();
        return id.includes('llama') || id.includes('gemma') ||
               id.includes('qwen') || id.includes('free') ||
               id.includes('nemotron') || id.includes('gpt-oss') ||
               id.includes('minimax') || id.includes('hy3');
      })
      .slice(0, 8);

    console.log(`   Selected ${benchSubset.length} models for benchmark:\n`);
    for (const m of benchSubset) {
      console.log(`     - ${m.modelId} [ctx: ${m.contextLength.toLocaleString()}]`);
    }

    // Step 2: Benchmark
    console.log('\n⏱ Step 2: Benchmarking models (TTFT via streaming)...');

    if (!apiKey) {
      console.log('\n   ⚠ No API key provided — showing mock benchmark results.\n');
      console.log('   Set OPENROUTER_API_KEY or pass key as argument for live test:');
      console.log('   node tests/e2e-pipeline.mjs sk-or-your-key\n');

      // Mock data for demonstration
      const mockResults = benchSubset.map((m, i) => ({
        modelId: m.modelId,
        modelInfo: m,
        ttftMs: [420, 680, 890, 1200, 1450, 2100, 3500, 8000][i] ?? 9999,
        success: i < 6,
        error: i >= 6 ? 'Timeout 15000ms' : (i === 5 ? 'HTTP 429' : null),
        probedAt: Date.now(),
      }));

      const ranked = rankModels(benchSubset, mockResults);
      printRanking(ranked);
      return;
    }

    console.log('   Running benchmarks...\n');
    const results = await benchmarkBatch(benchSubset.map(m => m.modelId), apiKey, baseUrl, CONCURRENT_BENCHMARKS);

    // Step 3: Rank
    console.log('\n🏁 Step 3: Ranking models by response speed...\n');
    const ranked = rankModels(benchSubset, results);
    printRanking(ranked);

    const best = ranked.find(r => r.success && r.rank === 1);
    if (best) {
      console.log(`\n✅ Recommendation: Use ${best.model.providerId}/${best.model.modelId}`);
      console.log(`   TTFT: ${best.ttftMs}ms`);
    }

  } catch (err) {
    console.error('Pipeline failed:', err.message);
  }
}

function printRanking(ranked) {
  console.log('┌──────┬──────────────────────────────────────────┬────────┬───────┬──────────┐');
  console.log('│ Rank │ Model                                    │ TTFT   │ Status│ Context  │');
  console.log('├──────┼──────────────────────────────────────────┼────────┼───────┼──────────┤');

  for (const r of ranked) {
    const rank = r.rank ? String(r.rank).padStart(4) : '   -';
    const model = r.model.modelId.padEnd(42).slice(0, 42);
    const ttft = r.success ? `${r.ttftMs}ms`.padEnd(6) : '    - ';
    const status = r.success ? '  ✓  ' : '  ✗  ';
    const ctx = r.model.contextLength > 0
      ? (r.model.contextLength >= 1000 ? `${(r.model.contextLength / 1000).toFixed(0)}K` : String(r.model.contextLength)).padStart(8)
      : '       -';

    console.log(`│ ${rank} │ ${model} │ ${ttft} │${status}│ ${ctx} │`);
    if (r.error && !r.success) {
      const errStr = `Error: ${r.error}`.padEnd(42).slice(0, 42);
      console.log(`│      │ ${errStr} │        │       │          │`);
    }
  }

  console.log('└──────┴──────────────────────────────────────────┴────────┴───────┴──────────┘');
}

main();
