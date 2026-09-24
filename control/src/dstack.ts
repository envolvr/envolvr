// Keys from the dstack guest agent. The dstack KMS derives a key from this app's
// identity and a path, so every VM of this app (on any compose revision the app
// allows) gets the same key, and nothing outside such a VM does.

import { request } from 'node:http';

/** `endpoint`: a unix socket (`/var/run/dstack.sock`, `unix:…`) or an http(s) URL (simulator). */
export async function dstackKey(endpoint: string, path: string, purpose = ''): Promise<Buffer> {
  const body = JSON.stringify({ path, purpose });
  const text = /^https?:\/\//.test(endpoint)
    ? await fetch(new URL('GetKey', endpoint.replace(/\/*$/, '/')), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }).then(async (res) => {
      if (!res.ok) throw new Error(`dstack GetKey: ${res.status}`);
      return res.text();
    })
    : await postUnix(endpoint.replace(/^unix:(\/\/)?/, ''), '/GetKey', body);
  const hex = (JSON.parse(text) as { key?: string }).key?.replace(/^0x/, '') ?? '';
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32 || key.toString('hex') !== hex.toLowerCase()) {
    throw new Error(`dstack GetKey returned ${key.length} bytes, want 32`);
  }
  return key;
}

function postUnix(socketPath: string, path: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(Buffer.concat(chunks).toString('utf8'));
        else reject(new Error(`dstack ${path}: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
