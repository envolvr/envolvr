(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---- top bar ----
  var nav = $('#nav');
  var toggle = $('#navToggle');
  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $$('a', nav).forEach(function (a) {
    a.addEventListener('click', function () { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); });
  });

  // ---- copy buttons ----
  function flash(btn, label) {
    var old = btn.textContent;
    btn.classList.add('done');
    if (label) btn.textContent = label;
    setTimeout(function () { btn.classList.remove('done'); if (label) btn.textContent = old; }, 1400);
  }
  function copy(text, btn, label) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { flash(btn, label); }, function () {});
  }
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () { copy(btn.getAttribute('data-copy'), btn, 'Copied'); });
  });
  var share = $('[data-share]');
  if (share) share.addEventListener('click', function () { copy(location.origin + location.pathname, share); });

  // ---- code tabs ----
  var code = $('#code');
  if (code) {
    var langTabs = $$('[data-lang]', $('.tabs', code));
    langTabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var lang = tab.getAttribute('data-lang');
        langTabs.forEach(function (t) { t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
        $$('pre[data-lang]', code).forEach(function (pre) { pre.hidden = pre.getAttribute('data-lang') !== lang; });
      });
    });
    var copyCode = $('[data-copy-code]', code);
    copyCode.addEventListener('click', function () {
      var pre = $$('pre[data-lang]', code).filter(function (p) { return !p.hidden; })[0];
      copy(pre.textContent, copyCode, 'Copied');
    });
  }

  // ---- side nav follows the section in view; back-to-top button ----
  var sideLinks = $$('.sidenav a');
  var toTop = $('.to-top');
  function onScroll() {
    var y = window.scrollY + window.innerHeight * 0.3;
    var current = null;
    sideLinks.forEach(function (a) {
      var sec = document.querySelector(a.getAttribute('href'));
      if (sec && sec.getBoundingClientRect().top + window.scrollY <= y) current = a;
    });
    sideLinks.forEach(function (a) { a.classList.toggle('on', a === current); });
    if (toTop) toTop.classList.toggle('on', window.scrollY > 900);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- privacy: the prompt seals as its card scrolls up the screen ----
  var seal = $('#seal');
  if (seal) {
    var textEl = $('[data-seal-text]', seal);
    var plain = textEl.textContent;
    var HEX = '0123456789abcdef';
    // Uniform groups of four, so no word length shows through.
    var cipher = plain.split('').map(function (ch, i) {
      if (i % 5 === 4) return ' ';
      return HEX[(i * 7 + ch.charCodeAt(0) * 13) % 16];
    });
    var order = plain.split('').map(function (_, i) { return i; }).sort(function (a, b) {
      return ((a * 37) % 101) - ((b * 37) % 101);
    });
    var rank = [];
    order.forEach(function (idx, r) { rank[idx] = r / order.length; });
    var bar = $('[data-seal-bar]', seal);
    var state = $('[data-seal-state]', seal);
    var note = $('[data-seal-note]', seal);
    var who = $('[data-seal-who]', seal);
    var viewBtns = $$('[data-view]', seal);
    var metas = $$('dd[data-a]', seal);
    var last = -1;
    var manual = false;

    function esc(ch) { return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch; }
    function render(p) {
      p = Math.max(0, Math.min(1, p));
      if (Math.abs(p - last) < 0.004) return;
      last = p;
      var html = '';
      for (var i = 0; i < plain.length; i++) {
        if (rank[i] < p) html += cipher[i] === ' ' ? ' ' : '<span class="c">' + cipher[i] + '</span>';
        else html += esc(plain[i]);
      }
      textEl.innerHTML = html;
      bar.style.width = (p * 100).toFixed(1) + '%';
      var sealed = p >= 0.999;
      var half = p > 0.5;
      seal.classList.toggle('sealed', sealed);
      state.className = 'vstate' + (sealed ? ' ok' : p > 0 ? ' running' : '');
      state.textContent = sealed ? 'sealed' : p > 0 ? 'sealing' : 'readable';
      who.textContent = half ? 'What the envolvr operator sees' : 'What a hosted model reads';
      note.textContent = sealed
        ? 'ⓘ The operator sees ciphertext, a model name and a measurement. The reasoning stays sealed.'
        : 'ⓘ Position, intent and timing, readable at the point of inference.';
      metas.forEach(function (dd) { dd.textContent = half ? dd.getAttribute('data-b') : dd.getAttribute('data-a'); });
      viewBtns.forEach(function (b) { b.setAttribute('aria-pressed', (b.getAttribute('data-view') === 'sealed') === half ? 'true' : 'false'); });
    }

    // Sealed by the time the card's top reaches the upper third of the screen.
    function progress() {
      if (manual || reduce) return;
      var r = seal.getBoundingClientRect();
      var vh = window.innerHeight;
      render((vh * 0.85 - r.top) / (vh * 0.55));
    }
    window.addEventListener('scroll', progress, { passive: true });
    window.addEventListener('resize', progress);
    progress();
    if (reduce) render(0);

    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var target = b.getAttribute('data-view') === 'sealed' ? 1 : 0;
        manual = true;
        if (reduce) { render(target); return; }
        var from = last < 0 ? 0 : last;
        var t0 = performance.now();
        (function step(now) {
          var k = Math.min(1, (now - t0) / 900);
          render(from + (target - from) * k);
          if (k < 1) requestAnimationFrame(step);
        })(t0);
      });
    });
  }

  // ---- charts, built from the model table ----
  var table = $('#modelTable');
  if (table) {
    var COLORS = { phala: '#1baf7a', near: '#8842fd', chutes: '#eb6834' };
    var rows = $$('tbody tr', table).map(function (tr) {
      var d = tr.dataset;
      var inp = parseFloat(d['in']);
      var out = parseFloat(d.out);
      var blend = (3 * inp + out) / 4;
      $('[data-blend]', tr).textContent = '$' + blend.toFixed(2);
      return { tr: tr, model: d.model, label: d.label, sup: d.sup, supName: d.supName, in: inp, out: out, blend: blend };
    });

    // A round step, so the gridlines sit at 0, 0.5, 1, 1.5 … and never 0.63.
    function axis(v) {
      var steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5];
      for (var i = 0; i < steps.length; i++) if (Math.ceil(v / steps[i]) <= 5) return { step: steps[i], n: Math.ceil(v / steps[i]) };
      return { step: 10, n: Math.ceil(v / 10) };
    }
    function money(v) { return '$' + v.toFixed(2); }

    function makeChart(el) {
      el.innerHTML = '<div class="chart-in"><div class="chart-plot"><div class="gridlines"></div><div class="bars"></div></div><div class="tip" role="tooltip"></div></div>';
      var grid = $('.gridlines', el);
      var barsEl = $('.bars', el);
      var tip = $('.tip', el);
      var host = $('.chart-in', el);
      var bars = {};

      function showTip(r, b) {
        tip.innerHTML = '<b>' + r.label + ' · ' + r.supName + '</b>'
          + '<div><span>Input</span><span>' + money(r.in) + '</span></div>'
          + '<div><span>Output</span><span>' + money(r.out) + '</span></div>'
          + '<div><span>Blended 3:1</span><span>' + money(r.blend) + '</span></div>';
        var hr = host.getBoundingClientRect();
        var br = b.getBoundingClientRect();
        var top = $('i', b).getBoundingClientRect().top;
        var x = Math.max(96, Math.min(hr.width - 96, br.left + br.width / 2 - hr.left));
        tip.style.left = x + 'px';
        tip.style.top = (top - hr.top - 24) + 'px';
        tip.classList.add('on');
      }
      function hideTip() { tip.classList.remove('on'); }

      return function draw(metric, sup) {
        var shown = rows.filter(function (r) { return sup === 'all' || r.sup === sup; })
          .sort(function (a, b) { return a[metric] - b[metric]; });
        var ax = axis(Math.max.apply(null, shown.map(function (r) { return r[metric]; })));
        var max = ax.step * ax.n;
        grid.innerHTML = '';
        for (var g = 0; g <= ax.n; g++) {
          var line = document.createElement('i');
          line.style.bottom = (g / ax.n * 100) + '%';
          if (g === 0) line.className = 'base';
          grid.appendChild(line);
        }
        $$('.bar', barsEl).forEach(function (b) { b.style.display = 'none'; });
        shown.forEach(function (r) {
          var key = r.model + '@' + r.sup;
          var b = bars[key];
          if (!b) {
            b = document.createElement('button');
            b.type = 'button';
            b.className = 'bar';
            b.style.setProperty('--c', COLORS[r.sup]);
            b.style.setProperty('--h', '0%');
            b.innerHTML = '<span class="v"></span><i></i><span class="x"><svg aria-hidden="true"><use href="images/suppliers.svg#' + r.sup + '"/></svg><span>' + r.label + '</span></span>';
            b.addEventListener('mouseenter', function () { showTip(r, b); });
            b.addEventListener('focus', function () { showTip(r, b); });
            b.addEventListener('mouseleave', hideTip);
            b.addEventListener('blur', hideTip);
            bars[key] = b;
          }
          barsEl.appendChild(b);
          b.style.display = '';
          b.setAttribute('aria-label', r.label + ' on ' + r.supName + ': ' + money(r[metric]) + ' per 1M tokens');
          $('.v', b).textContent = money(r[metric]);
          var h = (r[metric] / max * 100).toFixed(2) + '%';
          requestAnimationFrame(function () { requestAnimationFrame(function () { b.style.setProperty('--h', h); }); });
        });
      };
    }

    function whenVisible(el, fn) {
      if (!('IntersectionObserver' in window) || reduce) { fn(); return; }
      new IntersectionObserver(function (entries, obs) {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        fn();
      }, { threshold: 0.2 }).observe(el);
    }

    $$('[data-chart="in"], [data-chart="out"]').forEach(function (el) {
      var draw = makeChart(el);
      whenVisible(el, function () { draw(el.getAttribute('data-chart'), 'all'); });
    });

    var mainEl = $('[data-chart="main"]');
    if (mainEl) {
      var drawMain = makeChart(mainEl);
      var metric = 'blend';
      var sup = 'all';
      var titles = { blend: 'Blended price per 1M tokens', in: 'Input price per 1M tokens', out: 'Output price per 1M tokens' };
      var subs = {
        blend: 'USD per 1M tokens, 3 parts input to 1 part output · Lower is better',
        in: 'USD per 1M input tokens · Lower is better',
        out: 'USD per 1M output tokens · Lower is better',
      };
      var redraw = function () {
        drawMain(metric, sup);
        $('[data-chart-title]').textContent = titles[metric];
        $('[data-chart-sub]').textContent = subs[metric];
        rows.forEach(function (r) { r.tr.hidden = !(sup === 'all' || r.sup === sup); });
      };
      $$('[data-metric]').forEach(function (t, _, all) {
        t.addEventListener('click', function () {
          metric = t.getAttribute('data-metric');
          all.forEach(function (x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
          redraw();
        });
      });
      var select = $('[data-sup-select]');
      select.addEventListener('change', function () { sup = select.value; redraw(); });
      whenVisible(mainEl, redraw);
    }
  }

  // ---- how it works: one request, hop by hop ----
  var flow = $('#flow');
  if (flow) {
    var STEPS = [
      { what: 'The client checks the gateway’s attestation quote against a known build, then encrypts the prompt to a key that exists only inside that enclave.',
        proof: 'The enclave is genuine and runs a measured, public build.' },
      { what: 'envolvr’s gateway opens the request inside Intel TDX, verifies the GPU provider’s attestation, and forwards only over a channel bound to it.',
        proof: 'Nothing outside the enclaves sees plaintext. That includes us.' },
      { what: 'The model runs on a confidential GPU that the gateway verified before it forwarded a single byte.',
        proof: 'The operator holds the hardware, not the key.' },
      { what: 'The gateway signs the model, the attested session, commitments to the exact request and response, and the bill.',
        proof: 'Every response is bound to its model and its attested provider.' },
      { what: 'Receipt digests are batched into a Merkle root on Robinhood Chain every ten minutes.',
        proof: 'Anyone can check it, any time, without trusting envolvr.' },
    ];
    var tabs = $$('.node', flow);
    var nodes = $$('.flow-node', flow);
    var what = $('[data-flow-what]', flow);
    var proofEl = $('[data-flow-proof]', flow);
    var k = $('[data-flow-k]', flow);
    var lineI = $('[data-flow-line]', flow);
    var packet = $('[data-flow-packet]', flow);
    var cur = 0;
    var timer = null;
    var auto = !reduce;

    function show(i) {
      cur = i;
      tabs.forEach(function (t, j) { t.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
      nodes.forEach(function (n, j) { n.classList.toggle('on', j === i); n.classList.toggle('done', j < i); });
      k.textContent = 'Hop ' + (i + 1) + ' of 5 · What happens';
      what.textContent = STEPS[i].what;
      proofEl.textContent = STEPS[i].proof;
      lineI.style.width = (i / 4 * 100) + '%';
      packet.style.left = (10 + i * 20) + '%';
    }
    function tick() { timer = setTimeout(function () { show((cur + 1) % 5); tick(); }, 3600); }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { auto = false; clearTimeout(timer); show(i); });
    });
    show(0);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        clearTimeout(timer);
        if (entries[0].isIntersecting && auto) tick();
      }, { threshold: 0.4 }).observe(flow);
    }
  }
})();
