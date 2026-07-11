// ═══════════════════════════════════════
// STARFIELD (black & white, self-contained)
// A gentle drifting field of dots on a canvas.
// Pauses/simplifies for prefers-reduced-motion and tab visibility.
// ═══════════════════════════════════════
(function () {
  const canvas = document.getElementById('starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const DOT_COLOR = '#ffffff';
  const DENSITY = 9000;      // px^2 per dot — lower = more dots
  const MAX_SPEED = 0.12;    // px per frame
  const MAX_RADIUS = 1.6;

  let width, height, dpr;
  let dots = [];
  let reduced = false;
  let raf = null;

  function prefersReducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedDots();
  }

  function seedDots() {
    const count = Math.max(24, Math.floor((width * height) / DENSITY));
    dots = new Array(count).fill(0).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.4 + Math.random() * MAX_RADIUS,
      vx: (Math.random() - 0.5) * MAX_SPEED,
      vy: (Math.random() - 0.5) * MAX_SPEED,
      alpha: 0.15 + Math.random() * 0.45,
      twinkleSpeed: 0.002 + Math.random() * 0.006,
      twinklePhase: Math.random() * Math.PI * 2,
    }));
  }

  function step(time) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = DOT_COLOR;

    for (const d of dots) {
      if (!reduced) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < -5) d.x = width + 5;
        if (d.x > width + 5) d.x = -5;
        if (d.y < -5) d.y = height + 5;
        if (d.y > height + 5) d.y = -5;
      }

      const twinkle = reduced
        ? d.alpha
        : d.alpha * (0.6 + 0.4 * Math.sin(time * d.twinkleSpeed + d.twinklePhase));

      ctx.globalAlpha = Math.max(0, Math.min(1, twinkle));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (!reduced) raf = requestAnimationFrame(step);
  }

  function start() {
    resize();
    reduced = prefersReducedMotion();
    if (raf) cancelAnimationFrame(raf);
    if (reduced) {
      step(0); // draw once, static
    } else {
      raf = requestAnimationFrame(step);
    }
  }

  function handleVisibility() {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!reduced && !raf) {
      raf = requestAnimationFrame(step);
    }
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  document.addEventListener('visibilitychange', handleVisibility);

  if (window.matchMedia) {
    try {
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', start);
    } catch (e) { /* older browsers */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();