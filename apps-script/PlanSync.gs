/**
 * VTR OT System – plan sync (standalone Google Apps Script).
 *
 * Reads the three planning files whose links are saved in the OT system (Admin → Setup):
 *   - Plan2026-930   (Radial plan tabs)
 *   - Plan2026-Bias  (Bias plan tabs)
 *   - Capacity VTR   (daily capacity tab: plan and working hours per line)
 * and saves one plan per machine, date and shift in Firestore. Produced quantities (filled in about
 * 2 days later) are saved as the "output needed" hours. It reads 3 days back to tomorrow on every run.
 *
 * Setup: script.google.com → New project → paste this file and appsscript.json →
 * set FIREBASE_PROJECT_ID → run setupTriggers() once and allow the permissions.
 * It then runs every day around 08:00 and 17:00 (Bangkok time).
 * The account that runs it must be able to open the three files and be a member of the Firebase project.
 *
 * The calculation part below is the same code as in index.html (plan engine), so both give the same hours.
 */
const FIREBASE_PROJECT_ID = 'PUT-YOUR-FIREBASE-PROJECT-ID-HERE';
const TIMEZONE = 'Asia/Bangkok';
const DAYS_BACK = 3, DAYS_AHEAD = 1;

/* ---------- small helpers used by the plan engine ---------- */
let MACHINES = {};
function machine(id) { return MACHINES[id]; }
function cellStr(v) { return v == null ? '' : String(v).trim(); }
function parseNum(v) { if (typeof v === 'number') return v; const n = parseFloat(cellStr(v).replace(/,/g, '')); return isFinite(n) ? n : null; }
function pad(n) { return ('0' + n).slice(-2); }
function parseDateAny(v) {
  const s = cellStr(v); if (!s) return null;
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/) || s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
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
function fileIdFrom(u) { const m = cellStr(u).match(/\/d\/([A-Za-z0-9_\-]{20,})/); return m ? m[1] : ''; }
function colIndex(letters) { return letters.split('').reduce(function (n, c) { return n * 26 + c.charCodeAt(0) - 64; }, 0); }

/* ========== plan engine (same as index.html) ========== */
/* Rates come from the planner's "Capacity VTR" file (capacity per hour per line; per machine = line ÷ number of machines).
   Lines with a detailed plan tab are calculated per machine here; all other lines are read from the daily capacity tab. */
