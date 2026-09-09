import {
  computeLoan, projectPayoff, projectBalance, emiFor, todayIso, secondsToMidnight,
  formatINR, formatDate, dayNum, isoFromDay, isMonthDay,
} from './loan.js';

// The page's markup lives here, not in the HTML files, so every person's page
// is byte-identical and there is only one copy to change.
const PAGE = `
<header class="head">
    <h1 id="label">Loan</h1>
    <p class="asof" id="asof"></p>
  </header>

  <section class="hero" aria-labelledby="hero-label">
    <p class="hero-label" id="hero-label">Amount due today</p>
    <p class="hero-value" id="due">&mdash;</p>
    <p class="hero-sub" id="due-sub"></p>
    <p class="countdown" id="countdown"></p>
  </section>

  <section class="tiles" id="tiles" aria-label="Breakdown"></section>

  <section class="card" id="context-card" hidden>
    <h2>Why this figure</h2>
    <p class="note" id="context-note"></p>
  </section>

  <section class="card" id="forecast-card" hidden>
    <h2>If it is not repaid</h2>
    <div class="table-scroll"><table id="forecast"></table></div>
    <p class="note" id="forecast-note"></p>
  </section>

  <section class="card" id="emi-card" hidden>
    <h2>Schedule</h2>
    <div class="tiles inner" id="emi-tiles"></div>
    <p class="note" id="emi-note"></p>
  </section>

  <section class="card" id="chart-card" hidden>
    <h2 id="chart-title">Outstanding principal</h2>
    <p class="note" id="chart-note"></p>
    <div class="chart-scroll"><div id="chart" class="viz-root"></div></div>
  </section>

  <section class="card" id="rates-card" hidden>
    <h2>Interest rate history</h2>
    <div class="table-scroll"><table id="rates"></table></div>
  </section>

  <section class="card">
    <h2>Ledger</h2>
    <div class="table-scroll"><table id="ledger"></table></div>
    <p class="note" id="ledger-note"></p>
  </section>

  <footer class="method">
    <h2>How this is calculated</h2>
    <ul id="method"></ul>
    <p class="note">Every figure is recomputed from <code>data.json</code> on each load, so
    the amount due is correct whenever the page is opened. Record a payment by adding an
    entry to that file and committing it.</p>
  </footer>

<template id="tile-tpl">
  <div class="tile"><dt></dt><dd></dd><p class="tile-sub"></p></div>
</template>
`;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let DATA = null;
let shownDate = null;

// ---------------------------------------------------------------- load

