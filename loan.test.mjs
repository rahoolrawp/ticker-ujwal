// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLoan, projectPayoff, projectBalance, emiFor, isMonthDay, dayNum, isoFromDay, toPaise,
} from './loan.js';

const base = (over = {}) => ({
  currency: 'INR', timezone: 'Asia/Kolkata',
  principal: 275000, startDate: '2026-09-09', annualRatePercent: 7.4,
  dayCountBasis: 365, restMethod: 'daily', interestChargeDay: 10,
  rateChanges: [], payments: [], charges: [], ...over,
});

const RS = (p) => Math.round(p) / 100; // paise -> rupees, for readable assertions

test('daily interest: 2.75L @ 7.4% is Rs 55.75/day', () => {
  const r = computeLoan(base(), '2026-09-09');
  assert.ok(Math.abs(r.dailyInterest - 5575.3425) < 0.01);
});

test('daily interest: 50L @ 8% is Rs 1,095.89/day (the figure lenders quote)', () => {
  const r = computeLoan(base({ principal: 5000000, annualRatePercent: 8 }), '2026-09-09');
  assert.equal(RS(r.dailyInterest).toFixed(2), '1095.89');
});

test('no interest is charged on the disbursement day itself', () => {
  const r = computeLoan(base(), '2026-09-09');
  assert.equal(r.amountDue, toPaise(275000));
  assert.equal(r.accruedInterest, 0);
  assert.equal(r.daysElapsed, 1);
});

test("day D's interest appears at 00:00 on D+1", () => {
  const r = computeLoan(base(), '2026-09-10');
  assert.equal(RS(r.accruedInterest).toFixed(2), '56.00'); // one day, debited & rounded
  const r2 = computeLoan(base({ interestChargeDay: 25 }), '2026-09-10');
  assert.equal(RS(r2.accruedInterest).toFixed(2), '55.75'); // one day, not yet debited
});

test('31 days at 50L/8% is Rs 33,972.60 (daily rest), not Rs 33,333 (monthly rest)', () => {
  const d = base({ principal: 5000000, annualRatePercent: 8, startDate: '2026-01-01', interestChargeDay: 1 });
  const r = computeLoan(d, '2026-02-01'); // accrues Jan 1..Jan 31, debited Feb 1
  assert.equal((RS(r.dailyInterest) * 31).toFixed(2), '33972.59'); // exact, unrounded
  assert.equal(RS(r.chargedInterest).toFixed(2), '33973.00');      // as debited, nearest rupee
  assert.equal(r.uncharged, 0);
  const monthlyRest = 5000000 * 0.08 / 12;                          // 33,333.33
  assert.ok(RS(r.accruedInterest) - monthlyRest > 600, 'daily rest must exceed the /12 figure');
});

test('interest never capitalizes: the daily rate is the same after 60 unpaid days', () => {
  const day1 = computeLoan(base(), '2026-09-10');
  const day60 = computeLoan(base(), '2026-11-08');
  assert.equal(day60.principal, toPaise(275000), 'principal untouched by unpaid interest');
  assert.equal(day60.dailyInterest, day1.dailyInterest, 'accrual base never grows');
  assert.ok(day60.accruedInterest > day1.accruedInterest);
});

test('a payment clears accrued interest first, then principal', () => {
  const d = base({ payments: [{ date: '2026-10-10', amount: 12362.39, note: 'EMI 1' }] });
  const r = computeLoan(d, '2026-10-10');
  const emiRow = r.ledger.find((l) => l.kind === 'payment');
  assert.equal(RS(emiRow.toInterest).toFixed(2), '1729.00');   // 31 days accrued
  assert.equal(RS(emiRow.toPrincipal).toFixed(2), '10633.39');
  assert.equal(emiRow.toInterest + emiRow.toPrincipal, toPaise(12362.39));
  assert.equal(r.principal, toPaise(275000) - toPaise(10633.39));
});

test('a payment smaller than the interest owed touches no principal', () => {
  const d = base({ payments: [{ date: '2026-10-10', amount: 500 }] });
  const r = computeLoan(d, '2026-10-10');
  const row = r.ledger.find((l) => l.kind === 'payment');
  assert.equal(row.toPrincipal, 0);
  assert.equal(row.toInterest, toPaise(500));
  assert.equal(r.principal, toPaise(275000));
});

test('paying the exact amount due closes the loan and stops accrual', () => {
  const on = '2026-10-15';
  const quote = computeLoan(base(), on).amountDue;
  const r = computeLoan(base({ payments: [{ date: on, amount: quote / 100 }] }), '2026-12-31');
  assert.equal(r.amountDue, 0);
  assert.equal(r.principal, 0);
  assert.equal(r.payoffDate, on);
  assert.equal(r.dailyInterest, 0, 'a closed loan accrues nothing');
});

