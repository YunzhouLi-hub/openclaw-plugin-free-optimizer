/**
 * Simple test script to verify OpenRouter model discovery logic.
 * Run with: node tests/openrouter-discovery.test.mjs
 */

// ---- Type definitions ----
/** @typedef {{ prompt: string, completion: string, image: string, request: string }} Pricing */

// ---- Core logic ----

/**
 * Determine if a model qualifies as "free".
 * @param {{ id: string, pricing: Pricing }} model 
 * @returns {boolean}
 */
function isFreeModel(model) {
  // Explicit ":free" suffix — OpenRouter's built-in free routing group
  if (model.id.endsWith(':free')) return true;

  // Zero pricing on both prompt and completion
  const promptPrice = parseFloat(model.pricing.prompt);
  const completionPrice = parseFloat(model.pricing.completion);
  if (promptPrice === 0 && completionPrice === 0) return true;

  return false;
}

/**
 * Fetch and filter free models from OpenRouter API
 * @param {{ apiKey?: string, baseUrl?: string }} config
 * @returns {Promise<Array<{ providerId: string, modelId: string, displayName: string, contextLength: number, isFree: true, pricing: { prompt: number, completion: number }, modality: string, discoveredAt: number }>>}
 */
async function discoverFreeModels(config = {}) {
  const { apiKey = '', baseUrl = 'https://openrouter.ai/api/v1' } = config;
  const url = `${baseUrl}/models`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`);

    const json = await res.json();
    const freeModels = [];

    for (const model of json.data) {
      if (!isFreeModel(model)) continue;

      freeModels.push({
        providerId: 'openrouter',
        modelId: model.id,
        displayName: model.name || model.id,
        contextLength: model.context_length,
        isFree: true,
        pricing: {
          prompt: parseFloat(model.pricing.prompt),
          completion: parseFloat(model.pricing.completion),
        },
        modality: model.architecture?.modality ?? 'text',
        discoveredAt: Date.now(),
      });
    }

    return freeModels;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Unit tests ----

const testCases = [
  { name: ':free suffix should be free', model: { id: 'google/gemma-3-12b-it:free', pricing: { prompt: '0', completion: '0' } }, expected: true },
  { name: 'Zero pricing should be free', model: { id: 'meta-llama/llama-3.3-70b-instruct', pricing: { prompt: '0', completion: '0' } }, expected: true },
  { name: 'Paid model should NOT be free', model: { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } }, expected: false },
  { name: 'Cheap but non-zero should NOT be free', model: { id: 'meta-llama/llama-3.1-8b', pricing: { prompt: '0.00000003', completion: '0.00000006' } }, expected: false },
];

console.log('=== Unit Tests: isFreeModel ===\n');

let passed = 0;
for (const tc of testCases) {
  const result = isFreeModel(tc.model);
  const ok = result === tc.expected;
  console.log(`${ok ? '✓' : '✗'} ${tc.name}`);
  if (!ok) console.log(`  Expected: ${tc.expected}, Got: ${result}`);
  if (ok) passed++;
}

console.log(`\n${passed}/${testCases.length} tests passed\n`);

// ---- Integration test: live API call ----

async function runIntegrationTest() {
  console.log('=== Integration Test: OpenRouter Live API ===\n');
  try {
    const freeModels = await discoverFreeModels({});
    console.log(`Discovered ${freeModels.length} free models:\n`);

    // Group by provider prefix for cleaner display
    const byProvider = {};
    for (const m of freeModels) {
      const prefix = m.modelId.split('/')[0] || 'unknown';
      byProvider[prefix] = byProvider[prefix] || [];
      byProvider[prefix].push(m);
    }

    let count = 0;
    for (const [provider, models] of Object.entries(byProvider)) {
      console.log(`  ${provider} (${models.length} models):`);
      for (const m of models.slice(0, 3)) {
        console.log(`    - ${m.modelId} [ctx: ${m.contextLength.toLocaleString()}]`);
      }
      if (models.length > 3) console.log(`    ... and ${models.length - 3} more`);
      count += models.length;
    }

    console.log(`\nTotal: ${count} free models discovered`);

    // Validation: ensure all returned models are truly free
    const invalid = freeModels.filter(m => m.pricing.prompt !== 0 || m.pricing.completion !== 0);
    if (invalid.length > 0) {
      console.error(`\n✗ WARNING: ${invalid.length} models returned that may NOT be free!`);
      for (const m of invalid.slice(0, 3)) {
        console.error(`  ${m.modelId}: prompt=$${m.pricing.prompt}, completion=$${m.pricing.completion}`);
      }
    } else {
      console.log('\n✓ All returned models verified as free (pricing = 0)');
    }

  } catch (err) {
    console.error('✗ Integration test failed:', err.message);
  }
}

// Run tests
(async () => {
  await runIntegrationTest();
})();
