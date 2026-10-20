/* Tiny progressive bits. The pages are complete without this file; it only makes
   three things interactive: the order-size explainer (Home), the quote ticket
   (Trade) and the holder filters (Holders). It never invents a number: between two
   quoted sizes it draws a straight line between the two real quotes and says so. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var MINUS = '−';

  /* ---------- formatting (mirrors build.mjs) ---------- */
  function nf(n, d) { d = d || 0; return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function usd(v) {
    var a = Math.abs(v);
    if (a >= 1000) return '$' + nf(v, 0);
    if (a >= 0.1) return '$' + nf(v, a >= 1 ? 2 : 2);
    return '$' + Number(v.toPrecision(4)).toFixed(Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(a)))));
  }
  function sgn(v, d) { return (v > 0 ? '+' : v < 0 ? MINUS : '') + nf(Math.abs(v), d == null ? 2 : d) + '%'; }
  function price6(v) { return '$' + v.toFixed(6); }
  /* write into the inner .n span so the underline and tap-receipt stay on the number */
  function setN(el, text) { if (!el) return; var n = $('.n', el); if (n) n.textContent = text; else el.textContent = text; }

  /* ---------- the curve ---------- */
  var dataEl = $('#curve-data');
  var D = dataEl ? JSON.parse(dataEl.textContent) : null;
  var P = D ? D.points : null;

  function logPos(n, lo, hi) { return (Math.log(n) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)); }
  function fromSlider(s) {
    var lo = P[0].n, hi = P[P.length - 1].n;
    var amount = Math.exp(Math.log(lo) + (s / 1000) * (Math.log(hi) - Math.log(lo)));
    // snap to a real quoted size when the handle is close, so the dots are reachable
    for (var i = 0; i < P.length; i++) { if (Math.abs(s - logPos(P[i].n, lo, hi) * 1000) < 9) return P[i].n; }
    return Math.round(amount / 10) * 10;
  }
  function toSlider(n) { return Math.round(logPos(n, P[0].n, P[P.length - 1].n) * 1000); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function quote(n) {
    var lo = P[0].n, hi = P[P.length - 1].n;
    if (n < lo || n > hi) return null;
    for (var i = 0; i < P.length; i++) {
      if (P[i].n === n) return { exact: true, a: P[i], b: P[i], t: 0, v: P[i] };
      if (i < P.length - 1 && n > P[i].n && n < P[i + 1].n) {
        var t = (n - P[i].n) / (P[i + 1].n - P[i].n), a = P[i], b = P[i + 1], v = { n: n };
        ['worth', 'so', 'si', 'bo', 'bi'].forEach(function (k) { v[k] = lerp(a[k], b[k], t); });
        v.sa = v.so / n; v.ba = v.bo / n;
        return { exact: false, a: a, b: b, t: t, v: v };
      }
    }
    return null;
  }
  function howText(q, n, side) {
    if (q.exact) return 'A real quote: the pools were asked about ' + nf(n) + ' NAM.';
    return 'A straight line between the real ' + nf(q.a.n) + ' and ' + nf(q.b.n) + ' NAM quotes. The pools were not asked about ' + nf(n) + ' NAM.';
  }

  /* ---------- Home: the explainer ---------- */
  var ex = $('[data-explainer]');
  if (ex && P) {
    var range = $('[data-range]', ex), plot = $('.plot--curve', ex), yMax = +plot.getAttribute('data-ymax');
    var cursor = $('[data-cursor]', ex), cdot = $('[data-cursor-dot]', ex);
    var paint = function () {
      var n = fromSlider(+range.value), q = quote(n), v = q.v, x = logPos(n, P[0].n, P[P.length - 1].n) * 100;
      cursor.style.left = x + '%';
      cdot.style.top = (100 - (v.si / yMax) * 100) + '%';
      $('[data-o="size"]', ex).textContent = nf(n) + ' NAM';
      setN($('[data-o="worth"]', ex), usd(v.worth));
      setN($('[data-o="get"]', ex), nf(v.so, 2));
      setN($('[data-o="move"]', ex), sgn(-v.si));
      $('[data-o="how-t"]', ex).textContent = howText(q, n);
      $('[data-est]', ex).hidden = q.exact;
    };
    range.addEventListener('input', paint);
    paint();
  }

  /* ---------- Trade: the ticket ---------- */
  var tk = $('[data-ticket]');
  if (tk && P) {
    var side = 'sell', n0 = 5000;
    var amt = $('[data-amt]', tk), r2 = $('[data-range]', tk), oor = $('[data-oor]', tk);
    var main = document.getElementById('main');
    var h1t = $('[data-h1-t]');
    var set = function (n, from) {
      var q = quote(n);
      var bad = !q;
      oor.hidden = !bad;
      $('.get', tk).classList.toggle('is-oor', bad);
      if (from !== 'input') amt.value = nf(n);
      if (from !== 'range' && !bad) r2.value = toSlider(n);
      $$('[data-preset]', tk).forEach(function (b) { var on = +b.getAttribute('data-preset') === n; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      $$('[data-amt]', document).forEach(function (row) { if (row.classList.contains('lad')) row.classList.toggle('is-on', +row.getAttribute('data-amt') === n); });
      if (bad) {
        ['get-n', 'move', 'avg', 'worth'].forEach(function (k) { setN($('[data-o="' + k + '"]', tk), '—'); });
        return;
      }
      var v = q.v, buying = side === 'buy';
      setN($('[data-o="worth"]', tk), usd(v.worth));
      setN($('[data-o="get-n"]', tk), nf(buying ? v.bo : v.so, 2));
      setN($('[data-o="move"]', tk), buying ? sgn(v.bi) : sgn(-v.si));
      setN($('[data-o="avg"]', tk), price6(buying ? v.ba : v.sa));
      $('[data-o="how-t"]', tk).textContent = howText(q, n);
      $('[data-est]', tk).hidden = q.exact;
    };
    var cur = n0;
    var go = function (n, from) { cur = n; set(n, from); };
    amt.addEventListener('input', function () {
      var raw = amt.value.replace(/[^0-9]/g, ''); var n = raw ? +raw : 0;
      cur = n; set(n, 'input');
    });
    amt.addEventListener('blur', function () { if (quote(cur)) amt.value = nf(cur); });
    r2.addEventListener('input', function () { go(fromSlider(+r2.value), 'range'); });
    $$('[data-preset]', tk).forEach(function (b) { b.addEventListener('click', function () { go(+b.getAttribute('data-preset')); }); });
    $$('.lad').forEach(function (row) {
      var pick = function () { go(+row.getAttribute('data-amt')); window.scrollTo({ top: tk.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' }); };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    $$('[data-side-b]', tk).forEach(function (b) {
      b.addEventListener('click', function () {
        side = b.getAttribute('data-side-b');
        $$('[data-side-b]', tk).forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        tk.setAttribute('data-side', side); main.setAttribute('data-side', side);
        $('[data-o="get-l"]', tk).textContent = side === 'buy' ? 'You pay' : 'You get';
        $('.get-n .u', tk).textContent = 'USDC';
        h1t.textContent = side === 'buy' ? 'What would I pay to buy NAM now?' : 'What would I get if I sold NAM now?';
        set(cur, 'side');
      });
    });
    main.setAttribute('data-side', 'sell');
    set(n0);
  }

  /* ---------- Holders: filters ---------- */
  var fl = $('[data-filters]');
  if (fl) {
    var rows = $$('.hr'), shown = $('[data-shown]'), empty = $('[data-empty]');
    var state = { f: 'all', sz: 0 };
    var apply = function () {
      var n = 0;
      rows.forEach(function (r) {
        var show = (state.f === 'all' || r.getAttribute('data-cat') === state.f) && +r.getAttribute('data-total') >= state.sz;
        r.hidden = !show; if (show) n++;
      });
      shown.textContent = n; empty.hidden = n !== 0;
      $$('[data-f]', fl).forEach(function (c) { var on = c.getAttribute('data-f') === state.f; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
      $$('[data-sz]', fl).forEach(function (c) { var on = +c.getAttribute('data-sz') === state.sz; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
    };
    $$('[data-f]', fl).forEach(function (c) { c.addEventListener('click', function () { state.f = c.getAttribute('data-f'); apply(); }); });
    $$('[data-sz]', fl).forEach(function (c) { c.addEventListener('click', function () { state.sz = +c.getAttribute('data-sz'); apply(); }); });
    $$('[data-chain]', fl).forEach(function (b) {
      b.addEventListener('click', function () {
        var ch = b.getAttribute('data-chain');
        $$('[data-chain]', fl).forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        $$('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== ch; });
        $('.fchips', fl).hidden = ch !== 'namada';
        $('.fcount', fl).hidden = ch !== 'namada';
      });
    });
    if (location.hash === '#osmosis') { var ob = $('[data-chain="osmosis"]', fl); if (ob) ob.click(); }
  }
})();
