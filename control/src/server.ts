// envolvr control plane for Private AI Gateway middleware.
//
// Gateway-facing (bearer: controlToken), contract from gateway/src/middleware:
//   POST /consult/pre    authorize and route one request (fails closed on error)
//   POST /consult/post   usage report per attempt, idempotent by request id
//   GET  /models/...     sub-catalogs relayed from /v1/models/...
//                        (/models/providers/<upstream>: that upstream's models)
//   POST /receipts       digests of signed receipts, for anchoring (idempotent)
// Client-facing:
//   GET  /auth/nonce?wallet=0x…   message to sign
//   POST /auth/key                signed message -> API key (shown once)
//   GET  /receipts/<digest>/proof inclusion proof of an anchored receipt; the
//                                 digest is SHA-256 of the receipt's JCS bytes
// Operator (bearer: adminToken):
//   POST /admin/credit            credit a wallet's USDG balance
//   GET  /admin/account?wallet=   balance and today's allowance
//   GET  /admin/deposits/held     deposits held by sanctions screening
//   POST /admin/deposits/release  credit a held deposit after review
//
// Sanctions screening (screening.ts) gates sign-in (fails closed, 503 while
// screening is unavailable) and every consult (403 for a blocked wallet).
//
// The gateway sends no prompt content here: a key hash, the model, routing
// constraints and content-free request features only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hashApiKey, newApiKey, newNonce, recoverSigner, signInMessage } from './auth.ts';
import type { AllowanceSource } from './chain.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import { ProofService } from './anchoring.ts';
import { costMicros } from './money.ts';
import { Screening, ScreeningUnavailable } from './screening.ts';
import {
  billingRates, DEFAULT_ENDPOINTS, parseProviderPrefs, quote, RoutingError, selectRoutes, withRouteMargin, type Route,
} from './routing.ts';

const DAY = 86_400;
const NONCE_TTL = 300;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^0x[0-9a-f]{64}$/;
const MAX_DIGESTS = 10_000;

export interface Deps {
  config: Config;
  store: Store;
  allowance: AllowanceSource;
  /** Defaults to the config's static blocklist alone. */
  screening?: Screening;
  /** Unix seconds. */
  now?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const got = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json' }).end(text);
}

