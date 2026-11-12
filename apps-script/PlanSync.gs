/**
 * VTR OT System – plan sync for the planning workbook (Plan2026-930).
 *
 * Paste this file into the planning workbook: Extensions → Apps Script.
 * Fill in FIREBASE_PROJECT_ID below, run setupTriggers() once, and allow the permissions.
 * After that, syncPlan() runs every day around 08:00 and 17:00 (Bangkok time).
 *
 * For each department tab it adds up the planned quantity per machine, date and shift,
 * divides by the machine's rate from the OT system (Firestore config/main) and saves one
 * plan per machine. The produced quantity (filled in about 2 days later) is saved as the
 * "output needed" hours. It reads 3 days back to tomorrow on every run.
 *
 * The Google account that runs setupTriggers() must be a member of the Firebase project
 * (Editor, or "Cloud Datastore User").
 */
const FIREBASE_PROJECT_ID = 'PUT-YOUR-FIREBASE-PROJECT-ID-HERE';
const TIMEZONE = 'Asia/Bangkok';
const DAYS_BACK = 3, DAYS_AHEAD = 1;

/* One entry per department tab. Columns are 0-based (A = 0). */
const ADAPTERS = [
  { id: '172', tab: 'dataPlan-172 Radial', date: 0, shift: 5, mach: 4, qty: 8, act: [12],
    // every FBM / SBM building machine is its own line
    map: function (m, machines) {
      const x = String(m).toUpperCase().replace(/\s+/g, '').match(/^(FBM|SBM)0*(\d+)$/);
      if (!x) return '';
      const id = '172-' + x[1] + ('0' + x[2]).slice(-2);
      return machines[id] ? id : '';
    } },
  { id: '173', tab: '173 BEAD dataPlan', date: 0, shift: 2, mach: 3, qty: 10, act: [13, 14], whole: true,
    map: function () { return '173-1'; } },  // bead + apex calculated as a whole
  { id: '120', tab: 'Tread dataPlan', date: 0, shift: 3, mach: 22, qty: 20, mult: 10, act: [25],
    // kg = treads × kg per tread, per extruder LINE
    map: function (m, machines) {
      const n = (String(m).match(/(\d+)/) || [])[1];
      if (!n) return '';
      for (const id in machines) {
        const mm = machines[id];
        if (mm.dept === '120' && mm.name.replace(/\s+/g, '').toLowerCase() === 'line' + n) return id;
      }
      return '';
    } },
  { id: '140', tab: '140-ตัด PLY (manual) dataPlan', date: 0, shift: 2, mach: 4, qty: 11, act: [18],
    map: function (m, machines) {
      const n = (String(m).match(/(\d+)/) || [])[1];
      return n && machines['140-' + n] ? '140-' + n : '';
    } },
];

/* ---------- entry points ---------- */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncPlan') ScriptApp.deleteTrigger(t); });
  [8, 17].forEach(function (h) {
    ScriptApp.newTrigger('syncPlan').timeBased().atHour(h).nearMinute(5).everyDays(1).inTimezone(TIMEZONE).create();
  });
  syncPlan();
}

function syncPlan() {
  const cfg = fsGet('config/main');
  if (!cfg) throw new Error('config/main not found in Firestore. Load the data file in the OT system first (Admin → Data).');
  const machines = {};
  (cfg.machines || []).forEach(function (m) { machines[m.id] = m; });
  const today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  const from = addDays(today, -DAYS_BACK), to = addDays(today, DAYS_AHEAD);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const done = [], failed = [], unmatched = [];
  let saved = 0;
  ADAPTERS.forEach(function (ad) {
    try {
      const sh = ss.getSheetByName(ad.tab);
      if (!sh) throw new Error('tab not found');
      const last = sh.getLastRow();
      const dates = sh.getRange(1, ad.date + 1, last, 1).getDisplayValues();
      let first = -1, end = -1;
      for (let i = 0; i < dates.length; i++) {
        const d = parseDateAny(dates[i][0]);
        if (d && d >= from && d <= to) { if (first < 0) first = i; end = i; }
      }
      if (first < 0) { done.push(ad.id + ' (0)'); return; }
      const width = Math.max.apply(null, [ad.date, ad.shift, ad.mach, ad.qty, ad.mult || 0].concat(ad.act)) + 1;
      const rows = sh.getRange(first + 1, 1, end - first + 1, width).getDisplayValues();
      const miss = {};
      const plans = aggregate(ad, rows, from, to, machines, miss);
      Object.keys(miss).forEach(function (m) { unmatched.push(ad.id + ': ' + m); });
      const writes = plans.map(function (p) {
        p.source = 'Plan2026-930 · ' + ad.tab; p.at = new Date().toISOString(); p.by = 'workbook script';
        return { update: { name: docName('plans/' + p.date + '_' + p.shift + '_' + p.machine), fields: fsFields(p) } };
      });
      for (let i = 0; i < writes.length; i += 400) fsCommit(writes.slice(i, i + 400));
      saved += plans.length;
      done.push(ad.id + ' (' + plans.length + ')');
    } catch (e) {
      failed.push(ad.id + ': ' + e.message);
    }
  });
  const hour = Number(Utilities.formatDate(new Date(), TIMEZONE, 'H'));
  fsCommit([{ update: { name: docName('sync/state'), fields: fsFields({
    slot: hour >= 17 ? today + ' 17:00' : today + ' 08:00', at: new Date().toISOString(), by: 'workbook script',
    done: done, failed: failed, unmatched: unmatched.slice(0, 30), saved: saved }) } }]);
  Logger.log('Saved %s plans. Done: %s. Failed: %s', saved, done.join(', '), failed.join('; '));
}

