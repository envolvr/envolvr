// Routes, provider preferences and quotes.
//
// A public model has one or more attested routes, each an upstream in the
// gateway's upstream config (route id `<upstream>:<model>`), in failover order.
// A request's quote is the highest rate across the routes it may use, so the
// cost the gateway shows the caller is the cost we bill whichever route serves
// it, and every route keeps its margin. Callers narrow the routes, and so the
// quote, with the OpenRouter-style `provider` block the gateway forwards.

import { toPico, withMargin, type Rates } from './money.ts';

export interface Route extends Rates {
  /** Upstream name in the gateway's upstream config. */
  upstream: string;
  /** Used only when a request names this upstream in `provider.only` or `provider.order`. */
  optIn?: boolean;
  /** API paths the upstream implements directly. */
  endpoints?: string[];
}

export interface ModelRoutes {
  routes: Route[];
}

export interface ProviderPrefs {
  only?: string[];
  order?: string[];
  allowFallbacks?: boolean;
}

export const DEFAULT_ENDPOINTS = ['/v1/chat/completions', '/v1/completions'];

export class RoutingError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new RoutingError(400, `provider.${field} must be a list of provider names`);
  }
  return value;
}

/**
 * Parse the caller's `provider` block. Unknown fields are rejected: silently
 * ignoring one could drop a routing restriction the caller relies on.
 */
export function parseProviderPrefs(value: unknown): ProviderPrefs {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new RoutingError(400, 'provider must be an object');
  const prefs: ProviderPrefs = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'only') prefs.only = stringList(v, key);
    else if (key === 'order') prefs.order = stringList(v, key);
    else if (key === 'allow_fallbacks') {
      if (typeof v !== 'boolean') throw new RoutingError(400, 'provider.allow_fallbacks must be a boolean');
      prefs.allowFallbacks = v;
    } else throw new RoutingError(400, `unsupported provider field: ${key}`);
  }
  return prefs;
}

/** The routes a request may use, in the order the gateway tries them. */
export function selectRoutes(routes: Route[], prefs: ProviderPrefs): Route[] {
  const { only, order } = prefs;
  let chosen = only
    ? routes.filter((r) => only.includes(r.upstream))
    : routes.filter((r) => !r.optIn || order?.includes(r.upstream));
  if (order) {
    const rank = (r: Route) => {
      const i = order.indexOf(r.upstream);
      return i === -1 ? order.length : i;
    };
    // Array.prototype.sort is stable: unranked routes keep their configured order.
    chosen = [...chosen].sort((a, b) => rank(a) - rank(b));
  }
  return prefs.allowFallbacks === false ? chosen.slice(0, 1) : chosen;
}

function maxRate(values: string[]): string {
  return values.reduce((a, b) => (toPico(b) > toPico(a) ? b : a));
}

/**
 * Highest rate per component across routes. A route without a cache rate bills
 * cached tokens at its input rate, so that is what it contributes.
 */
export function quote(routes: Rates[]): Rates {
  if (routes.length === 0) throw new Error('quote needs at least one route');
  const out: Rates = {
    inputCostPerToken: maxRate(routes.map((r) => r.inputCostPerToken)),
    outputCostPerToken: maxRate(routes.map((r) => r.outputCostPerToken)),
  };
  if (routes.some((r) => r.cacheReadCostPerToken)) {
    out.cacheReadCostPerToken = maxRate(routes.map((r) => r.cacheReadCostPerToken ?? r.inputCostPerToken));
  }
  if (routes.some((r) => r.cacheCreationCostPerToken)) {
    out.cacheCreationCostPerToken = maxRate(routes.map((r) => r.cacheCreationCostPerToken ?? r.inputCostPerToken));
  }
  return out;
}

/** Rates with the margin applied; route metadata is kept. */
export function withRouteMargin(route: Route, marginBps: number): Route {
  return { ...route, ...withMargin(route, marginBps) };
}

function sameRates(a: Rates, b: Record<string, unknown>): boolean {
  const keys = ['inputCostPerToken', 'outputCostPerToken', 'cacheReadCostPerToken', 'cacheCreationCostPerToken'] as const;
  return keys.every((k) => {
    const x = a[k];
    const y = b[k];
    if (x === undefined || y === undefined) return x === y;
    try {
      return typeof y === 'string' && toPico(x) === toPico(y);
    } catch {
      return false;
    }
  });
}

function covers(q: Rates, route: Rates): boolean {
  const eff = (r: Rates, k: 'cacheReadCostPerToken' | 'cacheCreationCostPerToken') => toPico(r[k] ?? r.inputCostPerToken);
  return toPico(q.inputCostPerToken) >= toPico(route.inputCostPerToken)
    && toPico(q.outputCostPerToken) >= toPico(route.outputCostPerToken)
    && eff(q, 'cacheReadCostPerToken') >= eff(route, 'cacheReadCostPerToken')
    && eff(q, 'cacheCreationCostPerToken') >= eff(route, 'cacheCreationCostPerToken');
}

/**
 * Rates to bill a finished request with. The gateway echoes the quote it was
 * given; it is used only when it is a quote we could have issued for this model
 * and covers the route that served. Otherwise bill the highest route, so a
 * request is never billed below the cost of any route.
 */
export function billingRates(routes: Route[], echoed: unknown, servedUpstream: string | null): Rates {
  const all = quote(routes);
  if (!echoed || typeof echoed !== 'object') return all;
  const subsets: Rates[] = [];
  for (let mask = 1; mask < 1 << routes.length; mask++) {
    subsets.push(quote(routes.filter((_, i) => mask & (1 << i))));
  }
  const issued = subsets.find((q) => sameRates(q, echoed as Record<string, unknown>));
  if (!issued) return all;
  const served = routes.find((r) => r.upstream === servedUpstream);
  if (served && !covers(issued, served)) return all;
  return issued;
}
