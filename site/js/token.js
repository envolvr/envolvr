// Token page: contract addresses and the trade link from data/network.json, and the
// unlock schedule chart.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---- contracts and trade link ----
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
  }).catch(function () {});

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
