(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

  // ---- menu: a dropdown card under the header below 1000px ----
  var toggle = $('#navToggle');
  var menu = $('#menu');
  function setMenu(open) {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  toggle.addEventListener('click', function () { setMenu(menu.hidden); });
  $$('a', menu).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); toggle.focus(); } });
  window.addEventListener('resize', function () { if (window.innerWidth >= 1000 && !menu.hidden) setMenu(false); });

  // ---- copy buttons: the label reads "Copied" for 1.4s ----
  function copy(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  }
  $$('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copy(b.getAttribute('data-copy'), b); }); });

  // ---- numbered sidebar follows the section in view ----
  var tocLinks = $$('.toc a');
  if ('IntersectionObserver' in window && tocLinks.length) {
    var tocIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        tocLinks.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id); });
      });
    }, { rootMargin: '-35% 0px -60% 0px' });
    tocLinks.forEach(function (a) { var s = $(a.getAttribute('href')); if (s) tocIo.observe(s); });
  }

  // ---- privacy: hosted model vs envolvr; the prompt seals when the card comes into view ----
  var seal = $('#seal');
  if (seal) {
    var textEl = $('[data-seal-text]', seal);
    var plain = textEl.textContent;
    var HEX = '0123456789abcdef';
    // Uniform groups of four, so no word length shows through.
    var cipher = plain.split('').map(function (ch, i) { return i % 5 === 4 ? ' ' : HEX[(i * 7 + ch.charCodeAt(0) * 13) % 16]; });
    var order = plain.split('').map(function (_, i) { return i; }).sort(function (a, b) { return ((a * 37) % 101) - ((b * 37) % 101); });
    var rank = [];
    order.forEach(function (idx, r) { rank[idx] = r / order.length; });
    var bar = $('[data-seal-bar]', seal);
    var badge = $('[data-seal-state]', seal);
    var note = $('[data-seal-note]', seal);
    var who = $('[data-seal-who]', seal);
    var viewBtns = $$('[data-view]', seal);
    var metas = $$('b[data-a]', seal);
    var last = -1;
    var touched = false;
    var anim = 0;

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
      badge.className = 'badge ' + (half ? 'ok' : 'badge-red');
      $('span', badge).textContent = sealed ? 'sealed' : p > 0 ? 'sealing' : 'readable';
      who.textContent = half ? 'What the envolvr operator sees' : 'What the hosted provider sees';
      note.textContent = half
        ? 'ⓘ The operator sees ciphertext, a model name and a measurement. The reasoning stays sealed.'
        : 'ⓘ Position, intent and timing, all readable at the point of inference.';
      metas.forEach(function (b) { b.textContent = half ? b.getAttribute('data-b') : b.getAttribute('data-a'); });
      viewBtns.forEach(function (b) { b.setAttribute('aria-pressed', (b.getAttribute('data-view') === 'sealed') === half ? 'true' : 'false'); });
    }
    function animateTo(target) {
      cancelAnimationFrame(anim);
      if (reduce) { render(target); return; }
      var from = last < 0 ? 0 : last;
      var t0 = performance.now();
      (function step(now) {
        var k = Math.min(1, (now - t0) / 1000);
        render(from + (target - from) * k);
        if (k < 1) anim = requestAnimationFrame(step);
      })(t0);
    }
    render(0);
    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () { touched = true; animateTo(b.getAttribute('data-view') === 'sealed' ? 1 : 0); });
    });
    if (reduce || !('IntersectionObserver' in window)) {
      render(1);
    } else {
      new IntersectionObserver(function (entries, obs) {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        setTimeout(function () { if (!touched) animateTo(1); }, 450);
      }, { threshold: 0.55 }).observe(seal);
    }
  }

  // ---- charts, built from the model table ----
  var table = $('#modelTable');
  if (table) {
    var rows = $$('tbody tr', table).map(function (tr) {
      var d = tr.dataset;
      var inp = parseFloat(d['in']);
      var out = parseFloat(d.out);
      var blend = (3 * inp + out) / 4;
      $('[data-blend]', tr).textContent = '$' + blend.toFixed(2);
      return { tr: tr, model: $('code', tr).textContent, label: d.label, sup: d.sup, supName: d.supName, in: inp, out: out, blend: blend };
    });
    var money = function (v) { return '$' + v.toFixed(2); };
    // One colour per model (v5); a model served by several suppliers keeps its colour.
    var MODEL_COLORS = {
      'z-ai/glm-5.3': '#1c1c1c', 'z-ai/glm-5.3-flash': '#2f7bff', 'qwen/qwen3.8-27b': '#ff6a13', 'qwen/qwen3.6-35b-a3b': '#36b24a',
      'deepseek/deepseek-v4-flash': '#1a2fd0', 'deepseek/deepseek-v3.2': '#00e0d0', 'moonshotai/kimi-k2.6': '#ff3d7f',
    };
    var tile = function (sup) { return '<span class="tile ' + sup + '"><svg aria-hidden="true"><use href="images/suppliers.svg#' + sup + '"/></svg></span>'; };

    // Bars reach 84% of the plot at the highest value across every endpoint, so filters keep the scale.
    function draw(el, metric, list, animate) {
      var max = Math.max.apply(null, rows.map(function (r) { return r[metric]; }));
      var shown = list.slice().sort(function (a, b) { return a[metric] - b[metric]; });
      el.innerHTML = '<div class="plot">' + shown.map(function (r) {
        return '<div class="col" title="' + esc(r.label + ' · ' + r.supName + ' · input ' + money(r.in) + ', output ' + money(r.out)) + '">'
          + '<span class="val">' + money(r[metric]) + '</span>'
          + '<span class="bar" style="--c:' + (MODEL_COLORS[r.model] || '#111512') + '" data-h="' + Math.max(2, r[metric] / max * 84).toFixed(2) + '%"></span></div>';
      }).join('') + '</div><div class="labels" aria-hidden="true">' + shown.map(function (r) {
        return '<div class="lcol">' + tile(r.sup) + '<span>' + esc(r.label) + '</span></div>';
      }).join('') + '</div>';
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', shown.map(function (r) { return r.label + ' on ' + r.supName + ' ' + money(r[metric]); }).join(', '));
      var bars = $$('.bar', el);
      var set = function () { bars.forEach(function (b) { b.style.height = b.getAttribute('data-h'); }); };
      if (animate && !reduce) requestAnimationFrame(function () { requestAnimationFrame(set); });
      else { bars.forEach(function (b) { b.style.transition = 'none'; }); set(); }
    }
    function whenVisible(el, fn) {
      if (reduce || !('IntersectionObserver' in window)) { fn(false); return; }
      new IntersectionObserver(function (entries, obs) {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        fn(true);
      }, { threshold: 0.2 }).observe(el);
    }
    $$('[data-chart="in"], [data-chart="out"]').forEach(function (el) {
      whenVisible(el, function (a) { draw(el, el.getAttribute('data-chart'), rows, a); });
    });

    var mainEl = $('[data-chart="main"]');
    if (mainEl) {
      var metric = 'blend';
      var off = {};
      var titles = { blend: 'Blended price per 1M tokens', in: 'Input price per 1M tokens', out: 'Output price per 1M tokens' };
      var subs = {
        blend: 'USD per 1M tokens, 3 parts input to 1 part output · Lower is better',
        in: 'USD per 1M input tokens · Lower is better',
        out: 'USD per 1M output tokens · Lower is better',
      };
      var redraw = function (animate) {
        var shown = rows.filter(function (r) { return !off[r.sup]; });
        draw(mainEl, metric, shown, animate);
        $('[data-chart-title]').textContent = titles[metric];
        $('[data-chart-sub]').textContent = subs[metric];
        $('[data-count]').textContent = shown.length + ' of ' + rows.length + ' endpoints';
        var tbody = $('tbody', table);
        shown.slice().sort(function (a, b) { return a[metric] - b[metric]; }).forEach(function (r) { tbody.appendChild(r.tr); });
        rows.forEach(function (r) { r.tr.hidden = !!off[r.sup]; });
      };
      $$('[data-metric]').forEach(function (t, _, all) {
        t.addEventListener('click', function () {
          metric = t.getAttribute('data-metric');
          all.forEach(function (x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
          redraw(true);
        });
      });
      $$('[data-sup]', $('.chips')).forEach(function (c) {
        c.addEventListener('click', function () {
          var s = c.getAttribute('data-sup');
          off[s] = !off[s];
          c.setAttribute('aria-pressed', off[s] ? 'false' : 'true');
          redraw(true);
        });
      });
      whenVisible(mainEl, redraw);
    }
  }

  // ---- how it works: tabs and a row of hops on wide screens, an accordion on phones ----
  var HOPS = [
    ['Agent', 'sdk · verifying proxy', '◉', 'The SDK and the verifying proxy pull the gateway’s attestation quote and check it against a known build. If it does not match, the prompt never leaves the machine.', 'You are talking to the measured gateway, not an impostor.'],
    ['Gateway', 'intel tdx', '⬡', 'envolvr’s gateway opens the request inside Intel TDX, verifies the GPU provider’s attestation, and forwards only over a channel bound to it.', 'Nothing outside the enclaves sees plaintext. That includes us.'],
    ['GPU enclave', 'nvidia cc', '▣', 'Inference runs on a GPU TEE the gateway verified before forwarding a single byte. The operator holds the machine, not the data.', 'The session that served the model is attested, and the receipt cites it.'],
    ['Receipt', 'ed25519 · signed', '▤', 'The gateway signs a receipt that binds the model, the attested session, commitments to the exact request and response, and the bill.', 'Change one character of the exchange and verification fails.'],
    ['Robinhood Chain', 'merkle anchor', '⛬', 'Receipt digests go on chain in Merkle batches every ten minutes, with an inclusion proof for every receipt.', 'The full receipt history stays auditable by anyone.'],
  ];
  var hopTabs = $('[data-hop-tabs]');
  var hopRow = $('[data-hop-row]');
  var hopList = $('[data-hop-list]');
  if (hopTabs && hopRow && hopList) {
    var hop = 1;
    hopTabs.innerHTML = HOPS.map(function (h, i) { return '<button type="button" role="tab" data-hop="' + i + '">' + esc(h[0]) + '</button>'; }).join('');
    hopRow.innerHTML = HOPS.map(function (h, i) {
      return '<div class="hop">' + (i < 4 ? '<span class="link"></span>' : '')
        + '<button class="hop-box" type="button" data-hop="' + i + '" aria-label="' + esc(h[0]) + '">' + h[2] + '</button>'
        + '<span class="name">' + esc(h[0]) + '</span><span class="tech">' + esc(h[1]) + '</span></div>';
    }).join('');
    hopList.innerHTML = HOPS.map(function (h, i) {
      return '<div class="hopi" data-i="' + i + '"><div class="hopi-rail"><i></i><button class="hop-box" type="button" data-hop="' + i + '" aria-label="' + esc(h[0]) + '">' + h[2] + '</button><i></i></div>'
        + '<div class="hopi-main"><button class="hopi-toggle" type="button" data-hop="' + i + '" aria-expanded="false"><span><b>' + esc(h[0]) + '</b><small>' + esc(h[1]) + '</small></span><span class="chev" aria-hidden="true">▾</span></button>'
        + '<div class="hopi-body"><div><span class="kicker">HOP ' + (i + 1) + ' OF 5 · WHAT HAPPENS</span><p>' + esc(h[3]) + '</p></div>'
        + '<div><span class="kicker">WHAT IT PROVES</span><p class="proof">' + esc(h[4]) + '</p></div></div></div></div>';
    }).join('');
    var showHop = function (i) {
      hop = i;
      $$('button', hopTabs).forEach(function (b, j) { b.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
      $$('.hop', hopRow).forEach(function (el, j) {
        var box = $('.hop-box', el);
        box.classList.toggle('on', j === i);
        box.classList.toggle('done', j < i);
        var link = $('.link', el);
        if (link) link.classList.toggle('done', j < i);
      });
      $('[data-hop-k]').textContent = 'HOP ' + (i + 1) + ' OF 5 · WHAT HAPPENS';
      $('[data-hop-what]').textContent = HOPS[i][3];
      $('[data-hop-proof]').textContent = HOPS[i][4];
      $$('.hopi', hopList).forEach(function (el, j) {
        el.classList.toggle('open', j === i);
        $('.hopi-toggle', el).setAttribute('aria-expanded', j === i ? 'true' : 'false');
        var box = $('.hop-box', el);
        box.classList.toggle('on', j === i);
        box.classList.toggle('done', j < i);
        var rails = $$('.hopi-rail > i', el);
        rails[0].className = j === 0 ? 'none' : j <= i ? 'done' : '';
        rails[1].className = j === 4 ? 'none' : j < i ? 'done' : '';
      });
    };
    $$('[data-hop]').forEach(function (b) { b.addEventListener('click', function () { showHop(+b.getAttribute('data-hop')); }); });
    showHop(hop);
  }

  // ---- developers: code tabs, the base_url line highlighted ----
  var CODE = {
    Python: ['import os', 'from openai import OpenAI', '', 'client = OpenAI(', '    base_url="https://api.envolvr.xyz/v1",', '    api_key=os.environ["ENVOLVR_API_KEY"],', ')', 'r = client.chat.completions.with_raw_response.create(', '    model="z-ai/glm-5.3",', '    messages=[{"role": "user", "content": "Close the arb?"}],', ')', '# the signed receipt for this exact exchange', 'print(r.headers["x-receipt-id"])'],
    TypeScript: ['import OpenAI from "openai";', '', 'const client = new OpenAI({', '  baseURL: "https://api.envolvr.xyz/v1",', '  apiKey: process.env.ENVOLVR_API_KEY,', '});', 'const { response } = await client.chat.completions', '  .create({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: "Close the arb?" }] })', '  .withResponse();', '// the signed receipt for this exact exchange', 'console.log(response.headers.get("x-receipt-id"));'],
    curl: ['curl https://api.envolvr.xyz/v1/chat/completions \\', '  -H "Authorization: Bearer $ENVOLVR_API_KEY" \\', '  -H "Content-Type: application/json" \\', '  -d \'{"model":"z-ai/glm-5.3","messages":[{"role":"user","content":"Close the arb?"}]}\' \\', '  -D - | grep x-receipt-id', '# the signed receipt for this exact exchange'],
    CLI: ['$ npx @envolvr/sdk signin --save', '$ npx @envolvr/sdk deposit 10', '$ npx @envolvr/sdk chat "Close the arb?"', '$ npx @envolvr/sdk verify --last', '# signature, commitments, bill and anchor, checked locally'],
  };
  var codeTabs = $('[data-code-tabs]');
  var codeLines = $('[data-code-lines]');
  if (codeTabs && codeLines) {
    var lang = 'Python';
    codeTabs.innerHTML = Object.keys(CODE).map(function (k) { return '<button type="button" role="tab" data-lang="' + k + '">' + k + '</button>'; }).join('');
    var showCode = function (k) {
      lang = k;
      $$('button', codeTabs).forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-lang') === k ? 'true' : 'false'); });
      codeLines.innerHTML = CODE[k].map(function (t) {
        var cls = /^\s*(#|\/\/)/.test(t) ? 'cm' : t.indexOf('api.envolvr.xyz/v1') >= 0 && t.indexOf('curl') !== 0 ? 'url' : '';
        return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + (t ? esc(t) : ' ') + '</div>';
      }).join('');
    };
    $$('button', codeTabs).forEach(function (b) { b.addEventListener('click', function () { showCode(b.getAttribute('data-lang')); }); });
    showCode(lang);
    var codeCopy = $('[data-copy-code]');
    codeCopy.addEventListener('click', function () { copy(CODE[lang].join('\n'), codeCopy); });
  }

  // ---- scroll reveal: headings slide in from the left, cards rise; off under reduced motion ----
  if (!reduce && Element.prototype.animate) {
    var ease = 'cubic-bezier(.2,.7,.2,1)';
    var h1 = $('#h1');
    if (h1) h1.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 900, easing: ease });
    var items = new Map();
    var add = function (el, from, delay) { if (!el) return; el.style.opacity = '0'; items.set(el, { from: from, delay: delay }); };
    var reveal = function (el) {
      var it = items.get(el);
      if (!it) return;
      items.delete(el);
      var a = el.animate([{ opacity: 0, transform: it.from }, { opacity: 1, transform: 'none' }], { duration: 800, delay: it.delay, easing: ease, fill: 'backwards' });
      el.style.opacity = '';
      a.onfinish = function () { a.cancel(); };
    };
    $$('.sec').forEach(function (sec) {
      var head = $('.sec-head', sec);
      if (!head) return;
      add($('h2', head), 'translateX(-56px)', 0);
      add($('p', head), 'translateX(-28px)', 120);
      var el = head.nextElementSibling;
      var d = 220;
      while (el) { add(el, 'translateY(28px)', d); d += 100; el = el.nextElementSibling; }
    });
    var rio = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { reveal(en.target); rio.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -10% 0px' }) : null;
    items.forEach(function (_, el) {
      var r = el.getBoundingClientRect();
      if (!rio || (r.top < window.innerHeight && r.bottom > 0)) reveal(el); else rio.observe(el);
    });
    // Fast scrolls and anchor jumps: reveal anything already above the fold.
    window.addEventListener('scroll', function () {
      items.forEach(function (_, el) { if (el.getBoundingClientRect().top < window.innerHeight) reveal(el); });
    }, { passive: true });
  }
})();