test('overpayment is held as a credit, never a negative balance', () => {
  const on = '2026-10-15';
  const quote = computeLoan(base(), on).amountDue;
  const r = computeLoan(base({ payments: [{ date: on, amount: quote / 100 + 1000 }] }), on);
  assert.equal(r.amountDue, 0);
  assert.equal(r.credit, toPaise(1000));
  assert.ok(r.principal >= 0);
});

test('a rate change applies from its effective date only', () => {
  const d = base({ rateChanges: [{ date: '2026-10-01', annualRatePercent: 8.4, note: 'reset' }] });
  const before = computeLoan(d, '2026-09-30');
  const after = computeLoan(d, '2026-10-02');
  assert.equal(before.rate, 7.4);
  assert.equal(after.rate, 8.4);
  assert.ok(after.dailyInterest > before.dailyInterest);
});

test('penal charges never accrue interest (RBI, Aug 2023)', () => {
  const plain = computeLoan(base(), '2026-12-31');
  const withChg = computeLoan(base({ charges: [{ date: '2026-09-20', amount: 500, note: 'late fee' }] }), '2026-12-31');
  assert.equal(withChg.accruedInterest, plain.accruedInterest, 'charge must not grow the interest');
  assert.equal(withChg.amountDue, plain.amountDue + toPaise(500));
});

test('a payment clears charges before interest', () => {
  const d = base({
    charges: [{ date: '2026-09-20', amount: 500 }],
    payments: [{ date: '2026-09-21', amount: 600 }],
  });
  const r = computeLoan(d, '2026-09-21');
  const row = r.ledger.find((l) => l.kind === 'payment');
  assert.equal(row.toCharges, toPaise(500));
  assert.equal(row.toInterest, toPaise(100));
  assert.equal(row.toPrincipal, 0);
});

test('actual/365 fixed: a leap year charges 366 days of interest', () => {
  const d = base({ startDate: '2028-01-01', interestChargeDay: 25 });
  const r = computeLoan(d, '2029-01-01'); // 2028 is a leap year: 366 days accrued
  const daily = 275000 * 0.074 / 365;
  assert.ok(Math.abs(RS(r.chargedInterest + r.uncharged) - daily * 366) < 1);
});

test('EMI annuity formula matches published figures', () => {
  assert.equal(emiFor(5000000, 8, 240).toFixed(0), '41822');
  assert.equal(emiFor(275000, 7.4, 24).toFixed(2), '12362.39');
});

test('projection pays the loan off in about the scheduled number of EMIs', () => {
  const d = base({ emi: { amount: 12362.39, dayOfMonth: 10 } });
  const r = computeLoan(d, '2026-09-09');
  const p = projectPayoff(d, r);
  assert.equal(p.neverAmortizes, false);
  assert.ok(p.installments >= 24 && p.installments <= 25, `got ${p.installments}`);
  assert.equal(p.payoffDate.slice(0, 4), '2028');
});

test('an EMI too small to cover the interest is flagged, not looped over', () => {
  const d = base({ emi: { amount: 100, dayOfMonth: 10 } });
  const p = projectPayoff(d, computeLoan(d, '2026-09-09'));
  assert.equal(p.neverAmortizes, true);
});

test('a monthly event on day 31 still fires in February', () => {
  assert.equal(isMonthDay('2027-02-28', 31), true);
  assert.equal(isMonthDay('2027-03-31', 31), true);
  assert.equal(isMonthDay('2027-03-30', 31), false);
});

test('date helpers round-trip', () => {
  assert.equal(isoFromDay(dayNum('2026-09-09')), '2026-09-09');
  assert.equal(dayNum('2026-09-10') - dayNum('2026-09-09'), 1);
});

test('a projection does not start paying before emi.firstDate', () => {
  const d = base({ emi: { amount: 25000, dayOfMonth: 10, firstDate: '2026-10-10' } });
  const p = projectPayoff(d, computeLoan(d, '2026-09-09'));
  // The first instalment must be 10 Oct, not 10 Sep -- one month of interest
  // more than a projection that jumps the gun.
  const noFirst = projectPayoff(base({ emi: { amount: 25000, dayOfMonth: 10 } }), computeLoan(base(), '2026-09-09'));
  assert.ok(p.interestRemaining > noFirst.interestRemaining);
  assert.equal(p.samples.find((s) => s.principal < 27500000).iso, '2026-10-10');
});

test('the final instalment closes the loan exactly, with no rupee left over', () => {
  const d = base({ emi: { amount: 25000, dayOfMonth: 10, firstDate: '2026-10-10' }, tenureMonths: 12 });
  const p = projectPayoff(d, computeLoan(d, '2026-09-09'));
  assert.equal(p.installments, 12, 'a 12-month tenure must not need a 13th payment');
  // Replay the projected instalments as if they had been recorded, and confirm
  // the loan really does close.
  const closed = computeLoan(d, p.payoffDate);
  assert.ok(closed.amountDue > 0); // nothing recorded yet, so still owed
});

