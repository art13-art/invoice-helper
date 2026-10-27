// 備份：Apps Script 專案「LINE 小助理」的「程式碼」檔案（主程式：每分鐘叫醒小幫手、讀寫試算表的 API）。整段貼回「程式碼」檔案即可還原。
// LINE 小助理（Apps Script 部分）
// 1. 每 1 分鐘叫醒助理一次，讓它送出到期的提醒和每日早報。
// 2. 幫「廠商群組」把帳寫進雲端試算表：只會讀寫放在「LINE 小助理｜廠商帳」資料夾裡的試算表，
//    其他檔案一律拒絕。請求要帶正確的 API_KEY（存在「專案設定 → 指令碼屬性」）。
const SITE = 'https://invoice-helper-eok.pages.dev';
const FOLDER_NAME = 'LINE 小助理｜廠商帳';
const DEFAULT_HEADERS = ['日期', '品項', '數量', '單價', '金額', '收入/支出', '付款方式', '發票號碼', '統一編號', '備註', '記錄人', '原始訊息', '記錄時間'];
const TZ = 'Asia/Taipei';
// 不在資料夾裡、但允許小幫手讀寫的試算表（訂單流程用）。要新增請直接加在這裡。
const EXTRA_SHEETS = [
  '1Cphr4wTb5UIjOSBH-9fceCdrWEYDQEhkQm8-lEdAHr0',  // 測試用客服表單
  '1VP7Z3VOws7_QgIIY8s6Kj59kVzWomehRdxTO8Q67hSM',  // 精油廠商測試用表單
];

/* ---------- 定時 ---------- */
function tick() {
  UrlFetchApp.fetch(SITE + '/api/line/tick', { method: 'post', contentType: 'application/json', payload: '{}', muteHttpExceptions: true });
}

/* 第一次使用時執行一次：建立金鑰、資料夾和每 1 分鐘的觸發條件。 */
function setup() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('API_KEY')) p.setProperty('API_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  folder_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  tick();
  Logger.log('完成：已建立「' + FOLDER_NAME + '」資料夾，之後每 1 分鐘會叫醒 LINE 小助理一次。');
  Logger.log('API_KEY 在「專案設定 → 指令碼屬性」，請複製到 Cloudflare 的 GAS_KEY。');
}

/* 部署成網頁應用程式後執行一次：把網址和金鑰登記到 LINE 小助理（不用手動複製金鑰） */
function register() {
  var url = 'https://script.google.com/macros/s/AKfycby7JRwzst6QYEPHvmbMed4ONlSic_QwqnrFiywy32YdJWJNjrQGpIr9BJvYDVaJkUZs4g/exec';  // 網頁應用程式網址
  if (!url || !/\/exec$/.test(url)) throw new Error('請先「部署 → 新增部署作業 → 網頁應用程式」，再執行 register');
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  var r = UrlFetchApp.fetch(SITE + '/api/line/gas-register', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ url: url, key: key }), muteHttpExceptions: true });
  Logger.log(r.getResponseCode() + ' ' + r.getContentText());
}

