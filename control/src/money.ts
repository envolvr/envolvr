// Money and usage, in exact integers.
//
// Balances and costs are micro-USD (1e-6, the same unit as one USDG base unit).
// Per-token rates are kept in pico-USD (1e-12) so small rates stay exact.
// Usage is resolved by the same rules as the gateway's middleware
// (gateway/src/middleware/pricing.rs), so the cost the gateway shows is the cost
// we bill.

const PICO_DECIMALS = 12;

/** Parse a decimal USD string ("0.0000014") into pico-USD. */
export function toPico(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usd.trim());
  if (!m) throw new Error(`invalid decimal amount: ${usd}`);
  const frac = m[2] ?? '';
  if (frac.length > PICO_DECIMALS) throw new Error(`more than ${PICO_DECIMALS} decimals: ${usd}`);
  return BigInt(m[1]) * 10n ** 12n + BigInt(frac.padEnd(PICO_DECIMALS, '0'));
}

/** Format pico-USD as the shortest decimal string. */
export function fromPico(pico: bigint): string {
  const whole = pico / 10n ** 12n;
  const frac = (pico % 10n ** 12n).toString().padStart(PICO_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export interface Rates {
  inputCostPerToken: string;
  outputCostPerToken: string;
  cacheReadCostPerToken?: string;
  cacheCreationCostPerToken?: string;
}

/** Apply a margin in basis points, rounding each rate up to the next pico-USD. */
export function withMargin(rates: Rates, marginBps: number): Rates {
  const up = (r: string) => {
    const scaled = toPico(r) * BigInt(10_000 + marginBps);
    return fromPico((scaled + 9_999n) / 10_000n);
  };
  const out: Rates = { inputCostPerToken: up(rates.inputCostPerToken), outputCostPerToken: up(rates.outputCostPerToken) };
  if (rates.cacheReadCostPerToken) out.cacheReadCostPerToken = up(rates.cacheReadCostPerToken);
  if (rates.cacheCreationCostPerToken) out.cacheCreationCostPerToken = up(rates.cacheCreationCostPerToken);
  return out;
}

type Usage = Record<string, unknown>;

function tokens(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Usage)[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

export interface ResolvedUsage {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheCreation: number;
}

export function resolveUsage(usage: Usage): ResolvedUsage {
  const completion = tokens(usage, 'completion_tokens') ?? tokens(usage, 'output_tokens') ?? 0;

  // OpenAI Responses: input_tokens is the total and carries its cached part,
  // recognized only when no other cache signal is present.
  let responsesCached: number | undefined;
  const otherCacheSignal = tokens(usage, 'prompt_tokens') !== undefined
    || tokens(usage, 'cache_read_input_tokens') !== undefined
    || tokens(usage, 'cache_creation_input_tokens') !== undefined
    || (typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details !== null);
  if (!otherCacheSignal) {
    const input = tokens(usage, 'input_tokens');
    const cached = tokens(usage.input_tokens_details, 'cached_tokens');
    if (input !== undefined && cached !== undefined && cached >= 0 && cached <= input) responsesCached = cached;
  }

  const cacheRead = tokens(usage, 'cache_read_input_tokens')
    ?? tokens(usage.prompt_tokens_details, 'cached_tokens')
    ?? responsesCached
    ?? 0;
  const cacheCreation = tokens(usage, 'cache_creation_input_tokens') ?? 0;
  const input = tokens(usage, 'input_tokens') ?? 0;
  const promptTokens = tokens(usage, 'prompt_tokens');
  const prompt = promptTokens !== undefined ? promptTokens
    : responsesCached !== undefined ? input
    : input + cacheRead + cacheCreation;
  return { prompt, completion, cacheRead, cacheCreation };
}

/** Cost of one request in micro-USD, rounded up. */
export function costMicros(usage: Usage, rates: Rates): bigint {
  const u = resolveUsage(usage);
  const input = toPico(rates.inputCostPerToken);
  const cacheRead = rates.cacheReadCostPerToken ? toPico(rates.cacheReadCostPerToken) : input;
  const cacheCreation = rates.cacheCreationCostPerToken ? toPico(rates.cacheCreationCostPerToken) : input;
  const output = toPico(rates.outputCostPerToken);
  const uncached = BigInt(Math.max(u.prompt - u.cacheRead - u.cacheCreation, 0));
  const pico = uncached * input + BigInt(u.cacheRead) * cacheRead + BigInt(u.cacheCreation) * cacheCreation
    + BigInt(u.completion) * output;
  return (pico + 999_999n) / 1_000_000n;
}
