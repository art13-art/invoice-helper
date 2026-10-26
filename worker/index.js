// LINE 小幫手的「排隊處理」服務：從 Cloudflare Queues 拿到 LINE 傳來的訊息，
// 原封不動（含 LINE 簽章）送回主站處理，並一直等到處理完（最多 15 分鐘），讓小幫手可以想久一點。
// 這裡不放任何金鑰：主站會用 LINE 簽章確認訊息是真的。
export default {
  async queue(batch, env) {
    const site = env.SITE || "https://invoice-helper-eok.pages.dev";
    for (const m of batch.messages) {
      try {
        const r = await fetch(site + "/api/line/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "x-line-signature": m.body.sig || "", "x-from-queue": "1" },
          body: m.body.body,
        });
        if (r.status >= 500) m.retry({ delaySeconds: 5 }); else m.ack();
      } catch (e) {
        console.log("forward failed", e.message);
        m.retry({ delaySeconds: 5 });
      }
    }
  },
  async fetch() { return new Response("line-jobs worker ok"); },
};
