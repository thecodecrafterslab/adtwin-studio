// Product page reader for AdTwin: pulls title, description, price and main photo from a URL.
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd])/i;
const UA = "Mozilla/5.0 (compatible; AdTwinBot/1.0; +https://thecodecrafterslab.github.io/adtwin-studio/)";

function meta(html: string, key: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || "";
}
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\s+/g, " ").trim();

function jsonLdProduct(html: string): Record<string, unknown> | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: unknown): Record<string, unknown> | null => {
        if (!n || typeof n !== "object") return null;
        if (Array.isArray(n)) { for (const x of n) { const r = walk(x); if (r) return r; } return null; }
        const o = n as Record<string, unknown>;
        const t = o["@type"]; if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return o;
        return walk(o["@graph"]);
      };
      const r = walk(JSON.parse(m[1])); if (r) return r;
    } catch { /* ignore bad JSON-LD */ }
  }
  return null;
}

async function grab(url: string, ms: number) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { headers: { "user-agent": UA, accept: "text/html,image/*,*/*" }, redirect: "follow", signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

export async function readProduct(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return { error: "That doesn't look like a web address." }; }
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) return { error: "Only public http(s) links can be read." };
  const r = await grab(u.href, 9000).catch(() => null);
  if (!r) return { error: "The page took too long to answer." };
  if (!r.ok) return { error: `The page answered with error ${r.status}. Some shops block automatic reading; fill the details in by hand.` };
  const html = (await r.text()).slice(0, 2_000_000);
  const ld = jsonLdProduct(html);
  const offers = (Array.isArray(ld?.offers) ? (ld?.offers as unknown[])[0] : ld?.offers) as Record<string, unknown> | undefined;
  const title = decode(String(ld?.name || meta(html, "og:title") || html.match(/<title[^>]*>([^<]*)/i)?.[1] || ""));
  const desc = decode(String(ld?.description || meta(html, "og:description") || meta(html, "description") || "")).slice(0, 600);
  const amount = String(offers?.price || meta(html, "product:price:amount") || meta(html, "og:price:amount") || "");
  const cur = String(offers?.priceCurrency || meta(html, "product:price:currency") || meta(html, "og:price:currency") || "");
  const brand = decode(String((ld?.brand as Record<string, unknown>)?.name || meta(html, "og:site_name") || u.hostname.replace(/^www\./, "")));
  const img = String((Array.isArray(ld?.image) ? (ld?.image as unknown[])[0] : (ld?.image as Record<string, unknown>)?.url || ld?.image) || meta(html, "og:image") || meta(html, "twitter:image") || "");
  let image = "";
  if (img) {
    try {
      const iu = new URL(img, u.href);
      if (/^https?:$/.test(iu.protocol) && !PRIVATE.test(iu.hostname)) {
        const ir = await grab(iu.href, 8000);
        const type = ir.headers.get("content-type") || "";
        const buf = Buffer.from(await ir.arrayBuffer());
        if (ir.ok && type.startsWith("image/") && buf.length < 4_000_000) image = `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
      }
    } catch { /* photo optional */ }
  }
  const price = amount ? `${cur === "USD" ? "US$" : cur === "FJD" ? "FJ$" : cur === "AUD" ? "A$" : cur ? cur + " " : "$"}${amount}` : "";
  return { title, description: desc, price, brand, image };
}
