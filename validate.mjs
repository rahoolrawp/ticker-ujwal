// Schema and sanity checks for data.json.
// Runs in CI on every push, so a typo in a hand-edited commit fails loudly
// here instead of silently blanking the page.
// Usage: node validate.mjs [path]

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dayNum } from './loan.js';

const path = process.argv[2];
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(dayNum(v))
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// With no argument: validate every ledger named in people.json, or fall back
// to a single data.json when there is no manifest (a one-person repo).
if (!path && !existsSync('people.json')) {
  if (!existsSync('data.json')) {
    console.error('FAIL  neither people.json nor data.json found');
    process.exit(1);
  }
  const r = spawnSync(process.argv[0], [fileURLToPath(import.meta.url), 'data.json'], { encoding: 'utf8' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

if (!path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync('people.json', 'utf8'));
  } catch (e) {
    console.error(`FAIL  people.json is missing or not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(manifest) || !manifest.length) {
    console.error('FAIL  people.json must be a non-empty array of { slug, name }');
    process.exit(1);
  }
  const seen = new Set();
  let failed = 0;
  for (const p of manifest) {
    if (!p || typeof p.slug !== 'string' || !/^[a-z0-9-]+$/.test(p.slug)) {
      console.error(`FAIL  people.json: slug ${JSON.stringify(p && p.slug)} must be lowercase letters, digits or dashes`);
      failed++; continue;
    }
    if (typeof p.name !== 'string' || !p.name.trim()) {
      console.error(`FAIL  people.json: ${p.slug} needs a name`);
      failed++; continue;
    }
    if (seen.has(p.slug)) { console.error(`FAIL  people.json: duplicate slug ${p.slug}`); failed++; continue; }
    seen.add(p.slug);
    if (!existsSync(`${p.slug}/index.html`)) {
      console.error(`FAIL  ${p.slug}/index.html is missing, so ${p.name}'s page would 404`);
      failed++;
    }
    const r = spawnSync(process.argv[0], [fileURLToPath(import.meta.url), `${p.slug}/data.json`], { encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

let data;
try {
  data = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`FAIL  ${path} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const num = (key, v, { min = 0, max = Infinity, required = true } = {}) => {
  if (v === null || v === undefined) {
    if (required) err(`${key} is required`);
    return;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return err(`${key} must be a number, got ${JSON.stringify(v)}`);
  if (v < min) err(`${key} must be >= ${min}, got ${v}`);
  if (v > max) err(`${key} must be <= ${max}, got ${v}`);
};

num('principal', data.principal, { min: 1 });
num('annualRatePercent', data.annualRatePercent, { min: 0, max: 100 });
if (!isIso(data.startDate)) err(`startDate must be a real YYYY-MM-DD date, got ${JSON.stringify(data.startDate)}`);
if (![365, 360, 366].includes(data.dayCountBasis ?? 365)) err(`dayCountBasis should be 365 (Indian norm), 360 or 366`);
if (!['daily', 'monthly'].includes(data.restMethod ?? 'daily')) err(`restMethod must be "daily" or "monthly"`);
if (![undefined, null, 'none', 'monthly'].includes(data.capitalize)) err(`capitalize must be "monthly" or "none"`);
if (![undefined, null, true, false].includes(data.roundMonthlyInterest)) err('roundMonthlyInterest must be true or false');
if (data.counterparty !== undefined && data.counterparty !== null && typeof data.counterparty !== 'string') {
  err('counterparty must be a name, or null');
}
num('interestChargeDay', data.interestChargeDay ?? 1, { min: 1, max: 31 });
if (typeof data.timezone !== 'string' || !data.timezone.includes('/')) err(`timezone must be an IANA zone like "Asia/Kolkata"`);
else {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone }); }
  catch { err(`timezone "${data.timezone}" is not a zone this runtime knows`); }
}

const start = isIso(data.startDate) ? dayNum(data.startDate) : null;
const today = dayNum(new Date().toISOString().slice(0, 10));

const checkDated = (name, arr, extra = () => {}) => {
  if (arr === undefined || arr === null) return;
  if (!Array.isArray(arr)) return err(`${name} must be an array`);
  let prev = -Infinity;
  arr.forEach((raw, i) => {
    const at = `${name}[${i}]`;
    if (typeof raw === 'number') {
      return err(`${at} is a bare number (${raw}). Give it the date the payment was actually made: ` +
        `{ "date": "YYYY-MM-DD", "amount": ${raw} }`);
    }
    const it = raw;
    if (!it || typeof it !== 'object') return err(`${at} must be an object`);
    if (it.date === undefined || it.date === null) {
      return err(`${at} has no date. Add the date it actually happened, not the date you recorded it.`);
    }
    if (!isIso(it.date)) return err(`${at}.date must be a real YYYY-MM-DD date, got ${JSON.stringify(it.date)}`);
    const d = dayNum(it.date);
    if (start !== null && d < start) err(`${at}.date (${it.date}) is before startDate (${data.startDate})`);
    if (d > today) warn(`${at}.date (${it.date}) is in the future and will be ignored until then`);
    if (d < prev) warn(`${at} is out of chronological order (harmless, but harder to read)`);
    prev = d;
    if (it.note !== undefined && typeof it.note !== 'string') err(`${at}.note must be a string`);
    extra(at, it);
  });
};

checkDated('payments', data.payments, (at, it) => num(`${at}.amount`, it.amount, { min: 0.01 }));
checkDated('charges', data.charges, (at, it) => num(`${at}.amount`, it.amount, { min: 0.01 }));
checkDated('advances', data.advances, (at, it) => num(`${at}.amount`, it.amount, { min: 0.01 }));
checkDated('rateChanges', data.rateChanges, (at, it) => {
  num(`${at}.annualRatePercent`, it.annualRatePercent, { min: 0, max: 100 });
});

if (data.emi !== undefined && data.emi !== null) {
  if (typeof data.emi !== 'object') err('emi must be an object');
  else {
    if (data.emi.amount !== null && data.emi.amount !== undefined) {
      num('emi.amount', data.emi.amount, { min: 1 });
    } else {
      warn('emi.amount is not set - schedule tracking and payoff projection stay hidden');
    }
    num('emi.dayOfMonth', data.emi.dayOfMonth ?? 1, { min: 1, max: 31 });
    if (data.emi.firstDate !== undefined && data.emi.firstDate !== null && !isIso(data.emi.firstDate)) {
      err(`emi.firstDate must be a real YYYY-MM-DD date, got ${JSON.stringify(data.emi.firstDate)}`);
    }
  }
}
if (data.tenureMonths !== null && data.tenureMonths !== undefined) {
  num('tenureMonths', data.tenureMonths, { min: 1, max: 600 });
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`FAIL  ${e}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s) in ${path}. The site would not render correctly.`);
  process.exit(1);
}
console.log(`OK    ${path} is valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
