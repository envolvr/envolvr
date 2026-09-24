// Minimal S3 client (path-style, AWS Signature Version 4) for the ledger
// backups: put, get, list and delete. Checked against Backblaze B2.

import { createHash, createHmac } from 'node:crypto';

export interface S3Options {
  /** e.g. https://s3.us-east-005.backblazeb2.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Per request; default 120000. */
  timeoutMs?: number;
}

export interface S3Object {
  key: string;
  size: number;
}

const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding, as SigV4 requires (keeps A-Z a-z 0-9 - _ . ~). */
export function uriEncode(s: string, keepSlash = false): string {
  const encoded = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

/**
 * Sign a request with SigV4. `headers` must include host and x-amz-date
 * (YYYYMMDDTHHMMSSZ); every header given is signed. Returns the Authorization
 * header value.
 */
export function signV4(req: {
  method: string; path: string; query: Record<string, string>; headers: Record<string, string>;
  payloadHash: string; region: string; service: string; accessKeyId: string; secretAccessKey: string;
}): string {
  const lower = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const names = Object.keys(lower).sort();
  const amzDate = lower['x-amz-date'];
  const date = amzDate.slice(0, 8);
  const canonicalHeaders = names.map((h) => `${h}:${lower[h].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(req.query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(req.query[k])}`).join('&');
  const canonicalRequest = [req.method, req.path, canonicalQuery, canonicalHeaders, signedHeaders, req.payloadHash]
    .join('\n');
  const scope = `${date}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let key = hmac(`AWS4${req.secretAccessKey}`, date);
  for (const part of [req.region, req.service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class S3Client {
  private opts: S3Options;
  private now: () => Date;

  constructor(opts: S3Options, now: () => Date = () => new Date()) {
    this.opts = { ...opts, endpoint: opts.endpoint.replace(/\/+$/, '') };
    this.now = now;
  }

  private async request(method: string, key: string | null, query: Record<string, string> = {}, body?: Uint8Array) {
    const url = new URL(this.opts.endpoint);
    const path = `${url.pathname.replace(/\/$/, '')}/${uriEncode(this.opts.bucket)}${key === null ? '' : `/${uriEncode(key, true)}`}`;
    const payloadHash = sha256hex(body ?? new Uint8Array());
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
    };
    headers.authorization = signV4({
      method, path, query, headers, payloadHash, region: this.opts.region, service: 's3',
      accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey,
    });
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');
    delete headers.host;
    const res = await fetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, {
      method, headers, body: body as Uint8Array<ArrayBuffer> | undefined,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
      throw new Error(`S3 ${method} ${key ?? this.opts.bucket}: ${res.status}${code ? ` ${code}` : ''}`);
    }
    return res;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.request('PUT', key, {}, body);
  }

  async get(key: string): Promise<Buffer> {
    return Buffer.from(await (await this.request('GET', key)).arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.request('DELETE', key);
  }

  /** Every object under `prefix`, in key order. */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.request('GET', null, query)).text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(entry)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(entry)?.[1];
        if (key !== undefined) out.push({ key: unescapeXml(key), size: Number(size ?? 0) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
        : undefined;
    } while (token);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
