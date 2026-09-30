(function () {
  var nav = document.getElementById('nav');
  var toggle = document.getElementById('navToggle');

  function onScroll() {
    if (window.scrollY > 8) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  nav.querySelectorAll('.nav-links a, .nav-actions a').forEach(function (link) {
    link.addEventListener('click', function () {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });

  var receipt = document.getElementById('receipt');
  var verifyBtn = document.getElementById('verifyBtn');
  var rcptStatus = document.getElementById('rcptStatus');

  if (receipt && verifyBtn && rcptStatus) {
    var rows = Array.prototype.slice.call(receipt.querySelectorAll('.receipt-rows > div'));
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var STEP = reduce ? 0 : 165;
    var HOLD = 3600;
    var timer = null;
    var cycleTimer = null;
    var visible = false;
    var busy = false;

    function setUnverified() {
      rows.forEach(function (r) { r.classList.remove('pass'); });
      receipt.classList.remove('verified');
      rcptStatus.className = 'status status-idle';
      rcptStatus.innerHTML = '<span class="pulse-idle"></span> unverified';
      verifyBtn.textContent = 'verify independently';
    }

    function setVerified() {
      receipt.classList.add('verified');
      rcptStatus.className = 'status';
      rcptStatus.innerHTML = '<span class="pulse"></span> attested';
      verifyBtn.textContent = 'verified';
    }

    function clearTimers() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
    }

    function run() {
      clearTimers();
      busy = true;
      setUnverified();

      rows.forEach(function (row, i) {
        timer = setTimeout(function () { row.classList.add('pass'); }, STEP * (i + 1));
      });

      timer = setTimeout(function () {
        setVerified();
        busy = false;
        if (!reduce && visible) cycleTimer = setTimeout(run, HOLD);
      }, STEP * rows.length + 480);
    }

    verifyBtn.addEventListener('click', function () {
      if (busy) return;
      run();
    });

    if (reduce) {
      setVerified();
    } else if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          visible = entry.isIntersecting;
          if (!visible) {
            clearTimers();
            busy = false;
            return;
          }
          if (busy) return;
          if (receipt.classList.contains('verified')) cycleTimer = setTimeout(run, HOLD);
          else run();
        });
      }, { threshold: 0.35 }).observe(receipt);
    } else {
      run();
    }
  }

  var heroArt = document.getElementById('heroArt');
  if (heroArt && heroArt.getContext) {
    var actx = heroArt.getContext('2d');
    var wrap = heroArt.parentElement;
    var artReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 0, h = 0;
    var artVisible = !('IntersectionObserver' in window);
    var raf = null;

    var PHI = (1 + Math.sqrt(5)) / 2;

    function solid(raw) {
      var verts = raw.map(function (v) {
        var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [v[0] / l, v[1] / l, v[2] / l];
      });
      var min = Infinity, i, j, d;
      function dist2(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return dx * dx + dy * dy + dz * dz;
      }
      for (i = 0; i < verts.length; i++) {
        for (j = i + 1; j < verts.length; j++) min = Math.min(min, dist2(verts[i], verts[j]));
      }
      var edges = [];
      for (i = 0; i < verts.length; i++) {
        for (j = i + 1; j < verts.length; j++) {
          d = dist2(verts[i], verts[j]);
          if (d < min * 1.01) edges.push([i, j]);
        }
      }
      return { verts: verts, edges: edges };
    }

    var octa = solid([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
    var cubeRaw = [];
    [-1, 1].forEach(function (x) { [-1, 1].forEach(function (y) { [-1, 1].forEach(function (z) { cubeRaw.push([x, y, z]); }); }); });
    var cube = solid(cubeRaw);
    var icoRaw = [];
    [-1, 1].forEach(function (a) {
      [-PHI, PHI].forEach(function (b) {
        icoRaw.push([0, a, b], [a, b, 0], [b, 0, a]);
      });
    });
    var ico = solid(icoRaw);

    // Inner to outer: radius (fraction of size), base alpha, spin rates and fixed tilt.
    var SHELLS = [
      { geo: octa, r: 0.12, a: 0.62, sy: 0.34, sx: 0.21, tilt: 0.5 },
      { geo: cube, r: 0.215, a: 0.46, sy: -0.17, sx: 0.08, tilt: 0.62 },
      { geo: ico, r: 0.33, a: 0.34, sy: 0.07, sx: -0.035, tilt: 0.3 }
    ];
    var PULSE_PERIOD = 7;

    function resizeArt() {
      var rect = wrap.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      heroArt.width = Math.round(w * dpr);
      heroArt.height = Math.round(h * dpr);
    }
    resizeArt();
    window.addEventListener('resize', resizeArt);

    function drawBall(bx, by, size, t) {
      var pulse = 1 + 0.07 * Math.sin(t * 1.3);
      var r = size * 0.034 * pulse;

      actx.shadowBlur = 0;
      var halo1 = actx.createRadialGradient(bx - r * 0.25, by - r * 0.2, 0, bx, by, r * 1.5);
      halo1.addColorStop(0, 'rgba(200,255,0,.22)');
      halo1.addColorStop(1, 'rgba(200,255,0,0)');
      actx.fillStyle = halo1;
      actx.fillRect(bx - r * 1.5, by - r * 1.5, r * 3, r * 3);

      var halo2 = actx.createRadialGradient(bx + r * 0.3, by + r * 0.25, 0, bx, by, r * 1.6);
      halo2.addColorStop(0, 'rgba(118,36,244,.16)');
      halo2.addColorStop(1, 'rgba(118,36,244,0)');
      actx.fillStyle = halo2;
      actx.fillRect(bx - r * 1.6, by - r * 1.6, r * 3.2, r * 3.2);

      var core = actx.createRadialGradient(bx, by, 0, bx, by, r * 0.5);
      core.addColorStop(0, 'rgba(255,255,255,1)');
      core.addColorStop(0.4, 'rgba(255,255,255,.9)');
      core.addColorStop(1, 'rgba(255,255,255,0)');
      actx.fillStyle = core;
      actx.beginPath();
      actx.arc(bx, by, r * 0.5, 0, Math.PI * 2);
      actx.fill();

      actx.shadowBlur = 18;
      actx.shadowColor = 'rgba(255,255,255,.8)';
      actx.fillStyle = '#fff';
      actx.beginPath();
      actx.arc(bx, by, size * 0.007, 0, Math.PI * 2);
      actx.fill();
      actx.shadowBlur = 0;
    }

    function drawArt(t) {
      if (!w || !h) return;
      actx.setTransform(dpr, 0, 0, dpr, 0, 0);
      actx.clearRect(0, 0, w, h);

      var cx = w / 2;
      var cy = h / 2;
      var size = Math.min(w, h);
      var dist = size * 1.4;

      // Attestation pulse: a wave that travels from the core out through each shell.
      var wave = artReduce ? -1 : ((t % PULSE_PERIOD) / PULSE_PERIOD) * 4.2 - 0.6;

      var segs = [];
      var dots = [];
      for (var s = 0; s < SHELLS.length; s++) {
        var sh = SHELLS[s];
        var R = size * sh.r;
        var ay = t * sh.sy + s * 1.1;
        var ax = sh.tilt + t * sh.sx;
        var cyA = Math.cos(ay), syA = Math.sin(ay);
        var cxA = Math.cos(ax), sxA = Math.sin(ax);
        var glow = Math.exp(-Math.pow(wave - s, 2) / 0.16);

        var pts = sh.geo.verts.map(function (v) {
          var x = v[0] * cyA + v[2] * syA;
          var z = -v[0] * syA + v[2] * cyA;
          var y = v[1] * cxA - z * sxA;
          z = v[1] * sxA + z * cxA;
          var k = dist / (dist - z * R);
          return { x: cx + x * R * k, y: cy + y * R * k, z: z };
        });

        sh.geo.edges.forEach(function (e) {
          var p = pts[e[0]], q = pts[e[1]];
          segs.push({ p: p, q: q, z: (p.z + q.z) / 2, a: sh.a, glow: glow });
        });
        pts.forEach(function (p) {
          dots.push({ p: p, z: p.z, a: sh.a, glow: glow });
        });
      }

      var items = segs.concat(dots.map(function (d) { d.dot = true; return d; }));
      items.sort(function (a, b) { return a.z - b.z; });

      actx.lineCap = 'round';
      var ballDrawn = false;

      for (var n = 0; n < items.length; n++) {
        var it = items[n];
        if (!ballDrawn && it.z >= 0) {
          drawBall(cx, cy, size, t);
          ballDrawn = true;
        }
        var depth = (it.z + 1) / 2;
        var g = it.glow;
        var alpha = Math.min(1, it.a * (0.22 + 0.78 * depth) + g * 0.45);
        var col = Math.round(255 - 55 * g) + ',255,' + Math.round(255 * (1 - g));
        actx.shadowBlur = g > 0.05 ? 10 * g : 0;
        actx.shadowColor = 'rgba(200,255,0,' + (0.6 * g) + ')';

        if (it.dot) {
          actx.fillStyle = 'rgba(' + col + ',' + Math.min(1, alpha * 1.25) + ')';
          actx.beginPath();
          actx.arc(it.p.x, it.p.y, 1 + 1.2 * depth + g * 0.8, 0, Math.PI * 2);
          actx.fill();
        } else {
          actx.strokeStyle = 'rgba(' + col + ',' + alpha + ')';
          actx.lineWidth = 0.7 + 0.7 * depth + g * 0.4;
          actx.beginPath();
          actx.moveTo(it.p.x, it.p.y);
          actx.lineTo(it.q.x, it.q.y);
          actx.stroke();
        }
      }
      if (!ballDrawn) drawBall(cx, cy, size, t);
      actx.shadowBlur = 0;
    }

    function loop(ts) {
      drawArt(ts / 1000);
      raf = requestAnimationFrame(loop);
    }

    function startArt() {
      if (raf || artReduce) return;
      raf = requestAnimationFrame(loop);
    }
    function stopArt() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }

    if (artReduce) {
      drawArt(0);
    } else if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          artVisible = entry.isIntersecting;
          if (artVisible) startArt(); else stopArt();
        });
      }, { threshold: 0.05 }).observe(wrap);
    } else {
      startArt();
    }
  }

  var reveals = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      var siblings = Array.prototype.slice.call(el.parentNode.children);
      var index = siblings.indexOf(el);
      el.style.transitionDelay = Math.min(index, 4) * 70 + 'ms';
      el.classList.add('in');
      observer.unobserve(el);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  reveals.forEach(function (el) { observer.observe(el); });
})();