async function load() {
  try {
    // The GitHub Pages CDN will happily serve a stale data.json for a few
    // minutes; ask for a fresh one so a just-committed payment shows up.
    const res = await fetch(`data.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`data.json returned HTTP ${res.status}`);
    DATA = JSON.parse(await res.text());
  } catch (e) {
    return fail(e);
  }
  try {
    render();
    setInterval(tick, 1000);
  } catch (e) {
    fail(e);
  }
}

function fail(e) {
  const app = $('app');
  app.removeAttribute('aria-busy');
  app.innerHTML = '';
  const box = el('section', 'error');
  box.append(
    el('h2', null, 'Could not read the ledger'),
    el('p', null, 'data.json is missing, unreachable, or not valid JSON, so the balance cannot be computed.'),
    el('pre', null, String(e && e.message ? e.message : e)),
    el('p', 'note', 'Run `node validate.mjs` locally to see exactly what is wrong.'),
  );
  app.append(box);
}

// A page left open overnight must roll over on its own.
function tick() {
  const tz = DATA.timezone;
  if (todayIso(tz) !== shownDate) {
    try { return render(); } catch (e) { return fail(e); }
  }
  const s = secondsToMidnight(tz);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  $('countdown').innerHTML =
    `Next accrual at midnight IST, in <b>${hh}:${mm}:${ss}</b> &mdash; interest is added at the start of each day.`;
}

// ---------------------------------------------------------------- render

function render() {
  const d = DATA;
  const today = todayIso(d.timezone);
  shownDate = today;
  const r = computeLoan(d, today);
  const proj = d.emi && d.emi.amount ? projectPayoff(d, r) : projectBalance(d, r, { months: 24 });

  $('app').removeAttribute('aria-busy');
  $('label').textContent = d.label || 'Loan';
  document.title = d.label || 'Loan Ticker';
  $('hero-label').textContent = d.counterparty ? `What ${d.counterparty} owes today` : 'Amount owed today';
  $('asof').textContent =
    `₹${Number(d.principal).toLocaleString('en-IN')} disbursed ${formatDate(d.startDate)} · ${d.annualRatePercent}% p.a. · as of ${formatDate(today)}`;

  renderHero(r, d);
  renderTiles(r, d, proj);
  renderContext(d);
  renderForecast(r, d);
  renderEmi(r, d, proj);
  renderChart(r, proj);
  renderRates(d, r);
  renderLedger(r, d);
  renderMethod(d, r);
  tick();
}

function renderHero(r, d) {
  if (r.notStarted) {
    $('due').textContent = formatINR(0);
    $('due-sub').textContent = `Disbursement is dated ${formatDate(d.startDate)}; nothing accrues until then.`;
    return;
  }
  $('due').textContent = formatINR(r.amountDue);
  const parts = [`${formatINR(r.principal)} principal`,
    `${formatINR(r.accruedInterest)} interest${r.capitalizing ? ' added' : ''}`];
  if (r.charges > 0) parts.push(`${formatINR(r.charges)} charges`);
  $('due-sub').textContent = r.amountDue === 0
    ? `Settled in full on ${formatDate(r.payoffDate)}. Nothing further is owed.`
    : `${parts.join('  +  ')} — the full amount to settle today.`;
  if (r.credit > 0) {
    $('due-sub').textContent += `  Overpaid by ${formatINR(r.credit)}.`;
  }
}

function tile(dtText, ddText, sub) {
  const node = $('tile-tpl').content.cloneNode(true);
  node.querySelector('dt').textContent = dtText;
  node.querySelector('dd').textContent = ddText;
  node.querySelector('.tile-sub').textContent = sub || '';
  return node;
}

function interestSub(r) {
  if (r.accruedInterest === 0) return 'nothing owed';
  if (r.capitalizing) return 'compounds into the balance monthly';
  if (r.chargedInterest === 0) return 'accruing since the last debit';
  if (r.uncharged === 0) return 'debited to the account, unpaid';
  return `${formatINR(r.chargedInterest)} debited, ${formatINR(r.uncharged)} accruing`;
}

function renderTiles(r, d, proj) {
  const t = $('tiles');
  t.innerHTML = '';
  t.append(
    tile(r.capitalizing ? 'Principal outstanding' : 'Outstanding principal', formatINR(r.principal, { decimals: 0 }),
      r.totalLent > toPaiseSafe(d.principal)
        ? `${formatINR(r.totalLent, { decimals: 0 })} lent in total`
        : (r.totals.principal > 0 ? `${formatINR(r.totals.principal, { decimals: 0 })} repaid so far` : 'no principal repaid yet')),
    tile(r.capitalizing ? 'Interest added' : 'Interest accrued', formatINR(r.accruedInterest),
      interestSub(r)),
    tile('Cost per day', formatINR(r.dailyInterest),
      `${formatINR(r.dailyInterest * 30, { decimals: 0 })} per 30 days at ${r.rate}%`),
    tile('Days elapsed', String(r.daysElapsed),
      `since ${formatDate(d.startDate)}`),
  );
  if (r.charges > 0) {
    t.append(tile('Charges outstanding', formatINR(r.charges), 'never accrue interest'));
  }
  if (r.totals.paid > 0) {
    t.append(tile('Total paid', formatINR(r.totals.paid, { decimals: 0 }),
      `${formatINR(r.totals.interest, { decimals: 0 })} interest · ${formatINR(r.totals.principal, { decimals: 0 })} principal`));
  }
}

function nextEmiDate(d, today) {
  const dom = (d.emi && d.emi.dayOfMonth) || 1;
  let day = dayNum(today);
  const first = d.emi && d.emi.firstDate ? dayNum(d.emi.firstDate) : day;
  if (day < first) day = first;
  for (let i = 0; i < 70; i++) {
    const iso = isoFromDay(day + i);
    if (isMonthDay(iso, dom)) return iso;
  }
  return null;
}

function renderContext(d) {
  const card = $('context-card');
  const note = d.context && d.context.note;
  if (!note) { card.hidden = true; return; }
  card.hidden = false;
  const hl = d.context.homeLoan;
  $('context-note').textContent = note + (hl
    ? ` Home loan: ${formatINR(hl.principal * 100, { decimals: 0 })} at ${hl.annualRatePercent}% over ${hl.tenureYears} years.`
    : '');
}

function addMonths(iso, months) {
  const [y, m, day] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

// The question this page exists to answer: what does he owe if he settles in
// six months, a year, five years.
function renderForecast(r, d) {
  const card = $('forecast-card');
  if (r.amountDue <= 0 || (d.emi && d.emi.amount)) { card.hidden = true; return; }
  card.hidden = false;

  const horizons = [[0, 'Today'], [3, 'In 3 months'], [6, 'In 6 months'], [12, 'In 1 year'],
    [24, 'In 2 years'], [36, 'In 3 years'], [60, 'In 5 years']];
  $('forecast').innerHTML =
    '<thead><tr><th>Settled</th><th>Date</th><th>Amount owed</th><th>Interest in it</th></tr></thead><tbody>' +
    horizons.map(([m, label]) => {
      const iso = addMonths(r.asOf, m);
      const f = computeLoan(d, iso);
      return `<tr><td>${label}</td><td class="dim">${formatDate(iso)}</td>` +
        `<td class="num">${formatINR(f.amountDue, { decimals: 0 })}</td>` +
        `<td class="num dim">${formatINR(f.accruedInterest, { decimals: 0 })}</td></tr>`;
    }).join('') + '</tbody>';
  $('forecast-note').textContent = r.capitalizing
    ? 'Assumes nothing is repaid and the rate stays at ' + r.rate + '%. Interest folds into the balance on the '
      + ordinal(d.interestChargeDay || 1) + ' of each month, so it earns interest thereafter — which is what a '
      + 'part prepayment not made costs on a fixed EMI.'
    : 'Assumes nothing is repaid and the rate stays at ' + r.rate + '%.';
}

function renderEmi(r, d, proj) {
  const card = $('emi-card');
  if (!d.emi) { card.hidden = true; return; }
  const tiles = $('emi-tiles');
  const note = $('emi-note');
  tiles.innerHTML = '';
  if (r.amountDue === 0) { card.hidden = true; return; }
  card.hidden = false;

  const next = nextEmiDate(d, r.asOf);
  const emiAmt = d.emi && d.emi.amount;

  if (!emiAmt) {
    // The EMI is not in the ledger yet, so show what the annuity formula gives
    // for common tenures at this principal and rate.
    tiles.append(tile('Next EMI date', next ? formatDate(next) : '—',
      `the ${ordinal((d.emi && d.emi.dayOfMonth) || 1)} of each month`));
    const opts = [12, 24, 36, 60]
      .map((m) => `${m} mo ${formatINR(Math.round(emiFor(r.principal / 100, r.rate, m) * 100), { decimals: 0 })}`)
      .join(' · ');
    note.innerHTML =
      `EMI amount is not set. Add <code>emi.amount</code> and <code>tenureMonths</code> to <code>data.json</code> ` +
      `to turn on payoff projection and missed-EMI tracking. At ${formatINR(r.principal, { decimals: 0 })} and ${r.rate}%, ` +
      `the annuity formula gives: ${opts}.`;
    return;
  }

  tiles.append(
    tile('Next EMI', formatINR(Math.round(emiAmt * 100), { decimals: 0 }),
      next ? `due ${formatDate(next)}` : ''),
  );
  if (proj && proj.neverAmortizes) {
    note.textContent =
      `This EMI does not cover the interest (about ${formatINR(proj.monthlyInterest, { decimals: 0 })} a month), ` +
      `so the balance would never reduce.`;
    return;
  }
  if (proj) {
    tiles.append(
      tile('Projected payoff', formatDate(proj.payoffDate), `${proj.installments} more instalments`),
      tile('Interest still to pay', formatINR(proj.interestRemaining, { decimals: 0 }), `at today's ${r.rate}% rate`),
    );
    note.textContent =
      'The projection assumes the rate stays where it is and every EMI is paid on time. ' +
      'A rate reset or a prepayment moves the payoff date.';
  }
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

// ---------------------------------------------------------------- chart

function renderChart(r, proj) {
  const card = $('chart-card');
  const host = $('chart');
  const yOf = (s) => (r.capitalizing ? s.due : s.principal);
  $('chart-title').textContent = r.capitalizing ? 'Balance owed' : 'Outstanding principal';
  const actual = r.samples.filter((s, i, a) => i === 0 || s.iso !== a[i - 1].iso);
  const projected = proj && !proj.neverAmortizes ? proj.samples : [];

  // Nothing meaningful to plot yet -- an empty chart card is worse than none.
  if (actual.length + projected.length < 3) {
    card.hidden = true;
    host.innerHTML = '';
    return;
  }
  card.hidden = false;
  const baseNote = !projected.length ? 'Recorded history to date.'
    : r.capitalizing ? 'Solid to today, dashed for how the balance grows if nothing is repaid.'
    : 'Solid to today, dashed for the projection at the current rate and EMI.';
  $('chart-note').textContent = baseNote;
  host.dataset.focused = '';

  const W = 720, H = 240, PAD = { t: 12, r: 16, b: 26, l: 68 };
  const pts = [...actual, ...projected]
    .map((s) => ({ x: dayNum(s.iso), y: yOf(s), iso: s.iso }))
    .filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
  const xMin = pts[0].x, xMax = pts[pts.length - 1].x || pts[0].x + 1;
  const ys = pts.map((p) => p.y);
  const scale = niceScale(Math.min(...ys), Math.max(...ys));
  const sx = (x) => PAD.l + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PAD.l - PAD.r);
  const sy = (y) => PAD.t + (1 - (y - scale.lo) / (scale.hi - scale.lo)) * (H - PAD.t - PAD.b);
  const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');

  const aPts = pts.slice(0, actual.length);
  // Join the dashed projection to the solid line so there is no visual gap.
  const pPts = projected.length ? [aPts[aPts.length - 1], ...pts.slice(actual.length)] : [];

  const ticks = scale.ticks;
  const svg = `
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet"
     aria-label="Outstanding principal over time. Full figures are in the ledger table below.">
  <g class="grid">${ticks.map((t) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}"/>`).join('')}</g>
  <g class="axis">
    ${ticks.map((t) => `<text x="${PAD.l - 8}" y="${(sy(t) + 4).toFixed(1)}" text-anchor="end">${shortINR(t)}</text>`).join('')}
    <text x="${PAD.l}" y="${H - 6}">${formatDate(pts[0].iso)}</text>
    <text x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${formatDate(pts[pts.length - 1].iso)}</text>
  </g>
  <path class="line-actual" d="${path(aPts)}"/>
  ${pPts.length ? `<path class="line-projected" d="${path(pPts)}"/>` : ''}
  <g id="hover" style="display:none">
    <line class="crosshair" y1="${PAD.t}" y2="${H - PAD.b}"/>
    <circle class="dot" r="4.5"/>
  </g>
  <rect id="capture" x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="transparent"/>
