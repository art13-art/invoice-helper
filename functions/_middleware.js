// 網站只用一個正式網址：www.taxtools.tw 和 invoice-helper-eok.pages.dev 的頁面一律轉到 https://taxtools.tw。
// /api/（LINE 小幫手、行事曆訂閱等程式呼叫）和 /tmp-gas/ 不轉址，照原網址運作。
const CANONICAL = "taxtools.tw";
export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  const host = url.hostname;
  const redirectHost = host === "www." + CANONICAL || host === "invoice-helper-eok.pages.dev";
  if (redirectHost && (request.method === "GET" || request.method === "HEAD") && !/^\/(api|tmp-gas)\//.test(url.pathname)) {
    url.hostname = CANONICAL; url.protocol = "https:"; url.port = "";
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