export function createControlServer(deps: Deps): Server {
  const { config, store, allowance } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? (() => {});
  const screening = deps.screening ?? new Screening(store, { blocklist: config.blockedWallets });
  // Routes with the resale margin applied, per public model.
  const priced = new Map<string, Route[]>(
    Object.entries(config.models).map(([model, { routes }]) => [
      model,
      routes.map((r) => withRouteMargin(r, config.marginBps)),
    ]),
  );

  async function allowanceLeft(accountId: number, wallet: string, dayStart: number): Promise<{ total: bigint; left: bigint }> {
    let total = 0n;
    try {
      total = await allowance.allowanceMicros(wallet, dayStart);
    } catch (err) {
      // An unreachable chain must not block paying users: count allowance as zero.
      log('allowance lookup failed', { error: String(err) });
    }
    const left = total - store.allowanceUsed(accountId, dayStart);
    return { total, left: left > 0n ? left : 0n };
  }

  async function consultPre(body: Record<string, unknown>) {
    const deny = (status: number, message: string) => ({ allow: false, status, message });
    const keyHash = typeof body.apiKeyHash === 'string' ? body.apiKeyHash : undefined;
    if (!keyHash) return deny(401, 'missing API key');
    const account = store.accountByKeyHash(keyHash);
    if (!account) return deny(401, 'invalid API key');
    let blocked: boolean;
    try {
      blocked = await screening.blocked(account.wallet);
    } catch (err) {
      if (err instanceof ScreeningUnavailable) return deny(503, 'sanctions screening unavailable');
      throw err;
    }
    if (blocked) return deny(403, 'account not permitted');
    const model = typeof body.model === 'string' ? body.model : undefined;
    const routes = model ? priced.get(model) : undefined;
    if (!model || !routes) return deny(404, 'model not found');
    let chosen: Route[];
    try {
      chosen = selectRoutes(routes, parseProviderPrefs(body.provider));
    } catch (err) {
      if (err instanceof RoutingError) return deny(err.status, err.message);
      throw err;
    }
    if (chosen.length === 0) return deny(404, 'no route for this model matches provider');

    const t = now();
    const { left } = await allowanceLeft(account.id, account.wallet, t - (t % DAY));
    const available = left + (account.balanceMicros > 0n ? account.balanceMicros : 0n);
    if (available < BigInt(config.minAvailableMicros)) return deny(402, 'insufficient credit');

    return {
      allow: true,
      pricing: quote(chosen),
      candidates: chosen.map((r) => ({
        routeId: `${r.upstream}:${model}`,
        format: 'openai',
        supportedEndpoints: r.endpoints ?? DEFAULT_ENDPOINTS,
      })),
      userId: account.id,
      organizationId: account.id,
      workspaceId: account.id,
      spendMode: 'regular',
    };
  }

  async function consultPost(body: Record<string, unknown>) {
    const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
    const model = typeof body.requestModel === 'string' ? body.requestModel : undefined;
    if (!requestId || !model) throw new HttpError(400, 'requestId and requestModel are required');
    const attemptIndex = Number.isInteger(body.attemptIndex) ? (body.attemptIndex as number) : -1;
    const userId = Number.isInteger(body.userId) ? (body.userId as number) : null;
    const usage = body.usage && typeof body.usage === 'object' ? (body.usage as Record<string, unknown>) : null;
    const route = typeof body.selectedRouteId === 'string' ? body.selectedRouteId : null;
    const servedUpstream = route && route.endsWith(`:${model}`) ? route.slice(0, -(model.length + 1)) : null;
    const routes = priced.get(model);
    const cost = usage && routes ? costMicros(usage, billingRates(routes, body.pricing, servedUpstream)) : 0n;

    const account = userId !== null ? store.db.prepare('SELECT wallet FROM accounts WHERE id = ?').get(userId) as
      { wallet: string } | undefined : undefined;
    const t = now();
    const dayStart = t - (t % DAY);
    const allowanceTotal = account ? (await allowanceLeft(userId!, account.wallet, dayStart)).total : 0n;
    const result = store.recordUsage({
      requestId, attemptIndex, accountId: account ? userId : null, model,
      route,
      status: Number(body.status) || 0, costMicros: cost, allowanceMicros: allowanceTotal, dayStart, now: t,
    });
    return { recorded: result.recorded, costMicros: cost, fromAllowanceMicros: result.fromAllowance, fromBalanceMicros: result.fromBalance };
  }

  // `/models`: every model at its default quote, with each route's own price.
  // `/models/providers/<upstream>`: the models routed to that upstream, at its price.
  function catalog(pathname: string) {
    const provider = pathname.startsWith('/models/providers/')
      ? decodeURIComponent(pathname.slice('/models/providers/'.length))
      : null;
    const data = [];
    for (const [id, routes] of priced) {
      if (provider !== null) {
        const route = routes.find((r) => r.upstream === provider);
        if (route) data.push({ id, object: 'model', owned_by: 'envolvr', pricing: quote([route]) });
        continue;
      }
      data.push({
        id,
        object: 'model',
        owned_by: 'envolvr',
        pricing: quote(selectRoutes(routes, {})),
        routes: routes.map((r) => ({ provider: r.upstream, pricing: quote([r]), ...(r.optIn ? { optIn: true } : {}) })),
      });
    }
    return { object: 'list', data };
  }

  function authNonce(url: URL) {
    const wallet = url.searchParams.get('wallet') ?? '';
    if (!WALLET.test(wallet)) throw new HttpError(400, 'wallet must be a 0x address');
    const nonce = newNonce();
    const issuedAt = new Date(now() * 1000).toISOString();
    store.putNonce(nonce, wallet, now() + NONCE_TTL);
    return { nonce, issuedAt, message: signInMessage(wallet, nonce, issuedAt) };
  }

  async function authKey(body: Record<string, unknown>) {
    const { wallet, nonce, issuedAt, signature } = body as Record<string, string>;
    if (!WALLET.test(wallet ?? '') || !nonce || !issuedAt || !signature) {
      throw new HttpError(400, 'wallet, nonce, issuedAt and signature are required');
    }
    let signer: string;
    try {
      signer = recoverSigner(signInMessage(wallet, nonce, issuedAt), signature);
    } catch {
      throw new HttpError(401, 'invalid signature');
    }
    if (signer !== wallet.toLowerCase()) throw new HttpError(401, 'signature does not match wallet');
    // Screen before spending the nonce, so a sign-in refused with 503 can be retried.
    let blocked: boolean;
    try {
      blocked = await screening.check(wallet);
    } catch (err) {
      if (err instanceof ScreeningUnavailable) {
        log('sign-in screening unavailable', { error: err.message });
        throw new HttpError(503, 'sanctions screening unavailable, try again shortly');
      }
      throw err;
    }
    if (!store.takeNonce(nonce, wallet, now())) throw new HttpError(401, 'nonce expired or already used');
    if (blocked) {
      log('sign-in refused by sanctions screening');
      throw new HttpError(403, 'account not permitted');
    }
    const account = store.ensureAccount(wallet, now());
    const apiKey = newApiKey();
    store.addApiKey(account.id, hashApiKey(apiKey), now());
    return { apiKey, wallet: account.wallet };
  }

  const proofs = new ProofService(store);

  function receiveDigests(body: Record<string, unknown>) {
    const receipts = body.receipts;
    if (!Array.isArray(receipts) || receipts.length > MAX_DIGESTS) {
      throw new HttpError(400, `receipts must be a list of at most ${MAX_DIGESTS}`);
    }
    const digests = receipts.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>).digest : undefined));
    if (!digests.every((d): d is string => typeof d === 'string' && DIGEST.test(d))) {
      throw new HttpError(400, 'every receipt needs a digest: 0x and 64 lowercase hex');
    }
    return { added: store.addReceiptDigests(digests, now()) };
  }

  function receiptProof(pathname: string) {
    const digest = pathname.slice('/receipts/'.length, -'/proof'.length).toLowerCase();
    if (!DIGEST.test(digest)) throw new HttpError(400, 'digest must be 0x and 64 hex');
    const proof = proofs.proof(digest);
    if (!proof) throw new HttpError(404, 'unknown receipt digest');
    const a = config.anchoring;
    return a ? { ...proof, chainId: a.chainId, contract: a.receiptAnchor, providerId: a.providerId } : proof;
  }

  function adminCredit(body: Record<string, unknown>) {
    const wallet = String(body.wallet ?? '');
    if (!WALLET.test(wallet)) throw new HttpError(400, 'wallet must be a 0x address');
    let amount: bigint;
    try {
      amount = BigInt(String(body.amountMicros));
    } catch {
      throw new HttpError(400, 'amountMicros must be an integer');
    }
    if (amount <= 0n) throw new HttpError(400, 'amountMicros must be positive');
    const account = store.ensureAccount(wallet, now());
    store.credit(account.id, amount);
    return { wallet: account.wallet, balanceMicros: store.accountByWallet(wallet)!.balanceMicros };
  }

  function adminRelease(body: Record<string, unknown>) {
    const txHash = String(body.txHash ?? '');
    const logIndex = Number(body.logIndex);
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !Number.isInteger(logIndex)) {
      throw new HttpError(400, 'txHash (0x + 64 hex) and logIndex are required');
    }
    const amount = store.releaseDeposit(txHash, logIndex);
    if (amount === undefined) throw new HttpError(404, 'no held deposit with that txHash and logIndex');
    log('held deposit released');
    return { released: true, amountMicros: amount };
  }

  async function adminAccount(url: URL) {
    const account = store.accountByWallet(url.searchParams.get('wallet') ?? '');
    if (!account) throw new HttpError(404, 'no such account');
    const t = now();
    const { total, left } = await allowanceLeft(account.id, account.wallet, t - (t % DAY));
    return { wallet: account.wallet, balanceMicros: account.balanceMicros, allowanceTodayMicros: total, allowanceLeftMicros: left };
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://control');
      const route = `${req.method} ${url.pathname}`;
      const gateway = () => {
        if (!tokenMatches(req.headers.authorization, config.controlToken)) throw new HttpError(401, 'unauthorized');
      };
      const admin = () => {
        if (!tokenMatches(req.headers.authorization, config.adminToken)) throw new HttpError(401, 'unauthorized');
      };

      if (route === 'GET /healthz') return send(res, 200, { ok: true });
      if (route === 'POST /consult/pre') { gateway(); return send(res, 200, await consultPre(await readJson(req))); }
      if (route === 'POST /consult/post') { gateway(); return send(res, 200, await consultPost(await readJson(req))); }
      if (req.method === 'GET' && url.pathname.startsWith('/models')) { gateway(); return send(res, 200, catalog(url.pathname)); }
      if (route === 'POST /receipts') { gateway(); return send(res, 200, receiveDigests(await readJson(req, 2 * 1024 * 1024))); }
      if (req.method === 'GET' && /^\/receipts\/[^/]+\/proof$/.test(url.pathname)) return send(res, 200, receiptProof(url.pathname));
      if (route === 'GET /auth/nonce') return send(res, 200, authNonce(url));
      if (route === 'POST /auth/key') return send(res, 200, await authKey(await readJson(req)));
      if (route === 'POST /admin/credit') { admin(); return send(res, 200, adminCredit(await readJson(req))); }
      if (route === 'GET /admin/account') { admin(); return send(res, 200, await adminAccount(url)); }
      if (route === 'GET /admin/deposits/held') { admin(); return send(res, 200, { deposits: store.heldDeposits() }); }
      if (route === 'POST /admin/deposits/release') { admin(); return send(res, 200, adminRelease(await readJson(req))); }
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log('internal error', { error: String(err) });
      return send(res, 500, { error: 'internal error' });
    }
  });
}