const capNum=x=>parseNum(x)||0;
/* 161 big bias tyres: rate by rim size (Capacity VTR: 16" 5/h, 20" 4/h, 24"–26" 1/h per machine). */
function rate161(size){const m=cellStr(size).match(/-\s*(\d+(?:\.\d+)?)/);const rim=m?+m[1]:20;return rim<=16?5:rim<24?4:1}
const PLAN_ADAPTERS=[
  /* ---- Plan2026-930 (Radial) ---- */
  /* 172: every FBM / SBM building machine is its own line (FBM 15/h, SBM 22/h per machine). */
  {id:'172',tab:'dataPlan-172 Radial',first:3,cols:'A:M',date:0,shift:5,mach:4,qty:8,act:[12],agg:'max',
   map:m=>{const x=String(m).toUpperCase().replace(/\s+/g,'').match(/^(FBM|SBM)0*(\d+)$/);if(!x)return '';const id='172-'+x[1]+String(x[2]).padStart(2,'0');return machine(id)?id:''}},
  /* 173 Radial bead + apex as a whole: bead wire 800/h, apex 600/h (rows whose item starts with A are apex). */
  {id:'173',tab:'173 BEAD dataPlan',first:3,cols:'A:O',date:0,shift:2,mach:null,qty:10,act:[13,14],agg:'sum',map:()=>'173-1',
   rowRate:r=>/^\s*A/i.test(cellStr(r[4]))?600:800},
  /* 140 manual tables MT1 / MT2 (Radial): rolls per hour. */
  {id:'140',tab:'140-ตัด PLY (manual) dataPlan',first:3,cols:'A:S',date:0,shift:2,mach:4,qty:10,act:[17],agg:'max',
   map:m=>{const n=(String(m).match(/(\d+)/)||[])[1];return n&&machine('140-MT'+n)?'140-MT'+n:''}},
  /* ---- Plan2026-Bias ---- */
  /* 161: one plan per machine per day (day shift only), rate by rim size. */
  {id:'161',book:'bias',tab:'dataPlan-ยางใหญ่',first:3,cols:'A:N',date:0,shift:null,mach:2,qty:9,act:[12,13],agg:'max',rowRate:r=>rate161(r[5]),
   map:m=>{const x=String(m).toUpperCase().replace(/\s+/g,'').match(/^B0*(\d+)$/);if(!x)return '';const id='161-B'+String(x[1]).padStart(2,'0');return machine(id)?id:''}},
  /* 162: per machine and shift, 43 per 8 h. */
  {id:'162',book:'bias',tab:'dataPlan-ยางเล็ก',first:3,cols:'A:O',date:0,shift:2,mach:3,qty:10,act:[13,14],agg:'max',
   map:m=>{const x=String(m).toUpperCase().replace(/\s+/g,'').match(/^A0*(\d+)$/);if(!x)return '';const id='162-A'+String(x[1]).padStart(2,'0');return machine(id)?id:''}},
  /* Bias ply cutting on Stock 1–5, in rolls (actual output is in metres: 35 m per roll). */
  {id:'140P',book:'bias',tab:'dataPlan-Ply',first:3,cols:'A:AB',date:0,shift:2,mach:3,qty:24,act:[27],actFactor:1/35,agg:'max',
   map:m=>{const n=(String(m).match(/(\d+)/)||[])[1];return n&&machine('140-'+n)?'140-'+n:''}},
  /* Tread ply, re-inforce, insert, chafer: no shift column, counted on the day shift. */
  {id:'140T',book:'bias',tab:'dataPlan-TR,RE,IN,CF',first:3,cols:'A:P',date:0,shift:null,mach:2,qty:12,act:[15],actFactor:1/35,agg:'max',
   map:m=>{const n=(String(m).match(/(\d+)/)||[])[1];return n&&machine('140-'+n)?'140-'+n:''}},
  /* Bias bead as a whole: bare wire 300/h + apex 187.5/h. */
  {id:'173B',book:'bias',tab:'dataPlan-BEAD',first:4,cols:'A:T',date:0,shift:null,mach:null,agg:'sum',map:()=>'173-2',
   rowCalc:r=>{const b=capNum(r[13]),x=capNum(r[14]),ab=capNum(r[18]),ax=capNum(r[19]);const has=cellStr(r[18])!==''||cellStr(r[19])!=='';
     return {q:b+x,h:b/300+x/187.5,a:ab+ax,ah:ab/300+ax/187.5,hasA:has}}},
];
/* Daily capacity tab (one tab per date): item names → machines. Lines calculated above are skipped here. */
const CAP_MAP=[
  [/^mixxingxm/,'110-XM'],[/^mixxinggk/,'110-GK'],[/^mixxingxy/,'110-XY'],[/^mixxing11d/,'110-11D'],
  [/^calender1/,'131-1'],[/^calender2/,'132-1'],[/^plycutting\(auto\)/,'2193-1'],[/^steelcalender/,'191-1'],[/^beltcutting/,'192-1'],[/^ตัดstrip/,'192-2'],
  [/^tubber1\(bias\)tread/,'120-T1T'],[/^tubber1\(bias\)sw/,'120-T1S'],[/^tubber2/,'120-T2'],[/^tubber3/,'120-T3'],[/^tubber5/,'120-T5'],[/^tubber6/,'120-T6'],
  [/^tubberออกapexพี่เนตร/,'120-AP1'],[/^tubberออกapexพี่จอย/,'120-AP2'],[/^gumcalender/,'141-1'],[/^capply/,'176-CAP'],[/^buildingsearim/,'176-SEARIM'],[/^buildingmt/,'176-MT'],
  [/^buildingประกอบแบรนด์16/,'163-B16'],[/^buildingประกอบแบรนด์20/,'163-B20'],[/^buildingประกอบแบรนด์24/,'163-B24'],
  [/^curing2a/,'2121-2A'],[/^curing2b/,'2121-2B'],[/^curing2c/,'2121-2C'],[/^curing2d/,'2121-2D'],[/^curing([a-k])$/,m=>'180-'+m[1].toUpperCase()],[/^uniformity/,'230-1'],
];
/* Lines that are calculated per machine from the detailed plan tabs, or are not production lines. */
const CAP_SKIP=[/^plycuttingstock/,/^bead/,/^buildingยางเล็ก/,/^buildingยางใหญ่/,/^buildingfbm/,/^buildingsbm/,/^steeladmin/];
function capMachine(item){const k=cellStr(item).toLowerCase().replace(/\s+/g,'');if(CAP_SKIP.some(re=>re.test(k)))return null;for(const [re,id] of CAP_MAP){const m=k.match(re);if(m){const x=typeof id==='function'?id(m):id;return machine(x)?x:''}}return ''}
/* One date tab → plans. Day: item C, plan G, working hours H. Night: item K, plan O, working hours P. The planner's working hours are already rounded up. */
function capacityPlans(date,rows){
  const out=[],skipped=new Set();
  for(const r of rows)for(const [sh,ci,pi,hi] of [['D',2,6,7],['N',10,14,15]]){
    const item=cellStr(r[ci]);if(!item)continue;const mid=capMachine(item);if(mid===null)continue;if(!mid){skipped.add(item);continue}
    const h=parseNum(r[hi]);if(!(h>0))continue;const q=capNum(r[pi]);const m=machine(mid);
    out.push({date,shift:sh,dept:m.dept,machine:mid,qty:q,hours:h,actualQty:null,actualHours:null,detail:[{m:item,q,h}]});
  }
  return {plans:out,skipped:[...skipped]};
}
function capTabNames(iso){const [y,m,d]=iso.split('-');return [`${d}/${m}/${y}`,`${+d}/${+m}/${y}`]}
/* Shift codes in the plan: ช / เช้า = day, บ / บ่าย = night; the number is the order inside the shift. Anything else (blank, ไหล) is skipped. */
function planShift(code){const c=cellStr(code).replace(/^กะ/,'');if(/^(ช|เช้า)/.test(c))return 'D';if(/^(บ|บ่าย)/.test(c))return 'N';return ''}
function aggregatePlan(ad,rows,from,to){
  const g={};
  for(const r of rows){
    const d=parseDateAny(r[ad.date]);if(!d||d<from||d>to)continue;
    const sh=ad.shift==null?'D':planShift(r[ad.shift]);if(!sh)continue;
    const mname=ad.mach==null?'all':cellStr(r[ad.mach]);const mid=ad.map(mname);if(!mid){if(mname&&ad._unmatched)ad._unmatched.add(mname);continue}
    const m=machine(mid);if(!m)continue;
    let c;
    if(ad.rowCalc)c=ad.rowCalc(r);
    else{const rate=ad.rowRate?ad.rowRate(r):+m.rate;const q=capNum(r[ad.qty]);const a=ad.act.reduce((s,x)=>s+capNum(r[x]),0)*(ad.actFactor!=null?ad.actFactor:1);
      c={q,h:rate>0?q/rate:0,a,ah:rate>0?a/rate:0,hasA:ad.act.some(x=>cellStr(r[x])!=='')}}
    const key=d+'|'+sh+'|'+mid;const o=g[key]=g[key]||{date:d,shift:sh,machine:mid,per:{},anyAct:false};
    const pm=o.per[mname]=o.per[mname]||{q:0,a:0,h:0,ah:0};pm.q+=c.q;pm.a+=c.a;pm.h+=c.h;pm.ah+=c.ah;if(c.hasA)o.anyAct=true;
  }
  const out=[];
  for(const o of Object.values(g)){
    const m=machine(o.machine);
    const det=Object.entries(o.per).map(([n,v])=>({m:n,q:+v.q.toFixed(2),a:+v.a.toFixed(2),h:+v.h.toFixed(2),ah:+v.ah.toFixed(2)})).sort((x,y)=>y.h-x.h);
    const Q=det.reduce((s,x)=>s+x.q,0),A=det.reduce((s,x)=>s+x.a,0);
    const hours=ad.agg==='sum'?det.reduce((s,x)=>s+x.h,0):Math.max(0,...det.map(x=>x.h));
    const ah=o.anyAct?(ad.agg==='sum'?det.reduce((s,x)=>s+x.ah,0):Math.max(0,...det.map(x=>x.ah))):null;
    out.push({date:o.date,shift:o.shift,dept:m.dept,machine:o.machine,qty:+Q.toFixed(2),hours:+hours.toFixed(2),actualQty:o.anyAct?+A.toFixed(2):null,actualHours:ah==null?null:+ah.toFixed(2),detail:det.slice(0,40)});
  }
  return out;
}

