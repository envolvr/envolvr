import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costMicros, fromPico, resolveUsage, toPico, withMargin } from '../src/money.ts';

const usd = (micros: bigint) => Number(micros) / 1e6;

test('decimal rates round-trip exactly through pico-USD', () => {
  for (const r of ['0', '1', '0.0000014', '0.00000007', '1.25', '0.000000000001']) assert.equal(fromPico(toPico(r)), r);
  assert.throws(() => toPico('0.0000000000001'), /decimals/);
  assert.throws(() => toPico('-1'), /invalid/);
});

test('margin is applied per rate and rounded up', () => {
  assert.deepEqual(withMargin({ inputCostPerToken: '0.0000014', outputCostPerToken: '0.0000044' }, 2000),
    { inputCostPerToken: '0.00000168', outputCostPerToken: '0.00000528' });
  assert.equal(withMargin({ inputCostPerToken: '0.000000000001', outputCostPerToken: '0' }, 1).inputCostPerToken,
    '0.000000000002');
});

// Ported verbatim from gateway/src/middleware/pricing.rs,
// usage_shapes_cost_what_the_control_plane_bills: the cost the gateway shows
// must be the cost the control plane bills.
test('billing parity with the gateway', () => {
  const pricing = { inputCostPerToken: '1', outputCostPerToken: '2', cacheReadCostPerToken: '0.1', cacheCreationCostPerToken: '1.25' };
  const cases: [string, Record<string, unknown>, number][] = [
    ['OpenAI chat with a cached portion', { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } }, 74],
    ['Anthropic native, cache buckets added to the total', { input_tokens: 60, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }, 85.5],
    ['gateway Anthropic-to-chat transform', { prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 }, 88],
    ['Anthropic native without cache', { input_tokens: 100, output_tokens: 5 }, 110],
    ['OpenAI Responses cached portion, counted once', { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } }, 74],
    ['Responses cached count above its total', { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 999 } }, 110],
    ['Responses cached count negative', { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: -5 } }, 110],
    ['Responses null details', { input_tokens: 100, output_tokens: 5, input_tokens_details: null }, 110],
    ['input_tokens_details beside an Anthropic cache bucket', { input_tokens: 60, output_tokens: 5, cache_read_input_tokens: 30, input_tokens_details: { cached_tokens: 30 } }, 73],
    ['input_tokens_details beside prompt_tokens', { prompt_tokens: 100, input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } }, 110],
    ['input_tokens_details beside prompt_tokens_details', { input_tokens: 100, output_tokens: 5, prompt_tokens_details: { cached_tokens: 40 }, input_tokens_details: { cached_tokens: 40 } }, 114],
  ];
  for (const [name, usage, cost] of cases) assert.equal(usd(costMicros(usage, pricing)), cost, name);
});

test('gateway unit vectors: cache fallback and float-encoded counts', () => {
  assert.equal(usd(costMicros({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } },
    { inputCostPerToken: '0.000001', outputCostPerToken: '0.000002', cacheReadCostPerToken: '0.0000005' })), 0.000135);
  assert.equal(usd(costMicros({ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 40 },
    { inputCostPerToken: '0.00001', outputCostPerToken: '0' })), 0.0014);
  assert.equal(usd(costMicros({ prompt_tokens: 10.0, completion_tokens: 20.0 },
    { inputCostPerToken: '0.000001', outputCostPerToken: '0.000002' })), 0.00005);
});

test('costs round up to the next micro-USD', () => {
  assert.equal(costMicros({ prompt_tokens: 1, completion_tokens: 0 }, { inputCostPerToken: '0.00000015', outputCostPerToken: '0' }), 1n);
  assert.equal(costMicros({ prompt_tokens: 0, completion_tokens: 0 }, { inputCostPerToken: '1', outputCostPerToken: '1' }), 0n);
});

test('resolveUsage normalizes to the OpenAI convention', () => {
  assert.deepEqual(resolveUsage({ input_tokens: 60, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }),
    { prompt: 100, completion: 5, cacheRead: 30, cacheCreation: 10 });
});
