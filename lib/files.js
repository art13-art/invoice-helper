// 把 LINE 上的照片和檔案轉成 Claude 看得懂的內容：照片 → image、PDF → document、Excel/Word/PowerPoint/CSV/文字 → 純文字。
// Excel/Word 是 zip 包 XML，這裡用內建的 DecompressionStream 自己解，不需要額外套件。

const MAX_TEXT = 60000;

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---------- zip ---------- */
async function inflate(data) {
  const ds = new DecompressionStream("deflate-raw");
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
export async function unzip(bytes, want = () => true) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("不是有效的 zip 檔");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {}, dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (!want(name)) continue;
    const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
    const raw = bytes.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    files[name] = dec.decode(method === 0 ? raw : await inflate(raw));
  }
  return files;
}

const unxml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");

/* Excel：每個工作表轉成以 Tab 分隔的文字 */
async function xlsxText(bytes) {
  const f = await unzip(bytes, n => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(f["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const attr = (tag, k) => (tag.match(new RegExp("\\s" + k + '="([^"]*)"')) || [])[1];
  const names = [...(f["xl/workbook.xml"] || "").matchAll(/<sheet\s[^>]*>/g)].map(m => ({ name: unxml(attr(m[0], "name") || ""), rid: attr(m[0], "r:id") }));
  const rels = Object.fromEntries([...(f["xl/_rels/workbook.xml.rels"] || "").matchAll(/<Relationship\s[^>]*>/g)].map(m => [attr(m[0], "Id"), "xl/" + String(attr(m[0], "Target") || "").replace(/^\/?xl\//, "")]));
  const sheets = names.length ? names.map(s => ({ name: s.name, path: rels[s.rid] })) : Object.keys(f).filter(k => k.startsWith("xl/worksheets/")).map((path, i) => ({ name: "工作表" + (i + 1), path }));
  const col = ref => { let c = 0; for (const ch of ref.replace(/\d+/g, "")) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };
  let out = "";
  for (const s of sheets) {
    const xml = f[s.path]; if (!xml) continue;
    out += `\n## 工作表：${s.name}\n`;
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = (c[1].match(/r="([A-Z]+\d+)"/) || [])[1], t = (c[1].match(/t="(\w+)"/) || [])[1], body = c[2] || "";
        let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? "";
        if (t === "s") v = shared[+v] ?? "";
        else if (t === "inlineStr") v = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join("");
        v = unxml(String(v));
        if (ref) cells[col(ref)] = v; else cells.push(v);
      }
      if (cells.some(x => x)) out += Array.from(cells, x => x ?? "").join("\t") + "\n";
      if (out.length > MAX_TEXT) return out.slice(0, MAX_TEXT) + "\n…（太長，後面省略）";
    }
  }
  return out.trim();
}

/* Word：段落與表格轉純文字 */
async function docxText(bytes) {
  const f = await unzip(bytes, n => n === "word/document.xml");
  const xml = f["word/document.xml"] || "";
  return unxml(xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>\s*<\/w:tc>/g, "</w:tc>").replace(/<\/w:tr>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, "\t").replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
}
/* PowerPoint：每張投影片的文字 */
async function pptxText(bytes) {
  const f = await unzip(bytes, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  return Object.keys(f).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))
    .map((k, i) => `## 第 ${i + 1} 張\n` + unxml(f[k].replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).trim()).join("\n\n").slice(0, MAX_TEXT);
}

/* 依檔名／類型轉成 Claude 的內容區塊 */
export async function toBlocks(bytes, type, name = "") {
  const ext = (name.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || "";
  if (/^image\//.test(type) || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    if (bytes.length > 4.5 * 1024 * 1024) throw new Error("照片太大");
    const mt = /^image\/(jpeg|png|gif|webp)$/.test(type) ? type : ext === "png" ? "image/png" : "image/jpeg";
    return [{ type: "image", source: { type: "base64", media_type: mt, data: b64(bytes) } }];
  }
  if (type === "application/pdf" || ext === "pdf") {
    if (bytes.length > 20 * 1024 * 1024) throw new Error("PDF 太大（超過 20MB）");
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(bytes) }, title: name || "PDF" }];
  }
  let text;
  if (ext === "xlsx" || ext === "xlsm") text = await xlsxText(bytes);
  else if (ext === "docx") text = await docxText(bytes);
  else if (ext === "pptx") text = await pptxText(bytes);
  else if (["csv", "txt", "md", "json", "tsv"].includes(ext) || /^text\//.test(type)) text = new TextDecoder().decode(bytes).slice(0, MAX_TEXT);
  else if (["xls", "doc", "ppt"].includes(ext)) throw new Error(`舊版 .${ext} 格式讀不了，請另存成 .${ext}x 或 PDF 再傳`);
  else throw new Error(`.${ext || "這種"} 檔案目前讀不了（可以讀照片、PDF、Excel、Word、PowerPoint、CSV、文字檔）`);
  return [{ type: "text", text: `檔案「${name}」的內容：\n${text || "（沒有讀到文字）"}` }];
}