/* ---------- plan calculation (same rules as the OT system) ---------- */
function planShift(code) {
  const c = String(code || '').trim().replace(/^กะ/, '');
  if (/^(ช|เช้า)/.test(c)) return 'D';
  if (/^(บ|บ่าย)/.test(c)) return 'N';
  return '';   // blank, ไหล … are skipped
}
function aggregate(ad, rows, from, to, machines, miss) {
  const g = {};
  rows.forEach(function (r) {
    const d = parseDateAny(r[ad.date]); if (!d || d < from || d > to) return;
    const sh = planShift(r[ad.shift]); if (!sh) return;
    const mname = String(r[ad.mach] || '').trim();
    const mid = ad.map(mname, machines);
    if (!mid) { if (mname) miss[mname] = true; return; }
    const k = ad.mult != null ? (num(r[ad.mult]) || 0) : 1;
    const q = (num(r[ad.qty]) || 0) * k;
    const a = ad.act.reduce(function (s, c) { return s + (num(r[c]) || 0); }, 0) * k;
    const hasA = ad.act.some(function (c) { return String(r[c] || '').trim() !== ''; });
    const key = d + '|' + sh + '|' + mid;
    const o = g[key] = g[key] || { date: d, shift: sh, machine: mid, per: {}, anyAct: false };
    const pm = o.per[mname] = o.per[mname] || { q: 0, a: 0 };
    pm.q += q; pm.a += a; if (hasA) o.anyAct = true;
  });
  const out = [];
  Object.keys(g).forEach(function (key) {
    const o = g[key], m = machines[o.machine];
    if (!m || !(Number(m.rate) > 0)) return;
    const det = Object.keys(o.per).map(function (n) {
      const v = o.per[n];
      return { m: n, q: v.q, a: v.a, h: round2(v.q / m.rate), ah: round2(v.a / m.rate) };
    }).sort(function (x, y) { return y.h - x.h; });
    const Q = det.reduce(function (s, x) { return s + x.q; }, 0), A = det.reduce(function (s, x) { return s + x.a; }, 0);
    const hours = ad.whole ? Q / m.rate : Math.max.apply(null, [0].concat(det.map(function (x) { return x.h; })));
    const ah = o.anyAct ? (ad.whole ? A / m.rate : Math.max.apply(null, [0].concat(det.map(function (x) { return x.ah; })))) : null;
    out.push({ date: o.date, shift: o.shift, dept: m.dept, machine: o.machine, qty: Q, hours: round2(hours),
      actualQty: o.anyAct ? A : null, actualHours: ah == null ? null : round2(ah), detail: det.slice(0, 40) });
  });
  return out;
}

/* ---------- parsing helpers ---------- */
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : null; }
function round2(x) { return Math.round(x * 100) / 100; }
function pad(n) { return ('0' + n).slice(-2); }
function parseDateAny(v) {
  const s = String(v == null ? '' : v).trim(); if (!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) return null;
  let y = Number(m[3]); if (y < 100) y += 2000; if (y > 2400) y -= 543;
  const mo = Number(m[2]), d = Number(m[1]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y + '-' + pad(mo) + '-' + pad(d);
}
function addDays(iso, n) {
  const p = iso.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/* ---------- Firestore REST ---------- */
function base() { return 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents'; }
function docName(path) { return 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + path; }
function headers() { return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }; }
function fsGet(path) {
  const r = UrlFetchApp.fetch(base() + '/' + path, { headers: headers(), muteHttpExceptions: true });
  if (r.getResponseCode() === 404) return null;
  if (r.getResponseCode() !== 200) throw new Error('Firestore read failed (' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 300));
  return fromFields(JSON.parse(r.getContentText()).fields || {});
}
function fsCommit(writes) {
  if (!writes.length) return;
  const r = UrlFetchApp.fetch(base() + ':commit', { method: 'post', contentType: 'application/json', headers: headers(),
    payload: JSON.stringify({ writes: writes }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Firestore write failed (' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 300));
}
function fsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  return { mapValue: { fields: fsFields(v) } };
}
function fsFields(o) { const f = {}; Object.keys(o).forEach(function (k) { f[k] = fsValue(o[k]); }); return f; }
function fromValue(x) {
  if ('stringValue' in x) return x.stringValue;
  if ('integerValue' in x) return Number(x.integerValue);
  if ('doubleValue' in x) return x.doubleValue;
  if ('booleanValue' in x) return x.booleanValue;
  if ('nullValue' in x) return null;
  if ('arrayValue' in x) return (x.arrayValue.values || []).map(fromValue);
  if ('mapValue' in x) return fromFields(x.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; Object.keys(f).forEach(function (k) { o[k] = fromValue(f[k]); }); return o; }