</svg>`;

  if (scale.focused) {
    $('chart-note').textContent += ` The axis starts at ${shortINR(scale.lo)}, not zero, to show the movement.`;
  }
  host.className = 'viz-root chart-host';
  host.innerHTML = svg;
  attachHover(host, pts, sx, sy, W, actual.length);
}

// An HTML chart is interactive by default: crosshair plus a value readout.
function attachHover(host, pts, sx, sy, W, actualCount) {
  const svg = host.querySelector('svg');
  const hover = host.querySelector('#hover');
  const line = hover.querySelector('line');
  const dot = hover.querySelector('circle');
  const tip = el('div', 'tip');
  tip.style.display = 'none';
  host.append(tip);

  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const cx = ((ev.clientX ?? ev.touches?.[0]?.clientX) - rect.left) * (W / rect.width);
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(sx(p.x) - cx); if (dd < bestD) { bestD = dd; best = i; } });
    const p = pts[best];
    const px = sx(p.x), py = sy(p.y);
    line.setAttribute('x1', px); line.setAttribute('x2', px);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    hover.style.display = '';
    tip.style.display = '';
    tip.innerHTML = `${formatDate(p.iso)}${best >= actualCount ? ' (projected)' : ''}<br><b>${formatINR(p.y, { decimals: 0 })}</b>`;
    const scale = rect.width / W;
    tip.style.left = `${Math.min(Math.max(px * scale - tip.offsetWidth / 2, 0), rect.width - tip.offsetWidth)}px`;
    tip.style.top = `${py * scale - tip.offsetHeight - 10}px`;
  };
  const hide = () => { hover.style.display = 'none'; tip.style.display = 'none'; };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('touchmove', (e) => { move(e); e.preventDefault(); }, { passive: false });
  svg.addEventListener('touchend', hide);
}

function niceStep(raw) {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) || 10) * mag;
}

// A line encodes value by position, not by length, so it may sit on a focused
// range -- and must, when the interesting movement is a small fraction of the
// total. But anything that runs down towards zero (a loan being paid off) keeps
// a zero floor, where the distance to nothing is the point.
function niceScale(dataMin, dataMax) {
  if (dataMax <= 0) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (dataMin < dataMax * 0.3) {
    const step = niceStep(dataMax / 4);
    const hi = Math.ceil(dataMax / step) * step;
    const ticks = [];
    for (let t = 0; t <= hi + 1e-6; t += step) ticks.push(t);
    return { lo: 0, hi, ticks, focused: false };
  }
  const span = (dataMax - dataMin) || dataMax * 0.1;
  const step = niceStep(span / 3);
  const lo = Math.max(0, Math.floor((dataMin - span * 0.2) / step) * step);
  const hi = Math.ceil((dataMax + span * 0.2) / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + 1e-6; t += step) ticks.push(t);
  return { lo, hi, ticks, focused: lo > 0 };
}

function shortINR(paise) {
  const r = paise / 100;
  const trim = (n) => String(Number(n.toFixed(2)));
  if (r >= 10000000) return `₹${trim(r / 10000000)}Cr`;
  if (r >= 100000) return `₹${trim(r / 100000)}L`;
  if (r >= 1000) return `₹${trim(r / 1000)}k`;
  return `₹${Math.round(r)}`;
}

// ---------------------------------------------------------------- tables

function renderRates(d, r) {
  const changes = d.rateChanges || [];
  if (!changes.length) { $('rates-card').hidden = true; return; }
  $('rates-card').hidden = false;
  const basis = d.dayCountBasis || 365;
  const rows = [{ date: d.startDate, annualRatePercent: d.annualRatePercent, note: 'opening rate' }, ...changes];
  $('rates').innerHTML =
    `<thead><tr><th>Effective</th><th>Rate</th><th>Cost per day from then</th><th>Note</th></tr></thead><tbody>` +
    rows.map((c) => {
      // The principal as it stood on the day the rate took effect -- a future
      // reset has no meaningful principal yet.
      let cost = '&mdash;';
      if (dayNum(c.date) <= dayNum(r.asOf)) {
        const principalThen = computeLoan(d, c.date).principal;
        cost = formatINR(principalThen * c.annualRatePercent / 100 / basis);
      }
      return `<tr><td>${formatDate(c.date)}</td><td class="num">${c.annualRatePercent}%</td>` +
        `<td class="num dim">${cost}</td><td class="dim">${escapeHtml(c.note || '')}</td></tr>`;
    }).join('') + '</tbody>';
}

function renderLedger(r, d) {
  const rows = r.ledger.filter((l) => ['payment', 'charge', 'advance'].includes(l.kind)).reverse();
  const future = r.future || [];
  const note = $('ledger-note');

  if (!rows.length && !future.length) {
    $('ledger').innerHTML = '';
    note.innerHTML =
      'No payments recorded yet. Add an entry to the <code>payments</code> array in <code>data.json</code> ' +
      'and commit &mdash; the page picks it up on the next load.';
    return;
  }
  // Only show the charges column when charges exist -- otherwise every payment
  // row would carry a column of zeroes. When they do exist it is required, or
  // the row's parts would not sum to the amount paid.
  const anyCharges = rows.some((l) => l.kind === 'charge' || l.toCharges > 0);
  const futureNote = future.length
    ? `<strong>${future.length} entr${future.length === 1 ? 'y is' : 'ies are'} dated after today (${formatDate(future[0].date)}` +
      `${future.length > 1 ? ' onwards' : ''}) and count${future.length === 1 ? 's' : ''} for nothing yet.</strong> ` +
      'If that was not deliberate, check the year. '
    : '';
  note.innerHTML = futureNote +
    `Interest debits are posted on the ${ordinal(d.interestChargeDay || 1)} of each month. ` +
    'Each payment clears charges, then interest, then principal.' +
    (rows.some((l) => l.undated)
      ? ' An entry marked <span class="pill bad">no date</span> is missing its <code>date</code> field and is being counted as today\'s. ' +
        'Add the date it was actually paid, or the interest split will be wrong.'
      : '');

  const head = ['Date', 'Paid', ...(anyCharges ? ['To charges'] : []), 'To interest', 'To principal', 'Principal after', 'Note'];
  const span = anyCharges ? 4 : 3;

  // Future-dated entries sit at the top, greyed, counting for nothing.
  const futureRows = future.slice().reverse().map((f) =>
    `<tr class="projected"><td>${formatDate(f.date)} <span class="pill bad">not yet</span></td>` +
    `<td class="num">${formatINR(toPaiseSafe(f.amount))}</td>` +
    `<td class="dim" colspan="${span}">${f.kind === 'advance' ? 'further lending' : 'payment'} dated in the future &mdash; not counted</td>` +
    `<td class="dim">${escapeHtml(f.note || '')}</td></tr>`).join('');

  $('ledger').innerHTML =
    `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    futureRows +
    rows.map((l) => {
      if (l.kind === 'advance') {
        return `<tr><td>${formatDate(l.iso)}</td>` +
          `<td class="num">+${formatINR(l.amount)}</td>` +
          `<td class="dim" colspan="${anyCharges ? 3 : 2}">further amount lent</td>` +
          `<td class="num dim">${formatINR(l.principalAfter, { decimals: 0 })}</td>` +
          `<td class="dim">${escapeHtml(l.note || '')}</td></tr>`;
      }
      if (l.kind === 'charge') {
        return `<tr><td>${formatDate(l.iso)}</td><td class="num">${formatINR(l.amount)}</td>` +
          `<td class="dim num" colspan="${anyCharges ? 4 : 3}">charge raised</td>` +
          `<td class="dim">${escapeHtml(l.note || 'charge')}</td></tr>`;
      }
      return `<tr><td>${formatDate(l.iso)}${l.undated ? ' <span class="pill bad">no date</span>' : ''}</td>` +
        `<td class="num">${formatINR(l.amount)}</td>` +
        (anyCharges ? `<td class="num${l.toCharges ? '' : ' dim'}">${formatINR(l.toCharges)}</td>` : '') +
        `<td class="num">${formatINR(l.toInterest)}</td><td class="num">${formatINR(l.toPrincipal)}</td>` +
        `<td class="num dim">${formatINR(l.principalAfter, { decimals: 0 })}</td>` +
        `<td class="dim">${escapeHtml(l.note || '')}</td></tr>`;
    }).join('') + '</tbody>';
}