/* ---------- API ---------- */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || typeof req.key !== 'string' || req.key !== key) return json_({ ok: false, error: 'unauthorized' });
    var fn = API_[req.fn];
    if (!fn) return json_({ ok: false, error: 'unknown function' });
    out = { ok: true, result: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return json_(out);
}
function doGet() { return ContentService.createTextOutput('ok'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

const API_ = { ping: function () { return { pong: true }; }, createBook: createBook_, linkBook: linkBook_, appendRows: appendRows_, readRows: readRows_, appendReport: appendReport_, setCell: setCell_ };

function folder_() {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('FOLDER_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var it = DriveApp.getFoldersByName(FOLDER_NAME), folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  p.setProperty('FOLDER_ID', folder.getId());
  return folder;
}
/* 只允許資料夾裡的試算表 */
function open_(id) {
  id = String(id || '').replace(/^.*\/d\/([\w-]{20,}).*$/, '$1');
  if (!/^[\w-]{20,}$/.test(id)) throw new Error('試算表連結格式不對');
  if (EXTRA_SHEETS.indexOf(id) >= 0) return SpreadsheetApp.openById(id);
  var file = DriveApp.getFileById(id), folderId = folder_().getId(), inside = false, parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) inside = true;
  if (!inside) throw new Error('這個試算表不在「' + FOLDER_NAME + '」資料夾裡，請先把它移進資料夾');
  if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) throw new Error('這不是 Google 試算表');
  return SpreadsheetApp.openById(id);
}
function sheet_(ss, tab) {
  var s = tab ? ss.getSheetByName(tab) : null;
  return s || ss.getSheets()[0];
}
function headers_(s) {
  var n = Math.max(s.getLastColumn(), 1);
  return s.getRange(1, 1, 1, n).getDisplayValues()[0].map(function (h) { return String(h).trim(); });
}
function info_(ss, s) {
  return { id: ss.getId(), url: ss.getUrl(), name: ss.getName(), tab: s.getName(), headers: headers_(s).filter(String) };
}

function createBook_(title) {
  title = String(title || '廠商帳').slice(0, 80);
  var ss = SpreadsheetApp.create('廠商帳｜' + title), s = ss.getSheets()[0];
  s.setName('記帳');
  s.getRange(1, 1, 1, DEFAULT_HEADERS.length).setValues([DEFAULT_HEADERS]).setFontWeight('bold').setBackground('#EEF2F8').setFontColor('#22406E');
  s.setFrozenRows(1);
  s.setColumnWidths(1, DEFAULT_HEADERS.length, 110); s.setColumnWidth(2, 200); s.setColumnWidth(10, 200); s.setColumnWidth(12, 260);
  s.getRange('A2:A').setNumberFormat('yyyy/MM/dd'); s.getRange('C2:E').setNumberFormat('#,##0.##'); s.getRange('M2:M').setNumberFormat('yyyy/MM/dd HH:mm');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  return info_(ss, s);
}

function linkBook_(idOrUrl, tab) {
  var ss = open_(idOrUrl), s = sheet_(ss, tab), h = headers_(s).filter(String);
  if (!h.length) throw new Error('第一列要是欄位名稱（例如：日期、品項、金額）');
  return info_(ss, s);
}

/* rows：[{ 欄位名稱: 值 }]；meta：{ who, raw }。找不到的欄位會放進「備註」或略過。 */
function appendRows_(id, tab, rows, meta) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var ss = open_(id), s = sheet_(ss, tab), h = headers_(s), now = new Date();
    meta = meta || {};
    var out = (rows || []).slice(0, 30).map(function (r) {
      var line = h.map(function () { return ''; }), extra = [];
      Object.keys(r || {}).forEach(function (k) {
        var i = h.indexOf(k), v = r[k];
        if (typeof v === 'string' && /^[=+\-@]/.test(v) && !/^-?[\d,.]+$/.test(v)) v = "'" + v;   // 防止被當成公式
        if (i >= 0) line[i] = cell_(k, v); else if (v !== '' && v != null) extra.push(k + '：' + v);
      });
      var set = function (names, v) { for (var j = 0; j < names.length; j++) { var i = h.indexOf(names[j]); if (i >= 0 && line[i] === '') { line[i] = v; return true; } } return false; };
      set(['記錄人', '經手人', '填寫人'], meta.who || '');
      set(['原始訊息', '原始輸入'], String(meta.raw || '').slice(0, 500));
      set(['記錄時間', '建立時間'], now);
      if (extra.length && !set(['備註'], extra.join('；'))) { var i = h.indexOf('備註'); if (i >= 0) line[i] += '；' + extra.join('；'); }
      return line;
    });
    if (!out.length) return { added: 0 };
    var start = s.getLastRow() + 1;
    s.getRange(start, 1, out.length, h.length).setValues(out);
    return { added: out.length, firstRow: start, url: ss.getUrl() + '#gid=' + s.getSheetId() + '&range=A' + start };
  } finally { lock.releaseLock(); }
}
function cell_(name, v) {
  if (v == null) return '';
  if (/日期/.test(name) && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return new Date(v + 'T00:00:00+08:00');
  if (/(金額|單價|數量|稅額|小計|合計|總計)/.test(name) && /^-?[\d,]+(\.\d+)?$/.test(String(v))) return Number(String(v).replace(/,/g, ''));
  return v;
}

function readRows_(id, tab, q) {
  q = q || {};
  var ss = open_(id), s = sheet_(ss, tab), h = headers_(s), n = s.getLastRow();
  if (n < 2) return { headers: h, rows: [], total: 0 };
  var values = s.getRange(2, 1, n - 1, h.length).getValues(), kw = String(q.keyword || '').toLowerCase(), out = [];
  var di = h.findIndex(function (x) { return /日期/.test(x); });
  for (var r = values.length - 1; r >= 0 && out.length < Math.min(Number(q.limit) || 30, 200); r--) {
    var row = values[r]; if (!row.some(function (v) { return v !== ''; })) continue;
    var obj = {}; h.forEach(function (k, i) { if (k) obj[k] = row[i] instanceof Date ? Utilities.formatDate(row[i], TZ, i === di ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm') : row[i]; });
    var d = di >= 0 ? obj[h[di]] : '';
    if (q.from && d && d < q.from) continue;
    if (q.to && d && d > q.to) continue;
    if (kw && JSON.stringify(obj).toLowerCase().indexOf(kw) < 0) continue;
    obj._row = r + 2; out.push(obj);
  }
  return { headers: h, rows: out, total: values.length };
}

/* 在某一列的某個欄位寫入文字（欄位不存在就在最右邊新增） */
function setCell_(id, tab, row, header, value) {
  var ss = open_(id), s = sheet_(ss, tab), h = headers_(s), c = h.indexOf(header);
  row = Number(row); if (!(row >= 2)) throw new Error('列號不對');
  if (c < 0) { c = h.filter(String).length ? h.length : 0; s.getRange(1, c + 1).setValue(header).setFontWeight('bold'); }
  s.getRange(row, c + 1).setValue(String(value).slice(0, 200));
  return { ok: true };
}

/* 每月開銷報表：寫進資料夾裡的「LINE 小助理｜月報」（沒有就建立） */
function appendReport_(r) {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('REPORT_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('LINE 小助理｜月報');
    DriveApp.getFileById(ss.getId()).moveTo(folder_());
    var h = ['月份', 'AI 費用（美元）', 'AI 費用（約台幣）', '預算（美元）', 'AI 回覆次數', '輸入 token', '輸出 token', 'LINE 主動訊息', 'LINE 額度約計', '用量最多的聊天室', '產生時間'];
    var s0 = ss.getSheets()[0]; s0.setName('月報');
    s0.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#EEF2F8').setFontColor('#22406E');
    s0.setFrozenRows(1); s0.setColumnWidth(10, 360);
    p.setProperty('REPORT_ID', ss.getId());
  }
  var s = ss.getSheets()[0];
  var top = (r.byChat || []).slice(0, 5).map(function (c) { return c.name + ' ' + c.calls + '次 US$' + c.usd; }).join('；');
  s.appendRow(["'" + r.month, r.usd, r.twd, r.budget, r.calls, r.inputTokens, r.outputTokens, r.pushes, r.pushRecipients, top, new Date()]);
  return { url: ss.getUrl() };
}
