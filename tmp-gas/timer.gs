// LINE 群組小助理的定時器：每 5 分鐘叫醒助理一次，讓它送出到期的提醒和每日早報。
// 這個專案不讀寫任何試算表、雲端硬碟或個人資料，只會連到下面這個網址。
const TICK_URL = 'https://invoice-helper-eok.pages.dev/api/line/tick';

function tick() {
  UrlFetchApp.fetch(TICK_URL, { method: 'post', contentType: 'application/json', payload: '{}', muteHttpExceptions: true });
}

/* 第一次使用時執行一次：建立每 5 分鐘的觸發條件。 */
function setup() {
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tick'; }))
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  tick();
  Logger.log('完成：之後每 5 分鐘會叫醒 LINE 小助理一次。');
}