function renderMethod(d, r) {
  const basis = d.dayCountBasis || 365;
  const chargeDay = ordinal(d.interestChargeDay || 1);
  const hasCharges = r.charges > 0 || r.totals.charges > 0;

  const items = d.capitalize === 'monthly' ? [
    `Interest accrues every day on the balance outstanding, at ${d.annualRatePercent}% ÷ ${basis} — ${formatINR(r.dailyInterest)} a day at today's balance.`,
    `On the ${chargeDay} of each month, the interest accrued that month is added to the balance and earns interest from then on. That is the same day your home loan takes its EMI.`,
    `A year counts as ${basis} days regardless of leap year, matching the home loan's convention.`,
    `A repayment clears the interest built up so far first, then comes off the ${formatINR(toPaiseSafe(d.principal), { decimals: 0 })} originally lent.`,
    `A repayment reduces the balance from that same day, so it stops costing interest immediately.`,
    `The day's interest is added at 00:00 (${d.timezone}), so the figure above covers interest through last night.`,
    `The rate follows your home loan. If it resets, record the change and the cost moves with it from that date.`,
  ] : [
    `Interest accrues daily on the outstanding principal at ${d.annualRatePercent}% ÷ ${basis} per day (${d.restMethod === 'monthly' ? 'monthly' : 'daily'} reducing balance).`,
    `A year counts as ${basis} days regardless of leap year, so a leap year charges the nominal annual rate over 366 days.`,
    `Accrued interest never capitalises: tomorrow's interest is charged on the same principal, never on principal plus today's interest.`,
    `Interest is debited on the ${chargeDay} of each month, rounded to the nearest rupee.`,
    `Each repayment is applied to the interest accrued so far, then to the principal.`,
    `A payment reduces the principal from that same day, so it stops accruing interest immediately.`,
    `The day's interest is added at 00:00 (${d.timezone}), so the figure above covers interest through last night.`,
  ];

  // Only worth explaining if there are any.
  if (hasCharges) {
    items.push('A repayment settles outstanding charges before interest. Charges never accrue interest of their own.');
  }

  $('method').innerHTML = items.map((i) => `<li>${i}</li>`).join('');
}

const toPaiseSafe = (rupees) => Math.round(Number(rupees) * 100);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('app').innerHTML = PAGE;
load();
