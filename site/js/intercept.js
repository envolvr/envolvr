// Intercepted prompt, on a loop that always moves left to right:
//   1. the prompt enters from the left in plain text, under a red label (what a
//      hosted provider sees);
//   2. a volt beam sweeps across it and turns it into ciphertext as it passes,
//      while the label slides over to green (what envolvr's operator sees);
//   3. only then the receipt card slides in and verifies the response's receipt
//      (site-verify.js), and the sealed prompt and receipt hold for a while;
//   4. the ciphertext and the receipt exit to the right, and the next prompt enters.
// It runs only while the strip is in view and the tab is visible; the button
// pauses it. With reduced motion the states cross-fade without sliding.
(function () {
  'use strict';
  var root = document.getElementById('intercept');
  if (!root || !root.animate) return;
  var text = root.querySelector('[data-ic-text]');
  var beam = root.querySelector('.ic-beam');
  var label = root.querySelector('[data-ic-label]');
  var note = root.querySelector('[data-ic-note]');
  var toggle = root.querySelector('[data-ic-toggle]');
  var receipt = root.querySelector('.ic-receipt');
  var PLAIN = text.textContent;
  var COPY = {
    plain: ['What a hosted provider sees', 'Plain text, at the point of inference: position, intent and timing.'],
    sealed: ['What envolvr\'s operator sees', 'Ciphertext. Only the attested model enclave decrypts it, and every response comes back with a signed receipt.'],
  };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var HEX = '0123456789abcdef';
  // holdSealed: the sealed prompt and its verified receipt stay up long enough to take in.
  var T = { enter: 380, holdPlain: 2200, sweep: 1500, holdSealed: 8600, exit: 340, gap: 160 };
  var run = 0, inView = false, paused = false, active = false;

  function cipher(n) {
    var out = '';
    for (var i = 0; i < n; i++) out += (i && i % 9 === 0) ? ' ' : HEX[(Math.random() * 16) | 0];
    return out;
  }
  var esc = function (v) { return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  // Characters behind the beam are sealed (violet), a little noise rides on it (volt), the rest is still plain.
  function frame(from, to, p) {
    var len = Math.round(from.length + (to.length - from.length) * p), sealed = '', noise = '', plain = '';
    for (var i = 0; i < len; i++) {
      var edge = i / len;
      if (edge < p - 0.06) sealed += to[i] || ' ';
      else if (edge < p + 0.04) noise += to[i] === ' ' ? ' ' : HEX[(Math.random() * 16) | 0]; // keep the word breaks
      else plain += from[i] || ' ';
    }
    return '<span class="ic-s">' + esc(sealed) + '</span><span class="ic-n">' + esc(noise) + '</span><span class="ic-p">' + esc(plain) + '</span>';
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function anim(el, frames, ms, easing) {
    if (reduce) frames = frames.map(function (f) { return { opacity: f.opacity === undefined ? 1 : f.opacity }; });
    return el.animate(frames, { duration: ms, easing: easing || 'ease', fill: 'forwards' }).finished.catch(function () {});
  }
  // Slide the old words out to the right and the new ones in from the left.
  async function swap(el, value) {
    await anim(el, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(14px)', opacity: 0 }], 140, 'ease-in');
    el.textContent = value;
    await anim(el, [{ transform: 'translateX(-14px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], 220, 'cubic-bezier(.2,.8,.2,1)');
  }
  // The receipt card: hidden until the prompt is sealed, then shown, then leaving with the ciphertext.
  function receiptTo(state) {
    root.setAttribute('data-receipt', state);
    if (receipt) receipt.inert = state !== 'shown';
  }
  function to(state) {
    root.setAttribute('data-state', state);
    return Promise.all([swap(label, COPY[state][0]), swap(note, COPY[state][1])]);
  }

  async function loop(id) {
    var live = function () { return id === run; };
    while (live()) {
      // A fresh start (in view again, or after a pause) clears a receipt still showing.
      if (root.getAttribute('data-receipt') !== 'hidden') {
        receiptTo('leaving');
        await sleep(T.exit);
        receiptTo('hidden');
        if (!live()) return;
      }
      // 1. Enter from the left, readable.
      text.textContent = PLAIN;
      var entering = anim(text, [{ transform: 'translateX(-48px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], T.enter, 'cubic-bezier(.16,1,.3,1)');
      if (root.getAttribute('data-state') !== 'plain') await Promise.all([entering, to('plain')]); else await entering;
      root.dispatchEvent(new CustomEvent('envolvr:plain', { bubbles: true }));
      await sleep(T.holdPlain);
      if (!live()) return;

      // 2. The beam sweeps left to right and seals what it passes.
      var target = cipher(PLAIN.length);
      if (reduce) {
        await anim(text, [{ opacity: 1 }, { opacity: 0 }], 200);
        text.textContent = target;
        await Promise.all([anim(text, [{ opacity: 0 }, { opacity: 1 }], 300), to('sealed')]);
      } else {
        var width = text.getBoundingClientRect().width;
        anim(beam, [
          { transform: 'translateX(-24px) skewX(-20deg)', opacity: 0 },
          { transform: 'translateX(' + width * 0.1 + 'px) skewX(-20deg)', opacity: 1, offset: 0.1 },
          { transform: 'translateX(' + width * 0.9 + 'px) skewX(-20deg)', opacity: 1, offset: 0.9 },
          { transform: 'translateX(' + (width + 24) + 'px) skewX(-20deg)', opacity: 0 },
        ], T.sweep, 'linear');
        var flipped = false, labelDone;
        await new Promise(function (resolve) {
          var t0 = performance.now();
          (function tick(now) {
            if (!live()) return resolve();
            var p = Math.min(1, (now - t0) / T.sweep);
            if (p >= 1) text.textContent = target; else text.innerHTML = frame(PLAIN, target, p);
            if (!flipped && p >= 0.45) { flipped = true; labelDone = to('sealed'); }
            if (p >= 1) resolve(); else requestAnimationFrame(tick);
          })(t0);
        });
        await labelDone;
      }
      if (!live()) return;
      // The response is back: its receipt is verified in the card beside it.
      receiptTo('shown');
      root.dispatchEvent(new CustomEvent('envolvr:sealed', { bubbles: true }));
      await sleep(T.holdSealed);
      if (!live()) return;

      // 3. Exit to the right.
      receiptTo('leaving');
      await anim(text, [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(64px)', opacity: 0 }], T.exit, 'cubic-bezier(.7,0,.84,0)');
      await sleep(T.gap);
      receiptTo('hidden');
    }
  }

  function start() {
    if (active || !inView || paused || document.hidden) return;
    active = true;
    var id = ++run;
    loop(id).finally(function () { if (id === run) active = false; });
  }
  function stop() { run++; active = false; }

  // Reserve the taller of each pair (plain and sealed note, prompt and ciphertext)
  // at the current width, so the panel never changes height mid-loop.
  function reserve() {
    var sample = cipher(PLAIN.length);
    [[note, [COPY.plain[1], COPY.sealed[1]]], [text, [PLAIN, sample]]].forEach(function (pair) {
      var el = pair[0], keep = el.innerHTML, h = 0;
      el.style.minHeight = '';
      pair[1].forEach(function (v) { el.textContent = v; h = Math.max(h, el.getBoundingClientRect().height); });
      el.innerHTML = keep;
      el.style.minHeight = Math.ceil(h) + 'px';
    });
  }
  reserve();
  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(reserve, 150); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reserve);

  toggle.addEventListener('click', function () {
    paused = !paused;
    toggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
    toggle.textContent = paused ? 'Play' : 'Pause';
    root.classList.toggle('ic-paused', paused);
    if (paused) stop(); else start();
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
  if (!('IntersectionObserver' in window)) { inView = true; start(); return; }
  new IntersectionObserver(function (entries) {
    inView = entries[entries.length - 1].isIntersecting;
    if (inView) start(); else stop();
  }, { threshold: 0.4 }).observe(root);
})();
