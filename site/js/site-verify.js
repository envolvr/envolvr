// Runs the receipt verifier (verifier.js, built from site/src/verifier.ts) for
// the receipt check card and the "Verify" section. Every check happens in this browser.
import { verify, parseBundle, digestOf } from './verifier.js?v=20261001r';

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const GATEWAY = 'https://api.envolvr.xyz';
const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));

let samplePromise;
const sample = () => (samplePromise ??= fetch('data/sample-receipt.json?v=20261001r').then((r) => r.json()));

function setBadge(el, cls, text) {
  el.className = `badge ${cls}`;
  el.querySelector('span').textContent = text;
}

/** Tick the rows of a card one by one as the checks come back. Resolves to the counts. */
async function run(card, bundle, { pace, onTick }) {
  const rows = [...card.querySelectorAll('.vrow')];
  const defaults = rows.map((r) => (r.dataset.dt ??= r.querySelector('.dt').textContent));
  rows.forEach((r, i) => { r.classList.remove('pass', 'fail', 'skip'); r.querySelector('.dt').textContent = defaults[i]; });
  const results = [];
  const started = performance.now();
  for await (const step of verify(bundle)) {
    const wait = pace * (results.length + 1) - (performance.now() - started);
    if (wait > 0) await sleep(wait);
    const row = card.querySelector(`.vrow[data-id="${step.id}"]`);
    if (row) {
      row.classList.add(step.status);
      row.querySelector('.dt').textContent = step.detail;
      row.title = step.detail;
    }
    results.push(step);
    onTick?.(results.length, rows.length);
  }
  const failed = results.filter((s) => s.status === 'fail').length;
  const passed = results.filter((s) => s.status === 'pass').length;
  return { verified: failed === 0 && passed > 0, failed, passed, skipped: results.length - failed - passed };
}

// ---- receipt check card: the sample receipt, verified on load ----
const hero = document.getElementById('heroCard');
if (hero) {
  const badge = hero.querySelector('[data-state]');
  const foot = hero.querySelector('[data-foot]');
  const more = hero.querySelector('[data-more]');
  const extras = [...hero.querySelectorAll('.vrow.extra')];
  more.addEventListener('click', () => {
    const show = extras[0].hidden;
    extras.forEach((r) => { r.hidden = !show; });
    more.textContent = show ? 'Show fewer' : '+ 2 more checks: billing, anchor';
  });
  let busy = false;
  const go = async () => {
    if (busy) return;
    busy = true;
    setBadge(badge, 'white', 'checking 0/7');
    foot.textContent = 'Checking in your browser…';
    try {
      const v = await run(hero, await sample(), { pace: 220, onTick: (n, total) => setBadge(badge, 'white', `checking ${n}/${total}`) });
      setBadge(badge, v.verified ? 'ok' : 'bad', v.verified ? 'verified' : `${v.failed} failed`);
      foot.textContent = v.verified ? 'Verified in your browser, just now' : 'Checked in your browser, just now';
    } catch {
      setBadge(badge, 'idle', 'unavailable');
      foot.textContent = 'Could not load the sample receipt';
    } finally {
      busy = false;
    }
  };
  hero.querySelector('[data-rerun]').addEventListener('click', go);
  go();
}

// ---- verify section ----
const card = document.getElementById('verifyCard');
const input = document.getElementById('receiptInput');
if (card && input) {
  const btn = document.getElementById('verifyRun');
  const hint = document.querySelector('[data-v-hint]');
  const err = document.querySelector('[data-v-err]');
  const title = card.querySelector('[data-id]');
  const digestEl = card.querySelector('[data-digest]');
  const badge = card.querySelector('[data-state]');
  const tabs = [...document.querySelectorAll('[data-src]')];
  const hints = {
    sample: 'A real testnet receipt for z-ai/glm-5.3, served on Phala. Try editing the bill.',
    own: 'Paste receipt.json, or a bundle with its report, request, response and session from envolvr-receipts/.',
  };
  let own = '';
  setBadge(badge, 'idle', 'waiting');

  const showSample = async () => { input.value = JSON.stringify((await sample()).receipt, null, 2); };
  tabs.forEach((t) => t.addEventListener('click', async () => {
    const was = tabs.find((x) => x.getAttribute('aria-selected') === 'true')?.dataset.src;
    if (was === 'own') own = input.value;
    tabs.forEach((x) => x.setAttribute('aria-selected', x === t ? 'true' : 'false'));
    hint.textContent = hints[t.dataset.src];
    if (t.dataset.src === 'sample') await showSample();
    else { input.value = own; input.focus(); }
  }));

  // A bundle from the pasted text. The sample's receipt, even edited, keeps the
  // sample's report, bodies and session so a tampered field shows as a failure.
  const bundleFrom = async (text) => {
    const b = parseBundle(text);
    const s = await sample();
    if (b.receipt.receipt_id === s.receipt.receipt_id && !b.report) return { ...s, receipt: b.receipt };
    if (!b.report && typeof b.receipt.workload_keyset_digest === 'string') {
      // The live gateway's report, if it still serves the receipt's keyset.
      try {
        const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
        const r = await fetch(`${GATEWAY}/v1/aci/attestation?nonce=${nonce}`, { signal: AbortSignal.timeout(6000) });
        const report = await r.json();
        if (report.workload_keyset_digest === b.receipt.workload_keyset_digest) b.report = report;
      } catch { /* offline or a different keyset: the keyset check is skipped */ }
    }
    return b;
  };

  btn.addEventListener('click', async () => {
    err.hidden = true;
    let bundle;
    try {
      bundle = await bundleFrom(input.value);
    } catch (e) {
      err.textContent = `receipt.json does not parse: ${e.message}`;
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    title.textContent = 'Checking…';
    try { const d = digestOf(bundle.receipt).replace(/^0x/, ''); digestEl.textContent = `${d.slice(0, 4)}…${d.slice(-4)}`; } catch { digestEl.textContent = '–'; }
    setBadge(badge, '', 'checking');
    const v = await run(card, bundle, { pace: 140 });
    title.textContent = v.verified ? 'Receipt verified' : 'Receipt rejected';
    setBadge(badge, v.verified ? 'ok' : 'bad', v.verified ? 'verified' : `${v.failed} failed`);
    btn.disabled = false;
  });

  showSample();
}
