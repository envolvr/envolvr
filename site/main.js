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
