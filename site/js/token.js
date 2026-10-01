// Token page: contract addresses and the trade link from data/network.json, the
// allowance calculator (live budget and total stake from StakingAllowance when its
// address is published, example values until then) and the unlock schedule chart.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n, d) { return n.toLocaleString('en-US', { maximumFractionDigits: d || 0 }); };
  var num = function (s) { var v = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isFinite(v) ? v : 0; };

  // ---- calculator ----
  var stakeIn = $('#calcStake'), range = $('#calcRange'), budgetIn = $('#calcBudget'), totalIn = $('#calcTotal');
  var models = $$('[data-calc-models] li');
  // Slider: 0..100 maps to 1k..10M NVLR on a log scale.
  var toStake = function (p) { return Math.round(Math.pow(10, 3 + (p / 100) * 4) / 1000) * 1000; };
  var toPos = function (s) { return s <= 1000 ? 0 : Math.min(100, (Math.log10(s) - 3) / 4 * 100); };

  function compact(t) {
    if (t >= 1e9) return fmt(t / 1e9, 1) + 'B';
    if (t >= 1e6) return fmt(t / 1e6, t >= 1e7 ? 0 : 1) + 'M';
    if (t >= 1e3) return fmt(t / 1e3, 0) + 'k';
    return fmt(t, 0);
  }
  function render() {
    var stake = num(stakeIn.value), budget = num(budgetIn.value), total = num(totalIn.value);
    // A new staker joins the pool, so their stake is part of the total.
    var pool = total + stake;
    var share = pool > 0 ? stake / pool : 0;
    var allowance = budget * share;
    $('[data-calc-allow]').textContent = '$' + fmt(allowance, allowance < 10 ? 2 : 0) + ' / day';
    $('[data-calc-share]').textContent = (share * 100 < 0.01 && share > 0 ? '<0.01' : fmt(share * 100, 2)) + '%';
    models.forEach(function (li) {
      var blended = (3 * num(li.dataset.in) + num(li.dataset.out)) / 4; // USD per 1M tokens
      var tokens = blended > 0 ? allowance / blended * 1e6 : 0;
      li.innerHTML = '<span>' + li.dataset.model + '</span><b>≈ ' + compact(tokens) + ' tokens / day</b>';
    });
  }
  function reformat(input) { var v = num(input.value); input.value = v ? fmt(v, input === budgetIn ? 2 : 0) : ''; }
  if (stakeIn) {
    stakeIn.addEventListener('input', function () { range.value = toPos(num(stakeIn.value)); render(); });
    range.addEventListener('input', function () { stakeIn.value = fmt(toStake(+range.value)); render(); });
    [budgetIn, totalIn].forEach(function (i) { i.addEventListener('input', render); });
    [stakeIn, budgetIn, totalIn].forEach(function (i) { i.addEventListener('blur', function () { reformat(i); render(); }); });
    range.value = toPos(num(stakeIn.value));
    render();
  }

  // ---- contracts, trade link, live values ----
  function call(rpc, to, data) {
    return fetch(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: to, data: data }, 'latest'] }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
    }).then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error.message); return BigInt(j.result); });
  }
  var word = function (n) { return BigInt(n).toString(16).padStart(64, '0'); };

  fetch('/data/network.json').then(function (r) { return r.json(); }).then(function (net) {
    $$('[data-addr]').forEach(function (el) {
      var a = net.contracts[el.dataset.addr];
      if (!a) { el.textContent = 'Published at launch'; el.classList.add('pending'); return; }
      var link = document.createElement('a');
      link.href = net.explorer + '/address/' + a; link.target = '_blank'; link.rel = 'noopener'; link.textContent = a;
      el.replaceChildren(link);
    });
    $$('[data-link="trade"]').forEach(function (el) {
      if (net.links.trade) { el.href = net.links.trade; el.target = '_blank'; el.rel = 'noopener'; }
      else el.href = '#contracts';
    });
    var staking = net.contracts.staking;
    if (!staking || !stakeIn) { $('[data-calc-source]').textContent = 'Example values: edit the budget and total stake below'; return; }
    // currentDayStart() 0x5a4d30cd, budgetAt(uint256) 0x41d4058a, totalStake() 0x8b0e9f3f
    return call(net.rpcUrl, staking, '0x5a4d30cd').then(function (day) {
      return Promise.all([call(net.rpcUrl, staking, '0x41d4058a' + word(day)), call(net.rpcUrl, staking, '0x8b0e9f3f')]);
    }).then(function (v) {
      budgetIn.value = fmt(Number(v[0]) / 1e6, 2);
      totalIn.value = fmt(Number(v[1] / 10n ** 18n));
      $('[data-calc-source]').textContent = "Live: today's budget and total stake from the staking contract";
      render();
    });
  }).catch(function () {
    if ($('[data-calc-source]')) $('[data-calc-source]').textContent = 'Example values: edit the budget and total stake below';
  });

  // ---- unlock schedule: stacked areas by month, 0..12 ----
  var host = $('[data-unlock]');
  if (host) {
    var series = [
      { name: 'Liquidity', color: '#1f8a6d', at: function () { return 700; } },
      { name: 'Marketing', color: '#9bb51f', at: function () { return 100; } },
      { name: 'Ecosystem growth', color: '#7a5cff', at: function (m) { return 100 * Math.min(m, 6) / 6; } },
      { name: 'Long-term partnerships', color: '#3e6fc8', at: function (m) { return m <= 6 ? 0 : 100 * Math.min(m - 6, 6) / 6; } },
    ];
    var W = 560, H = 260, L = 40, R = 12, T = 12, B = 30, max = 1000;
    var x = function (m) { return L + (W - L - R) * m / 12; };
    var y = function (v) { return T + (H - T - B) * (1 - v / max); };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Unlocked supply rises from 800 million NVLR at launch to 1 billion at month 12">';
    [0, 250, 500, 750, 1000].forEach(function (v) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#eceee8"/>';
      svg += '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="ax">' + v + '</text>';
    });
    for (var m = 0; m <= 12; m += 3) svg += '<text x="' + x(m) + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + (m === 0 ? 'Launch' : 'M' + m) + '</text>';
    var base = []; for (var i = 0; i <= 48; i++) base.push(0);
    series.forEach(function (s) {
      var top = [], pts = [];
      for (var i = 0; i <= 48; i++) { var mm = i / 4; top.push(base[i] + s.at(mm)); pts.push(x(mm) + ',' + y(top[i])); }
      var back = []; for (var j = 48; j >= 0; j--) back.push(x(j / 4) + ',' + y(base[j]));
      // 2px surface gap between stacked fills
      svg += '<polygon points="' + pts.concat(back).join(' ') + '" fill="' + s.color + '" stroke="#fff" stroke-width="2" stroke-linejoin="round"><title>' + s.name + '</title></polygon>';
      base = top;
    });
    svg += '</svg>';
    var legend = '<ul class="unlock-legend">' + series.map(function (s) { return '<li><i style="background:' + s.color + '"></i>' + s.name + '</li>'; }).join('') + '</ul>';
    host.innerHTML = svg + legend;
  }
})();
