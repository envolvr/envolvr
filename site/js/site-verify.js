// Runs the receipt verifier (verifier.js, built from site/src/verifier.ts) for
// the hero card and the "Verify" section. Every check happens in this browser.
import { verify, parseBundle, digestOf } from './verifier.js?v=20261001e';

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const GATEWAY = 'https://api.envolvr.xyz';
const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));

let samplePromise;
const sample = () => (samplePromise ??= fetch('data/sample-receipt.json?v=20261001e').then((r) => r.json()));

/** Animate a verification run into a .vcard. Resolves to the verdict. */
async function run(card, bundle, { pace = 260 } = {}) {
  const rows = [...card.querySelectorAll('.vrow')];
  const state = card.querySelector('[data-state]');
  const defaults = rows.map((r) => r.dataset.dt ??= r.querySelector('.dt').textContent);
  rows.forEach((r, i) => { r.className = 'vrow'; r.querySelector('.dt').textContent = defaults[i]; });
  card.classList.remove('is-verified');
  state.className = 'vstate running';
  state.textContent = 'verifying';

  const results = [];
  let i = 0;
  const started = performance.now();
  rows[0]?.classList.add('wait');
  for await (const step of verify(bundle)) {
    const row = card.querySelector(`.vrow[data-id="${step.id}"]`);
    const wait = pace - (performance.now() - started - i * pace);
    if (wait > 0) await sleep(wait);
    if (row) {
      row.className = `vrow ${step.status}`;
      row.querySelector('.dt').textContent = step.detail;
      row.title = step.detail;
    }
    results.push(step);
    i += 1;
    rows[i]?.classList.add('wait');
  }
  await sleep(pace);
  const failed = results.filter((s) => s.status === 'fail').length;
  const passed = results.filter((s) => s.status === 'pass').length;
  const verified = failed === 0 && passed > 0;
  state.className = `vstate ${verified ? 'ok' : 'bad'}`;
  state.textContent = verified ? 'verified' : `${failed} check${failed === 1 ? '' : 's'} failed`;
  card.classList.toggle('is-verified', verified);
  return { verified, failed, passed, skipped: results.length - failed - passed };
}

// ---- hero: the sample receipt, verified when it scrolls into view ----
const hero = document.getElementById('heroCard');
if (hero) {
  const foot = hero.querySelector('[data-foot]');
  let busy = false;
  const go = async () => {
    if (busy) return;
    busy = true;
    try {
      const b = await sample();
      const v = await run(hero, b, { pace: 300 });
      foot.textContent = v.verified ? 'Verified in your browser, just now' : 'Checked in your browser, just now';
    } catch {
      foot.textContent = 'Could not load the sample receipt.';
    } finally {
      busy = false;
    }
  };
  hero.querySelector('[data-rerun]').addEventListener('click', go);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries, obs) => {
      if (!entries[0].isIntersecting) return;
      obs.disconnect();
      setTimeout(go, reduce ? 0 : 500);
    }, { threshold: 0.4 }).observe(hero);
  } else {
    go();
  }
}

// ---- verify section ----
const card = document.getElementById('verifyCard');
const input = document.getElementById('receiptInput');
if (card && input) {
  const btn = document.getElementById('verifyRun');
  const hint = document.querySelector('[data-v-hint]');
  const err = document.querySelector('[data-v-err]');
  const idEl = card.querySelector('[data-id]');
  const digestEl = card.querySelector('[data-digest]');
  const verdict = card.querySelector('[data-verdict]');
  const tabs = [...document.querySelectorAll('[data-src]')];
  const hints = {
    sample: 'A real testnet receipt for z-ai/glm-5.3, served on Phala. Try editing the bill.',
    own: 'Paste receipt.json, or a bundle with its report, request, response and session from envolvr-receipts/.',
  };
  let own = '';

  const showSample = async () => {
    const b = await sample();
    input.value = JSON.stringify(b.receipt, null, 2);
  };
  tabs.forEach((t) => t.addEventListener('click', async () => {
    const src = t.dataset.src;
    const was = tabs.find((x) => x.getAttribute('aria-selected') === 'true')?.dataset.src;
    if (was === 'own') own = input.value;
    tabs.forEach((x) => x.setAttribute('aria-selected', x === t ? 'true' : 'false'));
    hint.textContent = hints[src];
    if (src === 'sample') await showSample();
    else { input.value = own; input.focus(); }
  }));

  // A bundle from the pasted text. The sample's receipt, even edited, keeps the
  // sample's report, bodies and session so a tampered field shows as a failure.
  const bundleFrom = async (text) => {
    const b = parseBundle(text);
    const s = await sample();
    if (b.receipt.receipt_id === s.receipt.receipt_id && !b.report) {
      return { ...s, receipt: b.receipt };
    }
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
      err.textContent = `Could not read that: ${e.message}`;
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    idEl.textContent = `${bundle.receipt.receipt_id} · ${bundle.receipt.model ?? ''}`;
    try { digestEl.textContent = `${digestOf(bundle.receipt).slice(0, 10)}…`; } catch { digestEl.textContent = '—'; }
    verdict.textContent = '';
    const v = await run(card, bundle, { pace: 320 });
    verdict.textContent = v.verified ? (v.skipped ? `VERIFIED · ${v.skipped} skipped` : 'VERIFIED') : 'FAILED';
    btn.disabled = false;
  });

  showSample();
}
