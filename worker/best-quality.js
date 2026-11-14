/**
 * Cloudflare Worker: «найвища якість» для будь-якого HLS-потоку.
 *
 *   GET https://<ваш-воркер>.workers.dev/best?u=<URL-енкоджене посилання на m3u8>
 *
 * Воркер завантажує master-плейлист (з усіма редиректами і свіжими токенами),
 * лишає в ньому тільки найкращу якість (+ її звук), робить усі шляхи абсолютними
 * і віддає плеєру. Відео плеєр качає напряму з сервісу — через воркер іде тільки
 * короткий текстовий плейлист, тож безкоштовного ліміту (100 000 запитів/добу) вистачає.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Дозволені домени джерел (щоб воркер не став відкритим проксі для будь-чого)
const ALLOWED = [
  "jmp2.uk", "pluto.tv", "akamaized.net", "roku.com", "plex.tv",
  "tubi.io", "adrise.io", "samsung.com", "amagi.tv", "wurl.com", "wurl.tv",
];

function allowed(url) {
  try {
    const h = new URL(url).hostname;
    return ALLOWED.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

function parseAttrs(line) {
  const out = {};
  const s = line.slice(line.indexOf(":") + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function absolutize(text, base) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${new URL(u, base).href}"`);
      }
      return new URL(line.trim(), base).href;
    })
    .join("\n");
}

export function bestQuality(text, base) {
  const lines = absolutize(text, base).split("\n");
  const header = [];
  const media = [];
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      let j = i + 1;
      while (j < lines.length && (lines[j] === "" || lines[j].startsWith("#"))) j++;
      if (j < lines.length) variants.push({ inf: l, uri: lines[j] });
      i = j;
    } else if (l.startsWith("#EXT-X-MEDIA:")) {
      media.push(l);
    } else if (/^#(EXTM3U|EXT-X-VERSION|EXT-X-INDEPENDENT-SEGMENTS)/.test(l)) {
      header.push(l);
    }
  }

  if (!variants.length) return null; // це вже не master-плейлист

  const score = (v) => {
    const a = parseAttrs(v.inf);
    const h = parseInt((a.RESOLUTION || "0x0").split("x")[1] || "0", 10);
    return [h, parseFloat(a["FRAME-RATE"] || "0"), parseInt(a.BANDWIDTH || "0", 10)];
  };
  variants.sort((x, y) => {
    const a = score(x), b = score(y);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  const best = variants[0];
  const attrs = parseAttrs(best.inf);

  // Лишаємо звук обраної якості і вбудовані CC; окремі субтитри прибираємо
  // (вбудований плеєр LG webOS погано їх підтримує, а живому ефіру вони не потрібні).
  const keep = media.filter((m) => {
    const a = parseAttrs(m);
    if (a.TYPE === "AUDIO") return a["GROUP-ID"] === attrs.AUDIO;
    if (a.TYPE === "CLOSED-CAPTIONS") return a["GROUP-ID"] === attrs["CLOSED-CAPTIONS"];
    return false;
  });
  const inf = best.inf.replace(/,SUBTITLES="[^"]*"/, "");

  return [...(header.length ? header : ["#EXTM3U"]), ...keep, inf, best.uri].join("\n") + "\n";
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("OK. Використання: /best?u=<посилання на m3u8>\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname !== "/best") return new Response("Not found\n", { status: 404 });

    const src = url.searchParams.get("u");
    if (!src || !allowed(src)) return new Response("Bad or not allowed URL\n", { status: 400 });

    let resp;
    try {
      resp = await fetch(src, { headers: { "User-Agent": UA }, redirect: "follow" });
    } catch (e) {
      return Response.redirect(src, 302); // джерело недоступне з воркера — нехай плеєр пробує сам
    }
    if (!resp.ok) return Response.redirect(src, 302);

    const finalUrl = resp.url || src;
    const text = await resp.text();
    const out = text.includes("#EXT-X-STREAM-INF") ? bestQuality(text, finalUrl) : null;

    if (!out) {
      // Не master-плейлист: віддаємо як є, але з абсолютними шляхами
      return new Response(absolutize(text, finalUrl), {
        headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
      });
    }
    return new Response(out, {
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  },
};