/* ========== sync ========== */
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
  MACHINES = {};
  (cfg.machines || []).forEach(function (m) { MACHINES[m.id] = m; });
  const books = { radial: fileIdFrom(cfg.planFeedUrl), bias: fileIdFrom(cfg.planFeedBiasUrl), capacity: fileIdFrom(cfg.capacityUrl) };
  const today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  const from = addDays(today, -DAYS_BACK), to = addDays(today, DAYS_AHEAD);
  const opened = {};
  const open = function (b) { if (!books[b]) return null; if (!opened[b]) opened[b] = SpreadsheetApp.openById(books[b]); return opened[b]; };
  const done = [], failed = [], unmatched = [], all = {};

  PLAN_ADAPTERS.forEach(function (ad) {
    const book = ad.book || 'radial';
    try {
      const ss = open(book); if (!ss) return;
      const sh = ss.getSheetByName(ad.tab); if (!sh) throw new Error('tab not found');
      const last = sh.getLastRow(); if (last < ad.first) { done.push(ad.id + ' (0)'); return; }
      const dates = sh.getRange(ad.first, ad.date + 1, last - ad.first + 1, 1).getDisplayValues();
      let first = -1, end = -1;
      for (let i = 0; i < dates.length; i++) { const d = parseDateAny(dates[i][0]); if (d && d >= from && d <= to) { if (first < 0) first = i; end = i; } }
      if (first < 0) { done.push(ad.id + ' (0)'); return; }
      const cols = ad.cols.split(':'), c0 = colIndex(cols[0]), c1 = colIndex(cols[1]);
      const rows = sh.getRange(ad.first + first, c0, end - first + 1, c1 - c0 + 1).getDisplayValues();
      ad._unmatched = new Set();
      const plans = aggregatePlan(ad, rows, from, to);
      if (ad._unmatched.size) unmatched.push(ad.id + ': ' + Array.from(ad._unmatched).slice(0, 12).join(', '));
      const src = (book === 'bias' ? 'Plan2026-Bias · ' : 'Plan2026-930 · ') + ad.tab;
      plans.forEach(function (p) {
        const key = p.date + '_' + p.shift + '_' + p.machine, o = all[key];
        if (!o) { p.source = src; all[key] = p; return; }
        // two plan tabs on the same machine and shift: the work is added up
        o.qty += p.qty; o.hours = Math.round((o.hours + p.hours) * 100) / 100; o.detail = o.detail.concat(p.detail).slice(0, 40); o.source += ' + ' + ad.tab;
        o.actualQty = o.actualQty == null && p.actualQty == null ? null : (o.actualQty || 0) + (p.actualQty || 0);
        o.actualHours = o.actualHours == null && p.actualHours == null ? null : Math.round(((o.actualHours || 0) + (p.actualHours || 0)) * 100) / 100;
      });
      done.push(ad.id + ' (' + plans.length + ')');
    } catch (e) { failed.push(ad.id + ': ' + e.message); }
  });

  if (books.capacity) {
    try {
      const ss = open('capacity'); let n = 0; const miss = new Set();
      for (let d = from; d <= to; d = addDays(d, 1)) {
        let sh = null;
        capTabNames(d).some(function (name) { sh = ss.getSheetByName(name); return !!sh; });
        if (!sh) continue;
        const res = capacityPlans(d, sh.getRange('A3:R90').getDisplayValues());
        res.skipped.forEach(function (x) { miss.add(x); });
        res.plans.forEach(function (p) { const key = p.date + '_' + p.shift + '_' + p.machine; if (!all[key]) { p.source = 'Capacity VTR · ' + d; all[key] = p; n++; } });
      }
      done.push('capacity (' + n + ')');
      if (miss.size) unmatched.push('capacity: ' + Array.from(miss).slice(0, 12).join(', '));
    } catch (e) { failed.push('capacity: ' + e.message); }
  }

  const now = new Date().toISOString();
  const writes = Object.keys(all).map(function (key) {
    const p = all[key]; p.at = now; p.by = 'workbook script';
    return { update: { name: docName('plans/' + key), fields: fsFields(p) } };
  });
  for (let i = 0; i < writes.length; i += 400) fsCommit(writes.slice(i, i + 400));
  const hour = Number(Utilities.formatDate(new Date(), TIMEZONE, 'H'));
  fsCommit([{ update: { name: docName('sync/state'), fields: fsFields({
    slot: hour >= 17 ? today + ' 17:00' : today + ' 08:00', at: now, by: 'workbook script',
    done: done, failed: failed, unmatched: unmatched.slice(0, 30), saved: writes.length }) } }]);
  Logger.log('Saved %s plans. Done: %s. Failed: %s', writes.length, done.join(', '), failed.join('; '));
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
