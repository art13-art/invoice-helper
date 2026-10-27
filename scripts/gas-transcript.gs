// LINE 小助理（Apps Script）— 會議逐字稿、報告、紀錄表
// 貼到 Apps Script 專案「LINE 小助理」的「逐字稿」檔案（整段取代原本內容）；原本的「程式碼」不用動。
// 存檔後執行一次 authorizeDocs，再「部署 → 管理部署作業 → 編輯 → 版本：新版本 → 部署」。

// 把這裡的功能登記到「程式碼」裡的 API_（這個檔案要排在「程式碼」後面）
try {
  API_.saveTranscript = saveTranscript_;
  API_.saveDoc = saveDoc_;
  API_.createLog = createLog_;
  API_.readFile = readFile_;
} catch (e) { Logger.log('請把這個檔案拖到「程式碼」下面'); }

function subFolder_(name) {
  var parent = folder_(), it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* 逐字稿存成 Google 文件，放在「LINE 小助理｜廠商帳 / 會議逐字稿」資料夾 */
function saveTranscript_(title, text) {
  var doc = DocumentApp.create(String(title || '會議逐字稿').slice(0, 120));
  doc.getBody().setText(String(text || '').slice(0, 900000));
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(subFolder_('會議逐字稿'));
  return { id: doc.getId(), url: doc.getUrl(), name: doc.getName() };
}

/* 報告存成有格式的 Google 文件：「# 」大標、「## 」小標、「- 」條列、「| 欄 | 欄 |」表格 */
function saveDoc_(title, text, folderName) {
  var doc = DocumentApp.create(String(title || '報告').slice(0, 120)), body = doc.getBody();
  var lines = String(text || '').slice(0, 900000).split('\n'), i = 0;
  var isRow = function (l) { return /^\s*\|.*\|\s*$/.test(l); };
  while (i < lines.length) {
    var l = lines[i];
    if (isRow(l)) {
      var rows = [];
      while (i < lines.length && isRow(lines[i])) {
        var cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
        if (!cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) rows.push(cells);
        i++;
      }
      if (rows.length) {
        var w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
        rows = rows.map(function (r) { while (r.length < w) r.push(''); return r; });
        var t = body.appendTable(rows);
        t.getRow(0).editAsText().setBold(true);
        for (var c = 0; c < w; c++) t.getRow(0).getCell(c).setBackgroundColor('#EEF2F1');
      }
      continue;
    }
    var clean = function (s) { return s.replace(/\*\*(.+?)\*\*/g, '$1'); };
    if (/^# /.test(l)) body.appendParagraph(clean(l.slice(2))).setHeading(DocumentApp.ParagraphHeading.HEADING1);
    else if (/^## /.test(l)) body.appendParagraph(clean(l.slice(3))).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    else if (/^### /.test(l)) body.appendParagraph(clean(l.slice(4))).setHeading(DocumentApp.ParagraphHeading.HEADING3);
    else if (/^\s*[-・*] /.test(l)) body.appendListItem(clean(l.replace(/^\s*[-・*] /, ''))).setGlyphType(DocumentApp.GlyphType.BULLET);
    else if (/^\s*\d+[.、] /.test(l)) body.appendListItem(clean(l.replace(/^\s*\d+[.、] /, ''))).setGlyphType(DocumentApp.GlyphType.NUMBER);
    else body.appendParagraph(clean(l));
    i++;
  }
  // 新文件開頭會有一段空白，刪掉
  if (body.getNumChildren() > 1 && body.getChild(0).getType() === DocumentApp.ElementType.PARAGRAPH && body.getChild(0).asParagraph().getText() === '') body.removeChild(body.getChild(0));
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(subFolder_(String(folderName || '報告')));
  return { id: doc.getId(), url: doc.getUrl(), name: doc.getName() };
}

/* 建一張紀錄表（例如 A/B 測試紀錄），放在「LINE 小助理｜廠商帳」資料夾 */
function createLog_(title, headers) {
  var h = (headers && headers.length) ? headers : ['日期', '項目', '內容', '結果', '備註', '記錄人', '原始訊息', '記錄時間'];
  var ss = SpreadsheetApp.create('紀錄表｜' + String(title || '群組').slice(0, 80)), s = ss.getSheets()[0];
  s.setName('紀錄');
  s.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#EEF2F1').setFontColor('#12524F');
  s.setFrozenRows(1);
  s.setColumnWidths(1, h.length, 140);
  s.getRange('A2:A').setNumberFormat('yyyy/MM/dd');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  return info_(ss, s);
}

/* 讀 Google 雲端的檔案（文件、試算表、簡報、上傳的 Word／Excel／PDF…）。
   onlyShared＝true 時只讀「知道連結的人都能檢視」的檔案（非管理員叫小幫手讀時） */
function readFile_(idOrUrl, onlyShared) {
  var m = String(idOrUrl || '').match(/[-\w]{25,}/);
  if (!m) throw new Error('連結格式不對');
  var f;
  try { f = DriveApp.getFileById(m[0]); } catch (e) { throw new Error('NO_ACCESS'); }
  if (onlyShared) {
    var a = f.getSharingAccess();
    if (a !== DriveApp.Access.ANYONE && a !== DriveApp.Access.ANYONE_WITH_LINK) throw new Error('NOT_SHARED');
  }
  var mt = f.getMimeType(), name = f.getName();
  if (mt === MimeType.GOOGLE_DOCS) return { name: name, kind: 'text', text: DocumentApp.openById(f.getId()).getBody().getText().slice(0, 200000) };
  if (mt === MimeType.GOOGLE_SHEETS) {
    var ss = SpreadsheetApp.openById(f.getId());
    return { name: name, kind: 'sheets', sheets: ss.getSheets().slice(0, 10).map(function (s) {
      var r = Math.min(s.getLastRow(), 5000), c = Math.min(s.getLastColumn(), 60);
      return { name: s.getName(), rows: r && c ? s.getRange(1, 1, r, c).getDisplayValues() : [] };
    }) };
  }
  var blob = (mt === MimeType.GOOGLE_SLIDES || mt === MimeType.GOOGLE_DRAWINGS) ? f.getAs('application/pdf') : f.getBlob();
  var bytes = blob.getBytes();
  if (bytes.length > 15 * 1024 * 1024) throw new Error('TOO_BIG');
  var fname = (mt === MimeType.GOOGLE_SLIDES || mt === MimeType.GOOGLE_DRAWINGS) ? name + '.pdf' : name;
  return { name: fname, kind: 'blob', mime: blob.getContentType(), data: Utilities.base64Encode(bytes) };
}

/* 第一次貼上後執行一次，讓 Google 要求「建立文件」的權限 */
function authorizeDocs() {
  var d = DocumentApp.create('權限測試（可刪）');
  DriveApp.getFileById(d.getId()).setTrashed(true);
  Logger.log('好了，Google 文件權限已開通。');
}
