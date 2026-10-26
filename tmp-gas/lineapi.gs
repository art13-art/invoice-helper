// LINE 助理用的帳本 API（獨立專案，部署成網頁應用程式）。
// ・只接受帶正確 API_KEY 的請求（金鑰存在「專案設定 → 指令碼屬性」）。
// ・新增與作廢走記帳 APP 原本的程式（程式庫 Ledger），規則、類別、異動紀錄都一樣。
// ・每 5 分鐘呼叫一次網站，讓助理送出到期提醒和每日早報。
const SHEET_ID = '1alo3uxH5jxhAeZoDxIK34NRvMlkHvis_Vq9T33YI4Ac';
const SITE = 'https://invoice-helper-eok.pages.dev';
const TZ = 'Asia/Taipei';

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || typeof req.key !== 'string' || req.key !== key) return json_({ ok: false, error: 'unauthorized' });
    var fn = API_[req.fn];
    if (!fn) return json_({ ok: false, error: 'unknown function' });
    out = { ok: true, result: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return json_(out);
}
function doGet() { return ContentService.createTextOutput('ok'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

const API_ = {
  addEntry: addEntry_, voidEntry: voidEntry_, findEntries: findEntries_, monthSummary: monthSummary_,
  categories: function () { return Ledger.getCategoryManager().categories; },
  subscriptions: subscriptions_, upcomingSubscriptions: upcomingSubscriptions_, pendingCounts: pendingCounts_,
};

/* ---------- 讀總帳 ---------- */
function ledger_() { return SpreadsheetApp.openById(SHEET_ID).getSheetByName('總帳'); }
function rows_() {
  var s = ledger_(), n = s.getLastRow();
  return n < 2 ? [] : s.getRange(2, 1, n - 1, 19).getValues();
}
function day_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '').slice(0, 10).replace(/\//g, '-'); }
function view_(r) {
  return { id: String(r[0]), date: day_(r[1]), entity: r[3], flow: r[4], amount: Number(r[5]) || 0, category: r[6],
    payment: r[8], account: r[9], notes: r[10], text: r[11], status: r[12], reason: r[13] };
}
function entities_() { return ['個人', '都是藝術', '玖陸好運', '福田森林']; }

function findEntries_(q) {
  q = q || {};
  var kw = String(q.keyword || '').toLowerCase(), limit = Math.min(Number(q.limit) || 15, 50), out = [];
  var all = rows_();
  for (var i = all.length - 1; i >= 0 && out.length < limit; i--) {
    var r = all[i];
    if (!r[0]) continue;
    var v = view_(r);
    if (v.status === '已作廢') continue;
    if (q.entity && v.entity !== q.entity) continue;
    if (q.flow && v.flow !== q.flow) continue;
    if (q.category && v.category !== q.category) continue;
    if (q.status && v.status !== q.status) continue;
    if (q.from && v.date < q.from) continue;
    if (q.to && v.date > q.to) continue;
    if (kw && [v.text, v.notes, v.category, v.account].join(' ').toLowerCase().indexOf(kw) < 0) continue;
    out.push(v);
  }
  return { count: out.length, entries: out };
}

function monthSummary_(q) {
  var month = String(q && q.month || Utilities.formatDate(new Date(), TZ, 'yyyy-MM'));
  var by = {}, cats = {}, pending = 0, n = 0;
  rows_().forEach(function (r) {
    if (!r[0]) return;
    var v = view_(r);
    if (v.status === '已作廢' || v.date.slice(0, 7) !== month) return;
    if (q && q.entity && v.entity !== q.entity) return;
    n++;
    if (v.status === '待確認') pending++;
    by[v.entity] = by[v.entity] || { 收入: 0, 支出: 0 };
    by[v.entity][v.flow] = (by[v.entity][v.flow] || 0) + v.amount;
    if (v.flow === '支出') cats[v.category] = (cats[v.category] || 0) + v.amount;
  });
  var top = Object.keys(cats).map(function (k) { return { category: k, amount: cats[k] }; })
    .sort(function (a, b) { return b.amount - a.amount; }).slice(0, 8);
  return { month: month, entries: n, pending: pending, byEntity: by, topExpenseCategories: top };
}

function pendingCounts_() {
  var c = {};
  rows_().forEach(function (r) { if (r[0] && r[12] === '待確認') c[r[3]] = (c[r[3]] || 0) + 1; });
  return c;
}

/* ---------- 訂閱 ---------- */
function subscriptions_(entity) {
  var list = entity ? [entity] : entities_(), out = [];
  list.forEach(function (e) {
    var r = Ledger.getSubscriptions(e);
    (r.items || []).forEach(function (x) {
      out.push({ entity: e, name: x.name, amount: x.amount, day: x.day, payment: x.payment, account: x.account, active: x.active });
    });
  });
  return out;
}
function upcomingSubscriptions_(days) {
  days = Number(days) || 3;
  var today = new Date(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + 'T00:00:00+08:00'), out = [];
  subscriptions_().forEach(function (s) {
    if (!s.active) return;
    for (var i = 0; i <= days; i++) {
      var d = new Date(today.getTime() + i * 864e5);
      var y = Number(Utilities.formatDate(d, TZ, 'yyyy')), m = Number(Utilities.formatDate(d, TZ, 'M')), dd = Number(Utilities.formatDate(d, TZ, 'd'));
      var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (Math.min(Number(s.day), last) === dd) { out.push({ date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), name: s.name, amount: s.amount, entity: s.entity }); break; }
    }
  });
  return out;
}

/* ---------- 寫入（使用者在 LINE 按確認後才會呼叫） ---------- */
function addEntry_(e) {
  e = e || {};
  var r = Ledger.saveEntry(String(e.entity), String(e.flow), String(e.amount), String(e.text || ''), String(e.category || ''),
    String(e.notes || ''), String(e.payment || ''), String(e.account || ''));
  if (!r || !r.ok) return r || { ok: false, message: '記帳失敗' };
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), date = null;
  if (e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date < today) {
    // 補記過去的帳：把剛寫入那一列的日期改成交易日（只動這一列的日期與時間欄）
    var s = ledger_(), cell = s.getRange(2, 1, s.getLastRow() - 1, 1).createTextFinder(r.entryId).matchEntireCell(true).findNext();
    if (cell) {
      var d = new Date(e.date + 'T12:00:00+08:00');
      s.getRange(cell.getRow(), 2, 1, 2).setValues([[d, d]]);
      date = e.date;
    }
  }
  return { ok: true, id: r.entryId, entity: r.entity, flow: r.flow, amount: r.amount, category: r.category,
    status: r.status, confirmReason: r.confirmReason, date: date };
}

