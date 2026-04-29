/**
 * Test the benchmark module against live OpenRouter free models.
 * Run with: node tests/benchmark-test.mjs
 */

// ---- Benchmark logic (inline for standalone testing) ----

const DEFAULT_MAX_RESPONSE_TIME = 15_000;
const DEFAULT_PROMPT = 'Say hi.';
const DEFAULT_MAX_TOKENS = 10;

/**
 * Measure Time To First Token (TTFT) for a single model via streaming API.
 */
async function benchmarkModel({ apiKey, baseUrl, modelId, maxResponseTime, prompt, maxTokens }) {
  maxResponseTime ??= DEFAULT_MAX_RESPONSE_TIME;
  prompt ??= DEFAULT_PROMPT;
  maxTokens ??= DEFAULT_MAX_TOKENS;

  const result = { modelId, ttftMs: 0, success: false, error: null, probedAt: Date.now() };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxResponseTime);

  const startTime = performance.now();

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      result.error = `HTTP ${res.status}: ${res.statusText}`;
      return result;
    }

    if (!res.body) {
      result.error = 'No response body (streaming not supported)';
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          result.error = 'Stream ended with no content';
          return result;
        }

        try {
          const data = JSON.parse(dataStr);
          const content = data.choices?.[0]?.delta?.content;
          if (content && content.length > 0) {
            result.ttftMs = Math.round(performance.now() - startTime);
            result.success = true;
            return result;
          }
        } catch {
          // Malformed JSON, continue reading
        }
      }
    }

    result.error = 'Stream ended without receiving a token';
    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      result.error = `Timeout after ${maxResponseTime}ms`;
    } else {
      result.error = err.message ?? String(err);
    }
    result.ttftMs = Math.round(performance.now() - startTime);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run benchmarks with controlled concurrency.
 */
async function benchmarkBatch(models, apiKey, baseUrl, concurrency = 3) {
  const results = [];
  const queue = [...models];

  async function worker() {
    while (queue.length > 0) {
      const model = queue.shift();
      const result = await benchmarkModel({ apiKey, baseUrl, modelId: model });
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, models.length) }, () => worker());
  await Promise.all(workers);

  // Sort: successful first by TTFT, failures at end
  return results.sort((a, b) => {
    if (a.success && b.success) return a.ttftMs - b.ttftMs;
    if (a.success) return -1;
    if (b.success) return 1;
    return 0;
  });
}

// ---- Test runner ----

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const baseUrl = 'https://openrouter.ai/api/v1';

  // Test a subset of free models (avoid rate limiting)
  const testModels = [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-12b-it:free',
    'qwen/qwen3-coder:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
  ];

  console.log('=== Benchmark Test: OpenRouter Free Models ===\n');
  console.log(`Testing ${testModels.length} models (concurrency: 3)`);
  console.log(`API key configured: ${apiKey ? 'Yes' : 'No'}\n`);

  if (!apiKey) {
    console.log('⚠ OPENROUTER_API_KEY not set. Using placeholder test (no actual API calls).');
    console.log('\nTo run live benchmark, set the environment variable:');
    console.log('  export OPENROUTER_API_KEY=sk-or-...');
    console.log('\nMock results:');
    console.log('  1. openrouter/free              420ms ✓');
    console.log('  2. meta-llama/llama-3.3-70b     890ms ✓');
    console.log('  3. google/gemma-3-12b          1200ms ✓');
    console.log('  4. qwen/qwen3-coder            1450ms ✓');
    console.log('  5. nvidia/nemotron-nano-12b     ---  ✗ (timeout)');
    return;
  }

  console.log('Running benchmarks...\n');
  const results = await benchmarkBatch(testModels, apiKey, baseUrl, 3);

  console.log('Results (sorted by TTFT):\n');
  console.log('┌─────┬────────────────────────────────────────┬────────┬───────┐');
  console.log('│ Rank│ Model                                  │ TTFT   │ Status│');
  console.log('├─────┼────────────────────────────────────────┼────────┼───────┤');

  let rank = 0;
  for (const r of results) {
    rank++;
    const status = r.success ? '✓' : `✗`;
    const ttft = r.success ? `${r.ttftMs}ms` : '---';
    const model = r.modelId.padEnd(38);
    console.log(`│ ${String(rank).padStart(3)} │ ${model} │ ${ttft.padEnd(6)} │   ${status}   │`);
    if (r.error) {
      console.log(`│     │ Error: ${r.error.padEnd(45)}│`);
    }
  }

  console.log('└─────┴────────────────────────────────────────┴────────┴───────┘');

  const successCount = results.filter(r => r.success).length;
  console.log(`\n${successCount}/${results.length} models responded successfully`);

  if (successCount > 0) {
    const fastest = results.find(r => r.success);
    console.log(`Fastest: ${fastest.modelId} (${fastest.ttftMs}ms)`);
  }
}

main();
