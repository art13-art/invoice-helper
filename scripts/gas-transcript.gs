// LINE 小助理（Apps Script）— 會議逐字稿備份
// 貼到 Apps Script 專案「LINE 小助理」裡，新增一個檔案（例如「逐字稿」），內容就是這整段。
// 另外把「程式碼」檔案裡的 API_ 那一行，在最後的 setCell: setCell_ 後面加上：, saveTranscript: saveTranscript_
// 存檔後執行一次 authorizeDocs（會要求 Google 文件權限），再「部署 → 管理部署作業 → 編輯 → 版本：新版本 → 部署」。

/* 逐字稿存成 Google 文件，放在「LINE 小助理｜廠商帳 / 會議逐字稿」資料夾 */
function saveTranscript_(title, text) {
  var parent = folder_(), it = parent.getFoldersByName('會議逐字稿');
  var sub = it.hasNext() ? it.next() : parent.createFolder('會議逐字稿');
  var doc = DocumentApp.create(String(title || '會議逐字稿').slice(0, 120));
  doc.getBody().setText(String(text || '').slice(0, 900000));
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(sub);
  return { id: doc.getId(), url: doc.getUrl(), name: doc.getName() };
}

/* 第一次貼上後執行一次，讓 Google 要求「建立文件」的權限 */
function authorizeDocs() {
  var d = DocumentApp.create('權限測試（可刪）');
  DriveApp.getFileById(d.getId()).setTrashed(true);
  Logger.log('好了，Google 文件權限已開通。');
}
