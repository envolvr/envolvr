import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModels } from '../src/config.ts';
import { billingRates, parseProviderPrefs, quote, selectRoutes, type Route } from '../src/routing.ts';

const a: Route = { upstream: 'a', inputCostPerToken: '0.000001', outputCostPerToken: '0.000004', cacheReadCostPerToken: '0.0000001' };
const b: Route = { upstream: 'b', inputCostPerToken: '0.000002', outputCostPerToken: '0.000003' };
const c: Route = { upstream: 'c', inputCostPerToken: '0.0000005', outputCostPerToken: '0.000001', optIn: true };

test('quote: highest rate per component; a missing cache rate counts as the input rate', () => {
  assert.deepEqual(quote([a]), {
    inputCostPerToken: '0.000001', outputCostPerToken: '0.000004', cacheReadCostPerToken: '0.0000001',
  });
  assert.deepEqual(quote([a, b]), {
    inputCostPerToken: '0.000002', outputCostPerToken: '0.000004', cacheReadCostPerToken: '0.000002',
  });
});

test('selectRoutes: config order, opt-in only when named, order and allow_fallbacks', () => {
  const up = (rs: Route[]) => rs.map((r) => r.upstream);
  assert.deepEqual(up(selectRoutes([a, b, c], {})), ['a', 'b']);
  assert.deepEqual(up(selectRoutes([a, b, c], { only: ['c', 'b'] })), ['b', 'c']);
  assert.deepEqual(up(selectRoutes([a, b, c], { order: ['c'] })), ['c', 'a', 'b']);
  assert.deepEqual(up(selectRoutes([a, b, c], { order: ['b', 'a'] })), ['b', 'a']);
  assert.deepEqual(up(selectRoutes([a, b, c], { only: ['a', 'b'], order: ['b'], allowFallbacks: false })), ['b']);
  assert.deepEqual(selectRoutes([a, b], { only: ['z'] }), []);
});

test('parseProviderPrefs: accepts only, order, allow_fallbacks; rejects the rest', () => {
  assert.deepEqual(parseProviderPrefs(undefined), {});
  assert.deepEqual(parseProviderPrefs({ only: ['a'], order: ['b'], allow_fallbacks: false }),
    { only: ['a'], order: ['b'], allowFallbacks: false });
  assert.throws(() => parseProviderPrefs({ only: 'a' }), /provider.only must be a list/);
  assert.throws(() => parseProviderPrefs({ only: [''] }), /provider.only must be a list/);
  assert.throws(() => parseProviderPrefs({ allow_fallbacks: 'no' }), /must be a boolean/);
  assert.throws(() => parseProviderPrefs({ data_collection: 'deny' }), /unsupported provider field/);
  assert.throws(() => parseProviderPrefs([]), /must be an object/);
});

test('billingRates: an issued quote that covers the serving route; otherwise the highest route', () => {
  const all = quote([a, b]);
  assert.deepEqual(billingRates([a, b], quote([a]), 'a'), quote([a]));
  assert.deepEqual(billingRates([a, b], quote([a, b]), 'a'), all);
  assert.deepEqual(billingRates([a, b], quote([a]), 'b'), all, 'quote for a does not cover b');
  assert.deepEqual(billingRates([a, b], { inputCostPerToken: '0.000001', outputCostPerToken: '0.000004' }, 'a'), all,
    'dropping the cache rate is not an issued quote');
  assert.deepEqual(billingRates([a, b], null, 'a'), all);
  assert.deepEqual(billingRates([a, b], 'x', null), all);
});

test('validateModels: routes, rates, duplicates and a default route are required', () => {
  assert.doesNotThrow(() => validateModels({ m: { routes: [a, c] } }));
  assert.throws(() => validateModels({ m: { routes: [] } }), /non-empty/);
  assert.throws(() => validateModels({ m: { routes: [a, a] } }), /duplicate route a/);
  assert.throws(() => validateModels({ m: { routes: [c] } }), /not opt-in/);
  assert.throws(() => validateModels({ m: { routes: [{ ...b, inputCostPerToken: '1e-6' }] } }), /invalid decimal/);
  assert.throws(() => validateModels({ m: { routes: [{ upstream: 'x', outputCostPerToken: '1' } as Route] } }), /required/);
  assert.throws(() => validateModels({ m: { inputCostPerToken: '1' } as never }), /non-empty/);
});