function voidEntry_(id) {
  id = String(id || '');
  var hit = rows_().filter(function (r) { return String(r[0]) === id; })[0];
  if (!hit) return { ok: false, message: '找不到這筆帳' };
  var entity = hit[3], cursor = null;
  for (var page = 0; page < 15; page++) {
    var res = Ledger.getRecentEntries(entity, cursor);
    var found = (res.entries || []).filter(function (x) { return x.id === id; })[0];
    if (found) {
      if (found.voided) return { ok: false, message: '這筆已經作廢了' };
      return Ledger.changeEntry({ id: id, version: found.version, action: '作廢', requestId: 'H-' + Utilities.getUuid() });
    }
    if (!res.hasMore) break;
    cursor = res.nextCursor;
  }
  return { ok: false, message: '這筆帳太舊，請在記帳 APP 裡作廢' };
}

/* ---------- 定時與設定 ---------- */
function tick() {
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key) return;
  UrlFetchApp.fetch(SITE + '/api/line/tick', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ key: key }), muteHttpExceptions: true });
}

/* 第一次使用時執行一次：建立金鑰、每 5 分鐘的觸發條件。 */
function setupLineAssistant() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('API_KEY')) p.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tick'; }))
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  // 讀一次帳本，確認權限與程式庫都正常（不寫入）
  Logger.log('設定完成。帳本共有 ' + rows_().length + ' 列，類別 ' + Ledger.getCategoryManager().categories.length + ' 個。');
  Logger.log('金鑰已建立：請到「專案設定 → 指令碼屬性」複製 API_KEY 的值。');
}
