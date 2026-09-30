(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---- nav ----
  var nav = $('#nav');
  var toggle = $('#navToggle');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $$('.nav-links a, .nav-actions a', nav).forEach(function (a) {
    a.addEventListener('click', function () { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); });
  });

  // ---- copy buttons ----
  function copied(btn) {
    var label = btn.textContent;
    btn.classList.add('done');
    btn.textContent = 'Copied';
    setTimeout(function () { btn.classList.remove('done'); btn.textContent = label; }, 1400);
  }
  function copy(text, btn) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { copied(btn); }, function () {});
  }
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () { copy(btn.getAttribute('data-copy'), btn); });
  });

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
      copy(pre.textContent, copyCode);
    });
  }

  // ---- problem: the prompt seals as the section scrolls past ----
  var seal = $('#seal');
  if (seal) {
    var textEl = $('[data-seal-text]', seal);
    var plain = textEl.textContent;
    var HEX = '0123456789abcdef';
    // A fixed cipher per character, so the same scroll position always shows the same text.
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
    var manual = null;

    function render(p) {
      p = Math.max(0, Math.min(1, p));
      if (Math.abs(p - last) < 0.004) return;
      last = p;
      var html = '';
      for (var i = 0; i < plain.length; i++) {
        var ch = plain[i];
        if (rank[i] < p) html += cipher[i] === ' ' ? ' ' : '<span class="c">' + cipher[i] + '</span>';
        else html += ch.replace('&', '&amp;').replace('<', '&lt;');
      }
      textEl.innerHTML = html;
      bar.style.width = (p * 100).toFixed(1) + '%';
      var sealed = p >= 0.999;
      seal.classList.toggle('sealed', sealed);
      state.className = 'vstate' + (sealed ? ' ok' : p > 0 ? ' running' : '');
      state.textContent = sealed ? 'sealed' : p > 0 ? 'sealing' : 'readable';
      who.textContent = p > 0.5 ? 'envolvr · attested enclave' : 'hosted model';
      note.textContent = sealed
        ? 'The operator sees ciphertext, a model name and a measurement. The reasoning stays sealed.'
        : 'Position, intent and timing, readable at the point of inference.';
      metas.forEach(function (dd) { dd.textContent = p > 0.5 ? dd.getAttribute('data-b') : dd.getAttribute('data-a'); });
      viewBtns.forEach(function (b) { b.setAttribute('aria-pressed', (b.getAttribute('data-view') === 'sealed') === p > 0.5 ? 'true' : 'false'); });
    }

    var section = $('#problem');
    var sticky = window.matchMedia('(min-width: 901px)');
    function progress() {
      if (manual !== null) return;
      if (!sticky.matches || reduce) return;
      var r = section.getBoundingClientRect();
      var span = section.offsetHeight - window.innerHeight;
      render(span > 0 ? (-r.top - span * 0.15) / (span * 0.6) : 0);
    }
    window.addEventListener('scroll', progress, { passive: true });
    window.addEventListener('resize', progress);
    progress();

    // Buttons: an animated seal or unseal, and the scroll stops driving it.
    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var target = b.getAttribute('data-view') === 'sealed' ? 1 : 0;
        manual = target;
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

    // Narrow screens: seal once when the card comes into view.
    if (!sticky.matches && 'IntersectionObserver' in window && !reduce) {
      new IntersectionObserver(function (entries, obs) {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        setTimeout(function () { viewBtns[1].click(); }, 500);
      }, { threshold: 0.6 }).observe(seal);
    }
  }

  // ---- models: chart built from the table ----
  var table = $('#modelTable');
  var chart = $('#chart');
  if (table && chart) {
    var rows = $$('tbody tr', table).map(function (tr) {
      var d = tr.dataset;
      var inp = parseFloat(d['in']);
      var out = parseFloat(d.out);
      var blend = (3 * inp + out) / 4;
      $('[data-blend]', tr).textContent = '$' + blend.toFixed(2);
      return { tr: tr, model: d.model, creator: d.creator, sup: d.sup, supName: d.supName, in: inp, out: out, blend: blend };
    });
    var metric = 'blend';
    var sup = 'all';
    var titles = { blend: 'Blended price, USD per 1M tokens', in: 'Input price, USD per 1M tokens', out: 'Output price, USD per 1M tokens' };
    var barsEl = $('[data-bars]', chart);
    var gridEl = $('[data-grid]', chart);
    var tip = $('[data-tip]', chart);
    var bars = {};

    // A round step, so the axis reads 0, 0.5, 1, 1.5 … and never 0.63.
    function axis(v) {
      var steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5];
      for (var i = 0; i < steps.length; i++) if (Math.ceil(v / steps[i]) <= 6) return { step: steps[i], n: Math.ceil(v / steps[i]) };
      return { step: 10, n: Math.ceil(v / 10) };
    }
    function money(v) { return '$' + v.toFixed(2); }

    function draw() {
      var shown = rows.filter(function (r) { return sup === 'all' || r.sup === sup; })
        .sort(function (a, b) { return a[metric] - b[metric]; });
      var ax = axis(Math.max.apply(null, shown.map(function (r) { return r[metric]; })));
      var max = ax.step * ax.n;
      gridEl.innerHTML = '';
      for (var g = 0; g <= ax.n; g++) {
        var line = document.createElement('div');
        line.style.bottom = (g / ax.n * 100) + '%';
        if (g === 0) line.className = 'base';
        line.innerHTML = '<span>$' + (ax.step * g).toFixed(2) + '</span>';
        gridEl.appendChild(line);
      }
      $$('.bar', barsEl).forEach(function (b) { b.style.display = 'none'; });
      shown.forEach(function (r, i) {
        var key = r.model + '@' + r.sup;
        var b = bars[key];
        if (!b) {
          b = document.createElement('button');
          b.type = 'button';
          b.className = 'bar';
          b.innerHTML = '<span class="v"></span><i></i><span class="x"><svg aria-hidden="true"><use href="images/suppliers.svg#' + r.sup + '"/></svg><span>' + r.model + '</span></span>';
          b.addEventListener('mouseenter', function () { showTip(r, b); });
          b.addEventListener('focus', function () { showTip(r, b); });
          b.addEventListener('mouseleave', hideTip);
          b.addEventListener('blur', hideTip);
          bars[key] = b;
          b.style.setProperty('--h', '0%');
        }
        barsEl.appendChild(b);
        b.style.display = '';
        b.classList.toggle('best', i === 0);
        b.setAttribute('aria-label', r.model + ' on ' + r.supName + ': ' + money(r[metric]) + ' per 1M tokens');
        $('.v', b).textContent = money(r[metric]);
        var h = (r[metric] / max * 100).toFixed(2) + '%';
        requestAnimationFrame(function () { b.style.setProperty('--h', h); });
      });
      $('[data-chart-title]').textContent = titles[metric];
      $('[data-chart-sub]').textContent = (metric === 'blend' ? '3 parts input to 1 part output · ' : '') + 'lower is cheaper';
      rows.forEach(function (r) { r.tr.hidden = !(sup === 'all' || r.sup === sup); });
    }

    function showTip(r, b) {
      tip.innerHTML = '<b>' + r.model + '</b>'
        + '<div><span>supplier</span><span>' + r.supName + '</span></div>'
        + '<div><span>input</span><span>' + money(r.in) + '</span></div>'
        + '<div><span>output</span><span>' + money(r.out) + '</span></div>'
        + '<div><span>blended 3:1</span><span>' + money(r.blend) + '</span></div>';
      var host = tip.parentNode.getBoundingClientRect();
      var br = b.getBoundingClientRect();
      var bar = $('i', b).getBoundingClientRect();
      var x = br.left + br.width / 2 - host.left;
      x = Math.max(100, Math.min(host.width - 100, x));
      tip.style.left = x + 'px';
      tip.style.top = (bar.top - host.top - 28) + 'px';
      tip.classList.add('on');
    }
    function hideTip() { tip.classList.remove('on'); }

    $$('[data-metric]').forEach(function (t, _, all) {
      t.addEventListener('click', function () {
        metric = t.getAttribute('data-metric');
        all.forEach(function (x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
        draw();
      });
    });
    $$('[data-sup]', $('.chips')).forEach(function (c, _, all) {
      c.addEventListener('click', function () {
        sup = c.getAttribute('data-sup');
        all.forEach(function (x) { x.setAttribute('aria-pressed', x === c ? 'true' : 'false'); });
        draw();
      });
    });

    // Draw when the chart first comes into view, so the bars grow in.
    if ('IntersectionObserver' in window && !reduce) {
      var drawn = false;
      new IntersectionObserver(function (entries, obs) {
        if (!entries[0].isIntersecting || drawn) return;
        drawn = true;
        obs.disconnect();
        draw();
      }, { threshold: 0.25 }).observe(chart);
    } else {
      draw();
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
    var nodes = $$('.node', flow);
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
      nodes.forEach(function (n, j) {
        n.classList.toggle('on', j === i);
        n.classList.toggle('done', j < i);
        n.setAttribute('aria-pressed', j === i ? 'true' : 'false');
      });
      k.textContent = 'Hop ' + (i + 1) + ' of 5 · what happens';
      what.textContent = STEPS[i].what;
      proofEl.textContent = STEPS[i].proof;
      lineI.style.width = (i / 4 * 100) + '%';
      packet.style.left = (10 + i * 20) + '%';
    }
    function tick() {
      timer = setTimeout(function () { show((cur + 1) % 5); tick(); }, 3600);
    }
    nodes.forEach(function (n, i) {
      n.addEventListener('click', function () {
        auto = false;
        clearTimeout(timer);
        show(i);
      });
    });
    show(0);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        clearTimeout(timer);
        if (entries[0].isIntersecting && auto) tick();
      }, { threshold: 0.4 }).observe(flow);
    }
  }

  // ---- reveal on scroll ----
  var reveals = $$('.reveal');
  if (!('IntersectionObserver' in window)) { reveals.forEach(function (el) { el.classList.add('in'); }); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  reveals.forEach(function (el) { io.observe(el); });
})();
