// Loan arithmetic for an Indian home loan on daily reducing balance.
// Pure: no DOM, no I/O. Imported by app.js (browser) and loan.test.mjs (node).
//
// Model, as verified against lender disclosures and RBI rules (see plan.md §2):
//   - interest accrues daily on the outstanding principal
//   - actual/365 fixed: 365 days regardless of leap year
//   - accrued interest NEVER capitalizes into principal
//   - interest is debited to the account monthly, rounded to the nearest rupee
//   - payments appropriate charges -> interest -> principal
//   - penal/other charges never accrue interest (RBI, Aug 2023)
//
// All money is handled in integer paise. The one exception is the running
// accrual for the current month, which is kept as exact fractional paise and
// rounded only when it is debited -- so rounding cannot compound across years.

const MS_PER_DAY = 86400000;

// --- dates -----------------------------------------------------------------
// Days are integers (days since epoch) so arithmetic can't drift across DST or
// timezones. Every date in the ledger is a plain 'YYYY-MM-DD' in the loan's
// own timezone; no time-of-day is ever involved.

export function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function isoFromDay(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysInMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// A monthly event set for day 31 must still fire in February.
export function isMonthDay(iso, wanted) {
  const dom = Number(iso.slice(8, 10));
  return dom === Math.min(wanted, daysInMonth(iso));
}

export function todayIso(timeZone) {
  // 'en-CA' formats as YYYY-MM-DD, which is what the ledger uses.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Seconds remaining until 00:00 in the loan's timezone -- when the amount due
// next changes.
export function secondsToMidnight(timeZone, now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const secs = Number(p.hour) % 24 * 3600 + Number(p.minute) * 60 + Number(p.second);
  return 86400 - secs;
}

// --- money -----------------------------------------------------------------

export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupeeUnits = (paise) => Math.round(paise / 100) * 100; // nearest rupee, in paise

// --- the simulation --------------------------------------------------------

// --- ledger entries -------------------------------------------------------
// Every entry carries the date the thing actually happened -- the day a payment
// was made, not the day it was recorded, which may be later.
//
// An entry with no date is a mistake (validate.mjs rejects it). Rather than
// drop the money silently, it is counted as today's and flagged, so the figure
// is close and the fault is visible on the page.

export function normalizeEntries(list, fallbackIso) {
  return (list || [])
    .map((item) => {
      if (typeof item === 'number') return { date: fallbackIso, amount: item, note: '', undated: true };
      if (item && typeof item === 'object') {
        return item.date ? item : { ...item, date: fallbackIso, undated: true };
      }
      return null;
    })
    .filter((it) => it && Number.isFinite(Number(it.amount)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function newState(data) {
  return {
    principal: toPaise(data.principal),  // integer paise
    chargedInterest: 0,                  // interest debited but unpaid, integer paise
    cycleAccrual: 0,                     // this month's accrual so far, exact paise
    outstandingCharges: 0,               // penal/other charges unpaid, integer paise
    credit: 0,                           // overpayment
    totalLent: toPaise(data.principal),  // opening amount plus later advances
    paidTotal: 0, paidInterest: 0, paidPrincipal: 0, paidCharges: 0,
    interestCharged: 0,                  // lifetime interest debited
    cycleStartPrincipal: toPaise(data.principal), // for monthly-rest lenders
    payoffDay: null,
  };
}

// When interest capitalises, the interest already folded in earns interest too.
// That is the whole point of the compounding mode: it mirrors what a fixed EMI
// does to a home loan balance when a prepayment is not made.
function interestBearing(st, ctx) {
  return ctx.capitalize === 'monthly' ? st.principal + st.chargedInterest : st.principal;
}

export function amountDue(st) {
  return st.principal + st.chargedInterest + Math.round(st.cycleAccrual) + st.outstandingCharges;
}

// Appropriation order is fixed by the loan agreement, not by preference:
// charges first, then interest, then principal.
function appropriate(st, paise) {
  let rem = paise;
  const toCharges = Math.min(rem, st.outstandingCharges);
  st.outstandingCharges -= toCharges; rem -= toCharges;

  const toDebited = Math.min(rem, st.chargedInterest);
  st.chargedInterest -= toDebited; rem -= toDebited;

  // Interest accrued this month but not yet debited. Payable on a payoff.
  const accrued = Math.round(st.cycleAccrual);
  const toAccrued = Math.min(rem, accrued);
  st.cycleAccrual = Math.max(0, st.cycleAccrual - toAccrued); rem -= toAccrued;

  const toPrincipal = Math.min(rem, st.principal);
  st.principal -= toPrincipal; rem -= toPrincipal;

  st.paidCharges += toCharges;
  st.paidInterest += toDebited + toAccrued;
  st.paidPrincipal += toPrincipal;
  st.paidTotal += paise - rem;
  st.credit += rem;

  return { toCharges, toInterest: toDebited + toAccrued, toPrincipal, overpay: rem };
}

/**
 * Walk the loan one day at a time from `fromDay` to `toDay` inclusive.
 * `events(iso, day)` returns { payments: [...], charges: [...] } for that day.
 *
 * Order within a day matters and mirrors how a loan account is actually posted:
 *   1. charges are raised
 *   2. the month's accrued interest is debited (on the charging date)
 *   3. payments are applied
 *   4. the day's interest accrues on the post-payment principal
 *
 * Step 4 after step 3 is what "the principal reduces from the day you pay your
 * EMI" means; step 2 before step 3 is why an EMI clears that month's interest.
 * The day's interest is credited at 00:00 tomorrow, so a figure shown today
 * covers interest through last night.
 */
// `events(iso, day)` returns { payments, charges, advances } for that day.
export function runDays(st, ctx, fromDay, toDay, events) {
  for (let day = fromDay; day <= toDay; day++) {
    const iso = isoFromDay(day);

    // 1. Yesterday's interest is credited now, at 00:00. ctx.rate still holds
    //    the rate that was in force yesterday, which is the rate that applies.
    if (day > ctx.startDay) {
      const base = ctx.restMethod === 'monthly' ? st.cycleStartPrincipal : interestBearing(st, ctx);
      st.cycleAccrual += (base * ctx.rate) / 100 / ctx.basis;
    }

    // 2. Any rate reset effective today takes over from here on.
    while (ctx.rateIdx < ctx.rates.length && ctx.rates[ctx.rateIdx].day <= day) {
      ctx.rate = ctx.rates[ctx.rateIdx++].rate;
    }

    // 3. Monthly interest debit, rounded to the nearest rupee as a bank does.
    //    Runs before payments so that an EMI clears the interest just debited,
    //    and before events() so a final instalment sized to "whatever is owed"
    //    sees the rounded figure rather than the fraction underneath it.
    if (day > ctx.startDay && isMonthDay(iso, ctx.chargeDay)) {
      const debit = ctx.roundMonthly ? toRupeeUnits(st.cycleAccrual) : Math.round(st.cycleAccrual);
      if (debit !== 0) {
        st.chargedInterest += debit;
        st.interestCharged += debit;
        ctx.ledger.push({
          iso, kind: 'interest', amount: debit,
          note: ctx.capitalize === 'monthly' ? 'interest added to the balance' : 'monthly interest debited',
        });
      }
      st.cycleAccrual = 0;
      st.cycleStartPrincipal = st.principal;
    }

    const ev = events(iso, day);

    // 3b. Further money lent today. It joins the principal and starts earning
    //     interest from tomorrow, exactly as the opening amount did.
    for (const adv of ev.advances) {
      const paise = toPaise(adv.amount);
      st.principal += paise;
      st.totalLent += paise;
      ctx.ledger.push({
        iso, kind: 'advance', amount: paise, note: adv.note || '',
        principalAfter: st.principal, dueAfter: amountDue(st),
      });
    }

    // 4. Charges raised today. These never accrue interest (RBI, Aug 2023).
    for (const c of ev.charges) {
      st.outstandingCharges += toPaise(c.amount);
      ctx.ledger.push({ iso, kind: 'charge', amount: toPaise(c.amount), note: c.note || '', undated: !!c.undated });
    }

    // 5. Payments. Principal falls today, so tomorrow's accrual is already
    //    smaller -- "the principal reduces from the day you pay your EMI".
    for (const p of ev.payments) {
      const paise = toPaise(p.amount);
      const split = appropriate(st, paise);
      ctx.ledger.push({
        iso, kind: p.synthetic ? 'emi-projected' : 'payment',
        amount: paise, note: p.note || '', undated: !!p.undated, ...split,
        principalAfter: st.principal, dueAfter: amountDue(st),
      });
    }

    if (st.payoffDay === null && day >= ctx.startDay && amountDue(st) === 0) {
      st.payoffDay = day;
    }

    if (isMonthDay(iso, ctx.chargeDay)) {
      ctx.samples.push({ iso, principal: st.principal, due: amountDue(st), interestCharged: st.interestCharged });
    }
  }
  return st;
}

function buildCtx(data) {
  const rates = (data.rateChanges || [])
    .map((r) => ({ day: dayNum(r.date), rate: Number(r.annualRatePercent), note: r.note || '' }))
    .sort((a, b) => a.day - b.day);
  return {
    basis: data.dayCountBasis ?? 365,
    restMethod: data.restMethod || 'daily',
    chargeDay: data.interestChargeDay ?? 1,
    capitalize: data.capitalize === 'monthly' ? 'monthly' : 'none',
    roundMonthly: data.roundMonthlyInterest !== false,
    startDay: dayNum(data.startDate),
    rate: Number(data.annualRatePercent),
    rates, rateIdx: 0,
    ledger: [], samples: [],
  };
}

function groupByDay(items) {
  const map = new Map();
  for (const it of items || []) {
    const k = it.date;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

/** Replay the recorded ledger up to `asOfIso` and return everything the UI needs. */
export function computeLoan(data, asOfIso) {
  const ctx = buildCtx(data);
  const st = newState(data);
  const payments = groupByDay(normalizeEntries(data.payments, asOfIso));
  const charges = groupByDay(normalizeEntries(data.charges, asOfIso));
  const advances = groupByDay(normalizeEntries(data.advances, asOfIso));

  const startDay = ctx.startDay;
  const endDay = dayNum(asOfIso);
  if (endDay >= startDay) {
    ctx.samples.push({ iso: data.startDate, principal: st.principal, due: amountDue(st), interestCharged: 0 });
    runDays(st, ctx, startDay, endDay, (iso) => ({
      payments: payments.get(iso) || [],
      charges: charges.get(iso) || [],
      advances: advances.get(iso) || [],
    }));
    ctx.samples.push({ iso: asOfIso, principal: st.principal, due: amountDue(st), interestCharged: st.interestCharged });
  }

  // Entries dated after today have not happened yet, so they take no part in
  // the arithmetic -- but they must still be visible, or a mistyped year looks
  // exactly like a broken page.
  const future = [
    ...normalizeEntries(data.payments, asOfIso).map((p) => ({ ...p, kind: 'payment' })),
    ...normalizeEntries(data.charges, asOfIso).map((c) => ({ ...c, kind: 'charge' })),
    ...normalizeEntries(data.advances, asOfIso).map((a) => ({ ...a, kind: 'advance' })),
  ].filter((e) => dayNum(e.date) > endDay).sort((a, b) => (a.date < b.date ? -1 : 1));

  const accrued = st.chargedInterest + Math.round(st.cycleAccrual);
  return {
    future,
    asOf: asOfIso,
    notStarted: endDay < startDay,
    daysElapsed: Math.max(0, endDay - startDay + 1),
    principal: st.principal,
    totalLent: st.totalLent,
    accruedInterest: accrued,
    chargedInterest: st.chargedInterest,
    uncharged: Math.round(st.cycleAccrual),
    charges: st.outstandingCharges,
    amountDue: amountDue(st),
    credit: st.credit,
    rate: ctx.rate,
    dailyInterest: (interestBearing(st, ctx) * ctx.rate) / 100 / ctx.basis,
    capitalizing: ctx.capitalize === 'monthly',
    totals: {
      paid: st.paidTotal,
      interest: st.paidInterest,
      principal: st.paidPrincipal,
      charges: st.paidCharges,
      interestCharged: st.interestCharged,
    },
    ledger: ctx.ledger,
    samples: ctx.samples,
    payoffDate: st.payoffDay === null ? null : isoFromDay(st.payoffDay),
    // carried forward so a projection can continue from exactly here
    _state: st, _ctx: ctx,
  };
}

/**
 * Continue the simulation past today, paying `emi.amount` on `emi.dayOfMonth`,
 * to find the payoff date and remaining interest at the current rate.
 * Returns null when there is no EMI to project or nothing left to pay.
 */
export function projectPayoff(data, result, { maxYears = 50 } = {}) {
  const emi = data.emi || {};
  if (!emi.amount || result.amountDue <= 0) return null;

  const st = { ...result._state };
  const ctx = { ...buildCtx(data), rateIdx: (data.rateChanges || []).length, rate: result.rate };
  ctx.ledger = []; ctx.samples = [];

  const emiPaise = toPaise(emi.amount);
  const from = dayNum(result.asOf) + 1;
  const to = from + Math.round(maxYears * 365);
  // Instalments do not start before the first EMI date -- on a freshly
  // disbursed loan that is typically the following month, not this one.
  const firstEmiDay = emi.firstDate ? dayNum(emi.firstDate) : -Infinity;

  // An EMI that never covers the interest would run forever -- catch it early
  // rather than looping for 50 simulated years.
  const monthlyInterest = (st.principal * ctx.rate) / 100 / ctx.basis * 30;
  if (emiPaise <= monthlyInterest) {
    return { neverAmortizes: true, monthlyInterest: Math.round(monthlyInterest) };
  }

  let installments = 0;
  let stop = to;
  for (let day = from; day <= to; day++) {
    runDays(st, ctx, day, day, (iso) => {
      if (amountDue(st) > 0 && day >= firstEmiDay && isMonthDay(iso, emi.dayOfMonth ?? ctx.chargeDay)) {
        installments++;
        // Never collect more than the loan owes on the final installment.
        return { payments: [{ amount: Math.min(emiPaise, amountDue(st)) / 100, synthetic: true, note: 'projected EMI' }], charges: [], advances: [] };
      }
      return { payments: [], charges: [], advances: [] };
    });
    if (amountDue(st) === 0) { stop = day; break; }
  }
  ctx.samples.push({ iso: isoFromDay(stop), principal: st.principal, due: amountDue(st), interestCharged: st.interestCharged });

  return {
    neverAmortizes: false,
    payoffDate: isoFromDay(stop),
    installments,
    interestRemaining: st.interestCharged - result.totals.interestCharged + Math.round(st.cycleAccrual),
    samples: ctx.samples,
  };
}

/**
 * Carry the balance forward with no repayments, to show what it becomes if it
 * is left outstanding. Samples on each capitalisation date.
 */
export function projectBalance(data, result, { months = 24 } = {}) {
  if (result.amountDue <= 0) return null;
  const st = { ...result._state };
  const ctx = { ...buildCtx(data), rateIdx: (data.rateChanges || []).length, rate: result.rate };
  ctx.ledger = []; ctx.samples = [];
  const from = dayNum(result.asOf) + 1;
  const to = from + Math.round(months * 30.44);
  runDays(st, ctx, from, to, () => ({ payments: [], charges: [], advances: [] }));
  return { samples: ctx.samples, endIso: isoFromDay(to), endAmount: amountDue(st) };
}

/** EMI from the standard annuity formula -- P·r·(1+r)^n / ((1+r)^n − 1). */
export function emiFor(principalRupees, annualRatePercent, months) {
  const r = annualRatePercent / 100 / 12;
  if (r === 0) return principalRupees / months;
  const f = Math.pow(1 + r, months);
  return (principalRupees * r * f) / (f - 1);
}

// --- formatting ------------------------------------------------------------

export function formatINR(paise, { decimals = 2 } = {}) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(paise / 100);
}

export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