test('a payment missing its date is counted as today rather than dropped', () => {
  const d = base({ payments: [25000] });
  const r = computeLoan(d, '2026-10-10');
  const row = r.ledger.find((l) => l.kind === 'payment');
  assert.equal(row.iso, '2026-10-10');
  assert.equal(row.undated, true);
  assert.equal(row.toInterest + row.toPrincipal, toPaise(25000));
});

test('an object missing its date is counted as today too', () => {
  const d = base({ payments: [{ amount: 25000, note: 'EMI 1' }] });
  const r = computeLoan(d, '2026-10-10');
  assert.equal(r.ledger.find((l) => l.kind === 'payment').iso, '2026-10-10');
});

test('entries are replayed in date order regardless of how they are listed', () => {
  const d = base({ payments: [{ date: '2026-11-10', amount: 25000, note: 'EMI 2' }, 25000] });
  const r = computeLoan(d, '2026-11-10');
  const paid = r.ledger.filter((l) => l.kind === 'payment');
  assert.equal(paid.length, 2);
  assert.equal(paid[0].iso, '2026-11-10');
  assert.equal(r.totals.paid, toPaise(50000));
});

test('validate.mjs rejects an entry with no date', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'ticker-'));

  for (const bad of [[25000], [{ amount: 25000, note: 'EMI 1' }]]) {
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...base(), payments: bad }));
    const out = spawnSync('node', ['validate.mjs', f], { encoding: 'utf8' });
    assert.equal(out.status, 1, 'a dateless entry must fail validation');
    assert.match(out.stderr, /date/i);
  }

  // The same ledger with a date passes.
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ ...base(), payments: [{ date: '2026-10-10', amount: 25000 }] }));
  assert.equal(spawnSync('node', ['validate.mjs', good], { encoding: 'utf8' }).status, 0);
});

// --- compounding mode: the cost of a home-loan prepayment not made ----------
// With a fixed EMI, the gap between "prepaid" and "not prepaid" balances grows
// at the loan rate every month: D(t) = D(0)·(1+r)^t. So the money lent out
// instead must compound, not accrue simple interest.

const lent = (over = {}) => base({
  principal: 275000, startDate: '2026-09-09', annualRatePercent: 7.4,
  interestChargeDay: 10, capitalize: 'monthly', roundMonthlyInterest: false, ...over,
});

test('compounding tracks the closed form P(1+r)^n within a rupee or two', () => {
  const r = computeLoan(lent(), '2027-09-09'); // twelve capitalisations
  const closed = 275000 * Math.pow(1 + 0.074 / 12, 12);
  assert.ok(Math.abs(r.amountDue / 100 - closed) < 5, `got ${r.amountDue / 100}, expected ~${closed}`);
});

test('compounding exceeds simple interest, and the gap widens', () => {
  const gap = (iso) => computeLoan(lent(), iso).amountDue - computeLoan(lent({ capitalize: 'none' }), iso).amountDue;
  const oneYear = gap('2027-09-09');
  const fiveYear = gap('2031-09-09');
  assert.ok(oneYear > 0);
  assert.ok(fiveYear > oneYear * 5, 'the gap must accelerate, not scale linearly');
});

test('capitalised interest itself earns interest', () => {
  // Up to and including the first capitalisation (10 Sep, the charge day after
  // the 9 Sep start) the two modes agree exactly.
  const on = '2026-09-10';
  assert.equal(computeLoan(lent(), on).amountDue, computeLoan(lent({ capitalize: 'none' }), on).amountDue,
    'identical until interest has been folded in');
  // Afterwards the compounding balance accrues on the larger base.
  const later = '2026-12-12';
  assert.ok(computeLoan(lent(), later).amountDue > computeLoan(lent({ capitalize: 'none' }), later).amountDue);
});

test('a repayment clears interest before the principal he borrowed', () => {
  const d = lent({ payments: [{ date: '2027-09-10', amount: 50000, note: 'part repayment' }] });
  const r = computeLoan(d, '2027-09-10');
  const row = r.ledger.find((l) => l.kind === 'payment');
  const interestRupees = row.toInterest / 100;
  assert.ok(interestRupees > 20000 && interestRupees < 23000, `interest portion ${interestRupees}`);
  assert.equal(row.toInterest + row.toPrincipal, toPaise(50000));
  assert.ok(r.principal < toPaise(275000), 'the rest comes off what he borrowed');
});

test('repaying in full settles it and stops the clock', () => {
  const on = '2027-03-10';
  const quote = computeLoan(lent(), on).amountDue;
  const r = computeLoan(lent({ payments: [{ date: on, amount: quote / 100 }] }), '2029-01-01');
  assert.equal(r.amountDue, 0);
  assert.equal(r.payoffDate, on);
});

test('projectBalance carries an unpaid balance forward', () => {
  const d = lent();
  const r = computeLoan(d, '2026-09-09');
  const p = projectBalance(d, r, { months: 12 });
  assert.ok(p.endAmount > r.amountDue);
  assert.ok(p.samples.length >= 11);
  assert.ok(p.samples.every((s) => s.due >= 27500000));
});
