// JARVIS: Cloudflare Worker (sayfa + Claude API aracı)
// Gerekli gizli değişkenler: ANTHROPIC_API_KEY, APP_PASSWORD

const MODEL = "claude-sonnet-5-5";
let iconCache = null;

// Uygulama simgesini kodla çizer (180x180 PNG)
async function makeIcon() {
  const N = 180, c = N / 2, W = N * 4 + 1, raw = new Uint8Array(W * N);
  const band = (r, r0, w) => Math.max(0, 1 - Math.abs(r - r0) / w);
  const inArc = (a, s, e) => { a = (a + 360) % 360; s = (s + 360) % 360; e = (e + 360) % 360; return s <= e ? a >= s && a <= e : a >= s || a <= e; };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - c + 0.5, dy = y - c + 0.5, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) * 180 / Math.PI;
      let cy = band(r, 78, 1.6) * 0.9;
      if (r > 68 && r < 76 && (a + 360) % 5 < 1.2) cy += 0.7;
      if (inArc(a, 20, 115) || inArc(a, 200, 295)) cy += band(r, 60, 3.2);
      cy += band(r, 34, 1) * 0.6;
      const am = inArc(a, -60, 40) ? band(r, 48, 2) : 0;
      const core = Math.exp(-r * r / 392), halo = Math.exp(-r * r / 4608) * 0.25;
      const i = y * W + 1 + x * 4;
      raw[i] = Math.min(255, 5 + cy * 79 + am * 255 + core * 190 + halo * 20);
      raw[i + 1] = Math.min(255, 10 + cy * 216 + am * 179 + core * 242 + halo * 90);
      raw[i + 2] = Math.min(255, 18 + cy * 255 + am * 71 + core * 255 + halo * 120);
      raw[i + 3] = 255;
    }
  }
  const T = [];
  for (let n = 0; n < 256; n++) { let k = n; for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; T[n] = k >>> 0; }
  const crc = b => { let k = ~0; for (const v of b) k = T[(k ^ v) & 255] ^ (k >>> 8); return ~k >>> 0; };
  const chunk = (type, d) => {
    const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer);
    v.setUint32(0, d.length);
    for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    o.set(d, 8);
    v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length)));
    return o;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, N); hv.setUint32(4, N); ihdr.set([8, 6, 0, 0, 0], 8);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const IMAGE_TOOL = {
  name: "generate_image",
  description: "Kullanıcı için görsel oluşturur. Ayrıntılı bir İngilizce görsel prompt'u ver: konu, stil, ışık, kompozisyon, renk paleti, atmosfer.",
  input_schema: { type: "object", properties: { prompt: { type: "string", description: "Ayrıntılı İngilizce görsel prompt" } }, required: ["prompt"] },
};

async function makeGemini(prompt, env, imageB64) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY tanımlı değil");
  const model = String(env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image").trim();
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "x-goog-api-key": String(env.GEMINI_API_KEY).trim(), "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: imageB64 ? [{ inlineData: { mimeType: "image/jpeg", data: imageB64 } }, { text: String(prompt).slice(0, 2000) }] : [{ text: String(prompt).slice(0, 2000) }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + String((d.error && d.error.message) || "").slice(0, 160));
  const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
  const p = parts.find(x => x.inlineData || x.inline_data);
  if (!p) throw new Error("Gemini görsel döndürmedi");
  const id = p.inlineData || p.inline_data;
  return "data:" + (id.mimeType || id.mime_type || "image/png") + ";base64," + id.data;
}

const EDIT_TOOL = {
  name: "edit_image",
  description: "Kullanıcının gönderdiği fotoğrafı DÜZENLER (bir şey ekle, çıkar, değiştir). Orijinal fotoğraf korunur. Sıfırdan yeni görsel için bunu değil generate_image kullan.",
  input_schema: { type: "object", properties: { instruction: { type: "string", description: "Net İngilizce düzenleme talimatı, ör. Add round black-framed glasses to the baby's face" } }, required: ["instruction"] },
};

function lastUserImage(convo) {
  for (let i = convo.length - 1; i >= 0; i--) {
    const m = convo[i];
    if (m.role === "user" && Array.isArray(m.content)) {
      const im = m.content.find(c => c.type === "image" && c.source && c.source.data);
      if (im) return im.source.data;
    }
  }
  return null;
}

function makeGeminiEdit(instruction, imageB64, env) {
  return makeGemini(String(instruction || "") + " Keep the original photo exactly as it is except for this requested change: same person, face, expression, pose, clothing, background, framing and lighting.", env, imageB64);
}

async function makeCfImage(prompt, env) {
  if (!env.AI) throw new Error("Workers AI bağlı değil");
  const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt: String(prompt).slice(0, 2000), steps: 4 });
  if (!out || !out.image) throw new Error("Workers AI görsel döndürmedi");
  return "data:image/jpeg;base64," + out.image;
}

async function makeImage(prompt, env, say) {
  say = say || (async () => {});
  let first = "";
  if (env.GEMINI_API_KEY) {
    await say("Gemini'ye gönderiliyor");
    try { return await makeGemini(prompt, env); }
    catch (e) { first = String(e && e.message); await say("Gemini yanıt vermedi (" + first.slice(0, 70) + "), Cloudflare görsel servisine geçiliyor"); }
  }
  await say("Cloudflare görsel üretiyor");
  try { return await makeCfImage(prompt, env); }
  catch (e) { throw new Error((first ? first + " | " : "") + "Workers AI: " + String(e && e.message)); }
}

function systemPrompt(tz, extra) {
  let zone = "UTC";
  try { new Intl.DateTimeFormat("tr-TR", { timeZone: tz }); zone = tz; } catch (e) {}
  const now = new Date().toLocaleString("tr-TR", { timeZone: zone, dateStyle: "full", timeStyle: "short" });
  return "Sen JARVIS adında, kullanıcının kişisel sesli asistanısın. Kullanıcının dilinde, kısa ve doğal konuş (en fazla 2-3 cümle). Markdown, liste, emoji ve bağlantı kullanma; cevapların sesli okunacak. " +
    "Şu an: " + now + " (saat dilimi: " + zone + "). Hava durumu, haber, fiyat gibi güncel bilgiler için web aramasını kullan. Hava durumunda şehir belirtilmemişse saat diliminden çıkarım yap ve hangi şehir için baktığını söyle. Görsel isteklerinde (çiz, görsel, resim gibi) ya da kullanıcı sadece tek bir nesne veya kavram kelimesi yazarsa (ör. ejderha, gün batımı) o fikirden ayrıntılı bir İngilizce görsel prompt'u yaz ve generate_image aracını çağır; selamlaşma, soru ve komutlar için çağırma. Görselden sonra tek kısa cümleyle ne yaptığını söyle. Kullanıcı bir fotoğraf gönderip onu değiştirmeni isterse (gözlük tak, nesne ekle, çıkar, renk değiştir gibi) edit_image aracını kullan; generate_image'ı sadece sıfırdan yeni bir görsel için kullan. edit_image başarısız olursa nedenini dürüstçe söyle ve kendiliğinden benzer yeni bir görsel üretme. Kullanıcı fotoğraf ya da bir videodan alınmış kareler gönderirse içeriği ayrıntılı analiz et ve somut düzenleme önerileri ver (parlaklık, kontrast, kırpma, renk gibi)." +
    (extra ? " Kullanıcının kendi ayarladığı ek talimatlar: " + String(extra).slice(0, 1000) : "");
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (req.method === "GET" && url.pathname === "/manifest.json") {
      return Response.json({
        name: "JARVIS", short_name: "JARVIS", start_url: "/", display: "standalone",
        background_color: "#060b14", theme_color: "#060b14",
        icons: [{ src: "/icon.png", sizes: "180x180", type: "image/png" }],
      });
    }

    if (req.method === "GET" && url.pathname === "/icon.png") {
      iconCache = iconCache || await makeIcon();
      return new Response(iconCache, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    }

    if (req.method === "POST" && url.pathname === "/speak") {
      let sp = req.headers.get("x-pass") || "";
      try { sp = decodeURIComponent(sp); } catch (e) {}
      if (sp.trim() !== String(env.APP_PASSWORD || "").trim()) {
        return Response.json({ error: "Şifre yanlış." }, { status: 401 });
      }
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
        return Response.json({ error: "ElevenLabs ayarlı değil" }, { status: 501 });
      }
      try {
        const { text } = await req.json();
        const vr = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(String(env.ELEVENLABS_VOICE_ID).trim()) + "?output_format=mp3_44100_64", {
          method: "POST",
          headers: { "xi-api-key": String(env.ELEVENLABS_API_KEY).trim(), "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({ text: String(text || "").slice(0, 1500), model_id: env.ELEVENLABS_MODEL || "eleven_flash_v2_5" }),
        });
        if (!vr.ok) {
          const t = await vr.text();
          return Response.json({ error: "ElevenLabs " + vr.status + ": " + t.slice(0, 160) }, { status: 502 });
        }
        return new Response(vr.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
      } catch (e) {
        return Response.json({ error: "Sunucu hatası: " + (e && e.message) }, { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      let pass = req.headers.get("x-pass") || "";
      try { pass = decodeURIComponent(pass); } catch (e) {}
      if (pass.trim() !== String(env.APP_PASSWORD || "").trim()) {
        return Response.json({ error: "Şifre yanlış." }, { status: 401 });
      }
      let body;
      try { body = await req.json(); } catch (e) { return Response.json({ error: "Geçersiz istek" }, { status: 400 }); }
      const convo = (body.messages || []).slice(-20);
      const system = systemPrompt(body.tz, body.extra);
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter(), enc = new TextEncoder();
      const send = o => w.write(enc.encode(JSON.stringify(o) + "\n"));
      const say = s => send({ t: "step", s });
      const job = (async () => {
        try {
          let data;
          const images = [];
          for (let i = 0; i < 5; i++) {
            await say(i ? "Claude devam ediyor" : "Claude isteği değerlendiriyor");
            const r = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: MODEL, max_tokens: 1000, system, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }, IMAGE_TOOL, EDIT_TOOL], messages: convo }),
            });
            data = await r.json();
            if (!r.ok) throw new Error((data.error && data.error.message) || "API hatası");
            for (const b of data.content || []) {
              if (b.type === "server_tool_use" && b.input && b.input.query) await say("İnternette aranıyor: " + String(b.input.query).slice(0, 60));
            }
            if (data.stop_reason === "pause_turn") { convo.push({ role: "assistant", content: data.content }); continue; }
            if (data.stop_reason === "tool_use") {
              const results = [];
              for (const b of data.content) {
                if (b.type === "tool_use" && b.name === "edit_image") {
                  await say("Düzenleme isteği: " + String((b.input && b.input.instruction) || "").slice(0, 90));
                  try {
                    const orig = lastUserImage(convo);
                    if (!orig) throw new Error("Düzenlenecek fotoğraf bulunamadı. ATÖLYE'den fotoğrafı seçip isteğini onunla birlikte gönder.");
                    await say("Orijinal fotoğraf Gemini'ye gönderiliyor");
                    images.push(await makeGeminiEdit(b.input && b.input.instruction, orig, env));
                    await say("Düzenlenmiş fotoğraf hazır");
                    results.push({ type: "tool_result", tool_use_id: b.id, content: "Fotoğraf düzenlendi ve kullanıcıya gösterildi." });
                  } catch (e) {
                    results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Fotoğraf düzenlenemedi: " + (e && e.message) });
                  }
                }
                if (b.type === "tool_use" && b.name === "generate_image") {
                  await say("Görsel prompt'u hazır: " + String((b.input && b.input.prompt) || "").slice(0, 90));
                  try {
                    images.push(await makeImage(b.input && b.input.prompt, env, say));
                    await say("Görsel hazır");
                    results.push({ type: "tool_result", tool_use_id: b.id, content: "Görsel oluşturuldu ve kullanıcıya gösterildi." });
                  } catch (e) {
                    results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Görsel oluşturulamadı: " + (e && e.message) });
                  }
                }
              }
              if (!results.length) break;
              convo.push({ role: "assistant", content: data.content }, { role: "user", content: results });
              continue;
            }
            break;
          }
          const reply = (data.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim() || "Cevap alamadım, tekrar dener misin?";
          await send({ t: "done", reply, images });
        } catch (e) {
          await send({ t: "err", m: "Sunucu hatası: " + (e && e.message) });
        } finally {
          await w.close();
        }
      })();
      ctx.waitUntil(job);
      return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
    }

    return new Response("Bulunamadı", { status: 404 });
  },
};

const PAGE = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>JARVIS</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="JARVIS">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#060b14">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#eef3f8;--panel:rgba(255,255,255,.78);--line:rgba(10,127,176,.3);--text:#0b1626;--dim:#52667c;--accent:#0a7fb0;--listen:#c26a00;--glow:rgba(10,127,176,.3);--grid:rgba(10,127,176,.07);box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root{--bg:#04080f;--panel:rgba(10,22,38,.72);--line:rgba(79,216,255,.24);--text:#dff6ff;--dim:#7f9bb4;--accent:#4fd8ff;--listen:#ffa43a;--glow:rgba(79,216,255,.45);--grid:rgba(79,216,255,.06)}}
[hidden]{display:none!important}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:radial-gradient(ellipse at 50% 20%,var(--glow) -45%,transparent 58%),linear-gradient(var(--grid) 1px,transparent 1px) 0 0/34px 34px,linear-gradient(90deg,var(--grid) 1px,transparent 1px) 0 0/34px 34px,var(--bg);color:var(--text);font:400 15px/1.45 "Chakra Petch",system-ui,sans-serif;display:flex;flex-direction:column;max-width:640px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px 2px}
.br{display:flex;align-items:center;gap:10px}
.lg{width:30px;height:30px;color:var(--accent);filter:drop-shadow(0 0 6px var(--accent))}
h1{font-size:18px;font-weight:600;letter-spacing:.3em;margin:0}
.tm{text-align:right;display:flex;flex-direction:column;line-height:1.2}
.tm b{font-size:16px;color:var(--accent);font-weight:600}
.tm small{color:var(--dim);font-size:11px}
.tabs{display:flex;gap:6px;align-items:center;padding:10px 16px 8px}
.tabs button{background:var(--panel);color:var(--dim);border:1px solid var(--line);border-radius:4px 4px 0 0;padding:7px 8px;font:600 11px "Chakra Petch",sans-serif;letter-spacing:.12em}
.tabs button.on{color:var(--text);border-color:var(--accent);box-shadow:0 0 12px var(--glow),inset 0 -2px var(--accent)}
#status{margin-left:0;color:var(--dim);font-size:12px;display:flex;align-items:center;gap:6px}
#status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent)}
body:has(#orb.listening) #status::before{background:var(--listen);box-shadow:0 0 8px var(--listen)}
.v{flex:1;min-height:0;display:flex;flex-direction:column}
.stage{display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 0 10px}
#orb{position:relative;width:184px;height:184px;border:0;background:none;padding:0;color:var(--text);font:600 14px "Chakra Petch",sans-serif;letter-spacing:.14em;cursor:pointer;-webkit-tap-highlight-color:transparent}
#orb:focus-visible{outline:2px solid var(--text);outline-offset:6px;border-radius:50%}
#orb svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
#orb svg *{transform-box:fill-box;transform-origin:center}
.c0{fill:none;stroke:var(--accent);stroke-width:1;stroke-dasharray:3 6;opacity:.7;animation:spin 60s linear infinite}
.h1{fill:none;stroke:var(--accent);stroke-width:2;filter:drop-shadow(0 0 5px var(--accent));animation:spin 40s linear infinite}
.h2{fill:none;stroke:var(--listen);stroke-width:5;stroke-dasharray:60 28;filter:drop-shadow(0 0 6px var(--listen));animation:spin 20s linear infinite reverse}
.h3{fill:var(--glow);stroke:var(--accent);stroke-width:1.5;filter:drop-shadow(0 0 10px var(--glow))}
#orb span{position:relative}
#orb.listening .h2{animation-duration:3s;stroke-width:7}
#orb.listening .h3,#orb.speaking .h3{animation:beat 1.1s ease-in-out infinite}
.wave{display:flex;align-items:center;gap:3px;height:34px}
.wave span{width:3px;height:var(--h);background:var(--accent);border-radius:2px;box-shadow:0 0 6px var(--accent);animation:wv .9s ease-in-out infinite;animation-delay:calc(var(--i)*-.07s);animation-play-state:paused}
body:has(#orb.listening) .wave span,body:has(#orb.speaking) .wave span{animation-play-state:running}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes beat{50%{transform:scale(1.08)}}
@keyframes wv{50%{height:30px}}
@media (prefers-reduced-motion:reduce){#orb svg *,.wave span{animation:none!important}}
.pn{position:relative;border:1px solid var(--line);background:var(--panel);border-radius:4px;padding:10px 12px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.pn::before,.pn::after{content:"";position:absolute;width:10px;height:10px;border:2px solid var(--accent)}
.pn::before{top:-1px;left:-1px;border-right:0;border-bottom:0}
.pn::after{bottom:-1px;right:-1px;border-left:0;border-top:0}
.pt{font-size:11px;letter-spacing:.2em;color:var(--accent);margin-bottom:6px}
.chat{flex:1;min-height:0;display:flex;flex-direction:column;margin:0 16px}
#log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.m{max-width:90%;padding:8px 12px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}
.m.ai{align-self:flex-start;border-left:2px solid var(--accent);background:rgba(79,216,255,.07)}
.m.me{align-self:flex-end;border-right:2px solid var(--listen);background:rgba(255,164,58,.09)}
form{display:flex;gap:8px;padding:10px 16px 14px}
input{flex:1;min-width:0;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:12px 14px;font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent)}
button.send{background:var(--accent);color:var(--bg);border:0;border-radius:4px;padding:0 18px;font:600 14px "Chakra Petch",sans-serif;letter-spacing:.1em;box-shadow:0 0 16px var(--glow)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:8px 16px;overflow-y:auto;align-content:start}
.kv{margin:4px 0;display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--dim)}
.kv b{color:var(--text);font-weight:600;text-align:right}
.bar{height:8px;border:1px solid var(--line);border-radius:2px;margin:8px 0 6px}
.bar i{display:block;height:100%;width:0;background:var(--accent);box-shadow:0 0 8px var(--accent);transition:width .4s}
.grid small{color:var(--dim);font-size:11px}
#set[hidden]{display:none}
#set{position:fixed;inset:0;background:var(--bg);z-index:5;overflow-y:auto;padding:calc(env(safe-area-inset-top,0px) + 18px) 18px 24px;max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
#set label{display:flex;flex-direction:column;gap:6px;color:var(--dim);font-size:14px}
#set select,#set textarea{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font:inherit}
#set textarea{min-height:120px;resize:vertical}
#set button{border-radius:4px;padding:12px;font:600 16px "Chakra Petch",sans-serif;border:1px solid var(--line);background:var(--panel);color:var(--text)}
#set #ok{background:var(--accent);color:var(--bg);border:0}

body>header,body>nav,body>main{position:relative;z-index:1}
#armor{display:none}
.hx{display:block}.ar{display:none}
:root[data-theme="armor"]{--bg:#05060a;--panel:rgba(16,10,12,.7);--line:rgba(255,120,80,.3);--text:#fff1e6;--dim:#b49a8c;--accent:#ffc94d;--listen:#ff4a3a;--glow:rgba(255,90,60,.4);--grid:rgba(255,120,80,.06)}
:root[data-theme="armor"] #armor{display:block;position:fixed;left:50%;top:306px;transform:translateX(-50%);width:min(86vw,400px);height:auto;opacity:.55;pointer-events:none;z-index:0;filter:drop-shadow(0 0 6px rgba(255,70,50,.6))}
:root[data-theme="armor"] #orb .hx{display:none}
:root[data-theme="armor"] #orb .ar{display:block}
.ln{fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:draw 3s ease forwards}
.ln.r{stroke:#ff4d3d}.ln.g{stroke:#ffc94d}.ln.c{stroke:#7ff0ff}
.rx{fill:none;stroke:#7ff0ff;stroke-width:1.6;filter:drop-shadow(0 0 4px #7ff0ff);transform-box:fill-box;transform-origin:center}
@keyframes draw{to{stroke-dashoffset:0}}
.a0{fill:none;stroke:var(--accent);stroke-width:1;stroke-dasharray:2 7;opacity:.8;animation:spin 50s linear infinite}
.a1{fill:none;stroke:#d6f4ff;stroke-width:18;stroke-dasharray:37 9.5;opacity:.85;filter:drop-shadow(0 0 5px #7ff0ff);animation:spin 30s linear infinite reverse}
.a2{fill:none;stroke:#7ff0ff;stroke-width:3;filter:drop-shadow(0 0 6px #7ff0ff)}
.a3{fill:rgba(127,240,255,.35);stroke:#7ff0ff;stroke-width:2;filter:drop-shadow(0 0 12px #7ff0ff)}
#orb.listening .a1{animation-duration:4s;stroke:var(--listen)}
#orb.listening .a3,#orb.speaking .a3,body:has(#orb.speaking) .rx{animation:beat 1.1s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.ln{animation:none;stroke-dashoffset:0}.a0,.a1,.a3,.rx{animation:none!important}}
:root[data-theme="armor"] .chat{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(10,6,8,.3)}
:root[data-theme="armor"] .m{background:rgba(10,6,8,.82)}
.card{width:100%;border-left:2px solid var(--listen);background:var(--panel)}
.ct{font-size:12px;letter-spacing:.14em;color:var(--accent)}
.cl{list-style:none;margin:6px 0;padding:0;font-size:12px;color:var(--dim)}
.cl li{margin:2px 0}.cl li.ok{color:var(--text)}
.cf{color:var(--dim);font-size:11px}
.m img{max-height:220px;width:auto;max-width:100%}
.grid1{padding:8px 16px;overflow-y:auto}
.fl{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dim);margin:6px 0}
.fl input{color:var(--text)}
.dm{color:var(--dim);font-size:12px}
#cv,#vd{max-width:100%;max-height:40vh;width:auto;border-radius:4px;margin:8px auto;display:block}
.rg{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--dim);margin:8px 0}
.rg label{display:flex;justify-content:space-between;align-items:center;gap:12px}
.rg input{flex:1;min-width:0;padding:0}
.row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.row button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:8px 10px;font:600 12px "Chakra Petch",sans-serif}
#v3 .send{margin-top:8px;padding:12px 18px}
#rq{width:100%;margin-top:6px}
</style>
</head>
<body>
<svg id="armor" viewBox="0 0 400 520" aria-hidden="true"><g id="rh"><path class="ln r" pathLength="1" d="M200 22C228 22 250 44 252 84L250 120C248 146 236 166 220 178L206 186"/><path class="ln r" pathLength="1" d="M214 188L216 208C262 216 318 232 348 262C372 288 372 330 362 372L350 430L334 520"/><path class="ln g" pathLength="1" d="M216 208C250 250 262 300 258 360L252 420"/><path class="ln g" pathLength="1" d="M300 236C340 240 364 268 358 306L330 300C322 270 312 250 300 236Z"/><path class="ln c" pathLength="1" d="M214 96L246 102L244 110L214 108Z"/><path class="ln g" pathLength="1" d="M200 60C226 62 240 70 246 84"/></g><circle class="rx" cx="200" cy="330" r="30"/><circle class="rx" cx="200" cy="330" r="18"/><circle class="rx" cx="200" cy="330" r="7" style="fill:#7ff0ff"/></svg>
<header><div class="br"><svg class="lg" viewBox="0 0 24 24"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="none" stroke="currentColor" stroke-width="2"/></svg><div><h1>J.A.R.V.I.S</h1><span id="status">Hazır</span></div></div><div class="tm"><b id="clk">--:--:--</b><small id="dt"></small></div></header>
<nav class="tabs"><button id="t1" class="on" type="button">KOMUT</button><button id="t3" type="button">ATÖLYE</button><button id="t2" type="button">DURUM</button><button id="gear" type="button">AYARLAR</button></nav>
<section id="set" hidden>
<h1>Ayarlar</h1>
<label>Konuşma dili<select id="sl"><option value="tr-TR">Türkçe</option><option value="ja-JP">日本語</option><option value="en-US">English</option></select></label>
<label>Ses hızı<input id="sr" type="range" min="0.7" max="1.4" step="0.1" value="1"></label>
<label>Tema<select id="st"><option value="armor">Zırh (kırmızı-altın)</option><option value="command">Komuta (mavi-turuncu)</option></select></label>
<label>Ses motoru<select id="sv"><option value="eleven">ElevenLabs (doğal ses)</option><option value="browser">Tarayıcı sesi</option></select></label>
<label>JARVIS'e özel talimatların<textarea id="sx" placeholder="Örnek: Bana adımla hitap et. Cevapların çok kısa olsun."></textarea></label>
<button id="ok" type="button">Kaydet</button>
<button id="rp" type="button">Şifreyi sil</button>
</section>
<main id="v1" class="v"><div class="stage"><button id="orb" type="button" aria-label="Konuşmaya başla"><svg class="hx" viewBox="0 0 200 200"><circle class="c0" cx="100" cy="100" r="97"/><polygon class="h1" points="100,8 179.7,54 179.7,146 100,192 20.3,146 20.3,54"/><polygon class="h2" points="100,26 164.1,63 164.1,137 100,174 35.9,137 35.9,63"/><polygon class="h3" points="100,44 148.5,72 148.5,128 100,156 51.5,128 51.5,72"/></svg><svg class="ar" viewBox="0 0 200 200"><circle class="a0" cx="100" cy="100" r="96"/><circle class="a1" cx="100" cy="100" r="74"/><circle class="a2" cx="100" cy="100" r="50"/><circle class="a3" cx="100" cy="100" r="34"/></svg><span>KONUŞ</span></button><div id="wave" class="wave"></div></div>
<div class="pn chat"><div class="pt">SOHBET</div><div id="log" aria-live="polite"></div></div>
<form id="f"><input id="t" placeholder="Yaz ya da Konuş'a bas" autocomplete="off"><button class="send" type="submit">Gönder</button></form></main>
<main id="v3" class="v" hidden><div class="grid1"><div class="pn"><div class="pt">ATÖLYE</div>
<label class="fl">Fotoğraf veya video seç<input id="fi" type="file" accept="image/*,video/*"></label>
<div id="fn" class="dm">Henüz dosya seçilmedi</div>
<canvas id="cv" hidden></canvas><video id="vd" controls playsinline hidden></video>
<div id="pc" hidden>
<div class="rg"><label>Parlaklık<input type="range" id="eb" min="50" max="150" value="100"></label><label>Kontrast<input type="range" id="ec" min="50" max="150" value="100"></label><label>Doygunluk<input type="range" id="es" min="0" max="200" value="100"></label></div>
<div class="row"><button id="b_au" type="button">Otomatik</button><button id="b_bw" type="button">Siyah-beyaz</button><button id="b_sp" type="button">Sepya</button><button id="b_rt" type="button">Döndür</button><button id="b_fl" type="button">Çevir</button><button id="b_rz" type="button">Sıfırla</button><button id="b_sv" type="button">Kaydet</button></div>
</div>
<div id="vc" class="row" hidden><button id="b_fc" type="button">Kare yakala</button></div>
<input id="rq" placeholder="Ne yapılsın? (ör. bu fotoğrafı analiz et)"><button id="rs" class="send" type="button">Claude'a gönder</button>
<p class="dm">İlerleme ve süre KOMUT sekmesindeki sohbette görünür.</p>
</div></div></main>
<main id="v2" class="v" hidden><div class="grid">
<div class="pn"><div class="pt">ÇEKİRDEK</div><p class="kv">Durum <b id="ai">Hazır</b></p><p class="kv">Model <b>Claude</b></p></div>
<div class="pn"><div class="pt">SİSTEM</div><p class="kv">Bağlantı <b id="on"></b></p><p class="kv">Ses <b id="vm"></b></p><p class="kv">Dil <b id="lg"></b></p></div>
<div class="pn"><div class="pt">AKTİVİTE</div><p class="kv">Mesajlarım <b id="mc"></b></p><p class="kv">Son yanıt <b id="lm"></b></p></div>
<div class="pn"><div class="pt">PERFORMANS</div><div class="bar"><i id="pf"></i></div><small>Yanıt süresi (10 sn = dolu)</small></div>
</div></main>
<script>
var log=document.getElementById('log'),orb=document.getElementById('orb'),st=document.getElementById('status'),inp=document.getElementById('t');
var LANG='tr-TR',msgs=[],S={lang:'tr-TR',extra:'',rate:1,voice:'eleven',theme:'armor'};
try{S=Object.assign(S,JSON.parse(localStorage.getItem('jarvis_set')||'{}'))}catch(e){}
LANG=S.lang;
document.documentElement.setAttribute('data-theme',S.theme);

function getPass(force){
  var p=null;
  try{p=localStorage.getItem('jarvis_pass')}catch(e){}
  if(!p||force){p=(prompt('Şifre:')||'').trim();try{localStorage.setItem('jarvis_pass',p)}catch(e){}}
  return p;
}

async function getReply(text,imgs,card){
  msgs.push({role:'user',content:text});
  var payload=msgs.slice();
  if(imgs&&imgs.length)payload[payload.length-1]={role:'user',content:imgs.map(function(d){return {type:'image',source:{type:'base64',media_type:'image/jpeg',data:d}}}).concat([{type:'text',text:text}])};
  if(card)card.step('Sunucuya gönderiliyor');
  var res=await fetch('/chat',{method:'POST',headers:{'content-type':'application/json','x-pass':encodeURIComponent(getPass(false).trim())},body:JSON.stringify({messages:payload,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,extra:S.extra})});
  if(res.status===401){getPass(true);msgs.pop();throw new Error('Şifre yanlış, tekrar dene.')}
  if(!res.ok){msgs.pop();var d=await res.json().catch(function(){return {}});throw new Error(d.error||'Bir hata oluştu.')}
  var out=null;
  try{
    var rd=res.body.getReader(),dec=new TextDecoder(),buf='';
    for(;;){
      var c=await rd.read();if(c.done)break;
      buf+=dec.decode(c.value,{stream:true});
      var ls=buf.split('\\n');buf=ls.pop();
      for(var k=0;k<ls.length;k++){
        if(!ls[k])continue;
        var ev=JSON.parse(ls[k]);
        if(ev.t==='step'&&card)card.step(ev.s);
        if(ev.t==='done')out=ev;
        if(ev.t==='err')throw new Error(ev.m);
      }
    }
    if(!out)throw new Error('Yanıt yarıda kesildi, tekrar dene.');
  }catch(e){msgs.pop();throw e}
  msgs.push({role:'assistant',content:out.reply});
  lastImgs=out.images||[];
  return out.reply;
}

function add(cls,text){var e=document.createElement('div');e.className='m '+cls;e.textContent=text;log.appendChild(e);log.scrollTop=log.scrollHeight}
function addImg(src,cls){var e=document.createElement('div');e.className='m '+(cls||'ai');var i=document.createElement('img');i.src=src;i.alt='Oluşturulan görsel';i.style.cssText='max-width:100%;display:block;border-radius:4px';e.appendChild(i);log.appendChild(e);log.scrollTop=log.scrollHeight}
function setState(s,label){orb.className=s;st.textContent=label;var a=document.getElementById('ai');if(a)a.textContent=label}

function speakBrowser(text){
  if(!('speechSynthesis' in window))return setState('','Hazır');
  speechSynthesis.cancel();
  var u=new SpeechSynthesisUtterance(text);u.lang=LANG;u.rate=S.rate;
  u.onstart=function(){setState('speaking','Konuşuyor')};
  u.onend=u.onerror=function(){setState('','Hazır')};
  speechSynthesis.speak(u);
}

var player=new Audio(),unlocked=false,warned=false,SIL='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
function unlock(){
  if(unlocked)return;unlocked=true;player.src=SIL;
  var p=player.play();if(p&&p.catch)p.catch(function(e){if(e&&e.name==='NotAllowedError')unlocked=false});
}
function stopAudio(){if(!player.paused&&String(player.src).indexOf('blob:')===0)player.pause()}

function speak(text){
  if(S.voice==='browser')return speakBrowser(text);
  setState('','Ses hazırlanıyor');
  fetch('/speak',{method:'POST',headers:{'content-type':'application/json','x-pass':encodeURIComponent(getPass(false).trim())},body:JSON.stringify({text:text})})
  .then(function(res){
    if(!res.ok)return res.json().catch(function(){return {}}).then(function(d){throw new Error(d.error||'Ses servisi hatası')});
    return res.blob();
  })
  .then(function(b){
    player.src=URL.createObjectURL(b);player.playbackRate=S.rate;
    player.onplaying=function(){setState('speaking','Konuşuyor')};
    player.onended=player.onpause=function(){setState('','Hazır')};
    return player.play();
  })
  .catch(function(e){
    if(!warned){warned=true;add('ai','Ses servisi kullanılamadı ('+((e&&e.message)||'hata')+'). Tarayıcı sesiyle devam ediyorum.')}
    speakBrowser(text);
  });
}

async function handle(text,imgs,card,skipMe){
  text=text.trim();if(!text)return;
  if(!skipMe)add('me',text);
  setState('','Düşünüyor');
  var base0=(imgs&&imgs.length)?'media':((/çiz|görsel|resim|oluştur/i.test(text)||text.indexOf(' ')<0)?'image':'chat');
  card=card||mkCard('İşlem',base0);
  try{
    var t0=Date.now();var r=await getReply(text,imgs,card);lastMs=Date.now()-t0;
    var kind=lastImgs.length?'image':(base0==='media'?'media':'chat');
    var n=card.count();card.done(true,kind);
    if(n<=3&&kind==='chat')card.remove();
    add('ai',r);(lastImgs||[]).forEach(function(s){addImg(s)});speak(r);
  }catch(e){card.done(false);add('ai',e.message||'Yanıt alınamadı. Bağlantını kontrol edip tekrar dene.');setState('','Hazır')}
}

document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();unlock();var v=inp.value;inp.value='';handle(v)});

var SR=window.SpeechRecognition||window.webkitSpeechRecognition,rec=null,on=false;
orb.addEventListener('click',function(){
  stopAudio();unlock();
  if(!SR){add('ai','Bu tarayıcı sesli girişi desteklemiyor. iPhone için Safari kullan ya da yazarak devam et.');return}
  if(on){rec.stop();return}
  speechSynthesis.cancel();
  rec=new SR();rec.lang=LANG;rec.interimResults=false;
  rec.onstart=function(){on=true;setState('listening','Dinliyor')};
  rec.onresult=function(e){handle(e.results[0][0].transcript)};
  rec.onerror=function(e){on=false;setState('','Hazır');add('ai',e.error==='not-allowed'?'Mikrofon izni verilmedi. Safari ayarlarından mikrofona izin ver.':'Ses algılanamadı. Tekrar dene.')};
  rec.onend=function(){on=false;if(st.textContent==='Dinliyor')setState('','Hazır')};
  rec.start();
});

function mkCard(title,kind){
  var e=document.createElement('div');e.className='m ai card';
  e.innerHTML='<b class="ct"></b><ul class="cl"></ul><small class="cf"></small>';
  e.querySelector('.ct').textContent=title;
  log.appendChild(e);log.scrollTop=log.scrollHeight;
  var t0=Date.now(),ts=t0,li=null,n=0,avg=0,ul=e.querySelector('.cl'),ft=e.querySelector('.cf');
  try{avg=(JSON.parse(localStorage.getItem('jarvis_avg')||'{}')[kind]||{}).avg||0}catch(x){}
  function tick(){var s=(Date.now()-t0)/1000;ft.textContent='Geçen '+s.toFixed(0)+' sn'+(avg?(avg-s>1?' · tahmini kalan ~'+Math.ceil(avg-s)+' sn':' · birazdan bitiyor'):'')}
  var iv=setInterval(tick,300);tick();
  function close(){if(li){li.textContent='✓ '+li.dataset.t+' ('+((Date.now()-ts)/1000).toFixed(1)+' sn)';li.className='ok'}}
  return {
    step:function(s){close();li=document.createElement('li');li.dataset.t=s;li.textContent='… '+s;ul.appendChild(li);ts=Date.now();n++;log.scrollTop=log.scrollHeight},
    count:function(){return n},
    remove:function(){e.remove()},
    done:function(ok,k2){close();clearInterval(iv);var tot=(Date.now()-t0)/1000;ft.textContent=(ok?'Tamamlandı':'Hata')+' · toplam '+tot.toFixed(1)+' sn';
      if(ok){try{var a=JSON.parse(localStorage.getItem('jarvis_avg')||'{}'),o=a[k2||kind]||{n:0,avg:0};o.avg=(o.avg*o.n+tot)/(o.n+1);o.n=Math.min(o.n+1,20);a[k2||kind]=o;localStorage.setItem('jarvis_avg',JSON.stringify(a))}catch(x){}}}
  };
}
function $(i){return document.getElementById(i)}
var E={b:1,c:1,s:1,bw:0,sp:0},base=null,media='',cvv=$('cv'),vd=$('vd');
function resetE(){E={b:1,c:1,s:1,bw:0,sp:0};$('eb').value=100;$('ec').value=100;$('es').value=100}
function render(){
  if(!base)return;
  cvv.width=base.width;cvv.height=base.height;
  var x=cvv.getContext('2d');x.drawImage(base,0,0);
  var im=x.getImageData(0,0,cvv.width,cvv.height),d=im.data;
  for(var i=0;i<d.length;i+=4){
    var r=d[i]*E.b,g=d[i+1]*E.b,b=d[i+2]*E.b;
    r=(r-128)*E.c+128;g=(g-128)*E.c+128;b=(b-128)*E.c+128;
    var l=.299*r+.587*g+.114*b;
    r=l+(r-l)*E.s;g=l+(g-l)*E.s;b=l+(b-l)*E.s;
    if(E.bw){r=l;g=l;b=l}
    if(E.sp){var tr=.393*r+.769*g+.189*b,tg=.349*r+.686*g+.168*b,tb=.272*r+.534*g+.131*b;r=tr;g=tg;b=tb}
    d[i]=r;d[i+1]=g;d[i+2]=b;
  }
  x.putImageData(im,0,0);
}
function showPhoto(){media='p';vd.hidden=true;$('vc').hidden=true;cvv.hidden=false;$('pc').hidden=false;resetE();render()}
$('fi').onchange=function(){
  var f=this.files[0];if(!f)return;
  var u=URL.createObjectURL(f);
  $('fn').textContent=f.name+' · '+(f.size/1048576).toFixed(1)+' MB';
  if(f.type.indexOf('video')===0){
    media='v';cvv.hidden=true;$('pc').hidden=true;vd.hidden=false;$('vc').hidden=false;vd.src=u;
    vd.onloadedmetadata=function(){$('fn').textContent+=' · '+Math.round(vd.duration)+' sn · '+vd.videoWidth+'x'+vd.videoHeight};
  }else{
    var im=new Image();
    im.onload=function(){var sc=Math.min(1,1280/Math.max(im.width,im.height));base=document.createElement('canvas');base.width=Math.round(im.width*sc);base.height=Math.round(im.height*sc);base.getContext('2d').drawImage(im,0,0,base.width,base.height);showPhoto()};
    im.onerror=function(){$('fn').textContent='Bu dosya açılamadı'};
    im.src=u;
  }
};
['eb','ec','es'].forEach(function(id){$(id).oninput=function(){E.b=$('eb').value/100;E.c=$('ec').value/100;E.s=$('es').value/100;render()}});
$('b_bw').onclick=function(){E.bw=E.bw?0:1;render()};
$('b_sp').onclick=function(){E.sp=E.sp?0:1;render()};
$('b_rz').onclick=function(){resetE();render()};
$('b_rt').onclick=function(){if(!base)return;var n=document.createElement('canvas');n.width=base.height;n.height=base.width;var x=n.getContext('2d');x.translate(n.width,0);x.rotate(Math.PI/2);x.drawImage(base,0,0);base=n;render()};
$('b_fl').onclick=function(){if(!base)return;var n=document.createElement('canvas');n.width=base.width;n.height=base.height;var x=n.getContext('2d');x.translate(n.width,0);x.scale(-1,1);x.drawImage(base,0,0);base=n;render()};
$('b_au').onclick=function(){if(!base)return;var d=base.getContext('2d').getImageData(0,0,base.width,base.height).data,s=0,n=0;for(var i=0;i<d.length;i+=40){s+=.299*d[i]+.587*d[i+1]+.114*d[i+2];n++}var a=s/n||118;E.b=Math.min(1.4,Math.max(.75,118/a));E.c=1.1;E.s=1.12;$('eb').value=Math.round(E.b*100);$('ec').value=110;$('es').value=112;render()};
$('b_sv').onclick=function(){cvv.toBlob(function(b){var f=new File([b],'jarvis.jpg',{type:'image/jpeg'});if(navigator.canShare&&navigator.canShare({files:[f]}))navigator.share({files:[f]}).catch(function(){});else window.open(URL.createObjectURL(b))},'image/jpeg',.92)};
$('b_fc').onclick=function(){var w=vd.videoWidth,h=vd.videoHeight;if(!w)return;var sc=Math.min(1,1280/Math.max(w,h));base=document.createElement('canvas');base.width=Math.round(w*sc);base.height=Math.round(h*sc);base.getContext('2d').drawImage(vd,0,0,base.width,base.height);vd.pause();showPhoto()};
function smallJpg(src){var sc=Math.min(1,1024/Math.max(src.width,src.height)),t=document.createElement('canvas');t.width=Math.round(src.width*sc);t.height=Math.round(src.height*sc);t.getContext('2d').drawImage(src,0,0,t.width,t.height);return t.toDataURL('image/jpeg',.82)}
function grabFrames(card){
  return new Promise(function(res){
    var pts=[.1,.35,.6,.85],k=0,out=[],tc=document.createElement('canvas');
    function next(){
      if(k>=pts.length)return res(out);
      card.step('Kare '+(k+1)+'/'+pts.length+' alınıyor');
      vd.onseeked=function(){var sc=Math.min(1,768/Math.max(vd.videoWidth,vd.videoHeight));tc.width=Math.round(vd.videoWidth*sc);tc.height=Math.round(vd.videoHeight*sc);tc.getContext('2d').drawImage(vd,0,0,tc.width,tc.height);out.push(tc.toDataURL('image/jpeg',.8).split(',')[1]);k++;next()};
      vd.currentTime=vd.duration*pts[k];
    }
    next();
  });
}
$('rs').onclick=function(){
  if(!media){$('fn').textContent='Önce bir fotoğraf ya da video seç';return}
  unlock();
  var q=$('rq').value.trim()||'Bunu incele, ne gördüğünü ve nasıl iyileştirebileceğimi anlat.';
  tab(1);add('me',q);
  var card=mkCard(media==='v'?'Video analizi':'Fotoğraf analizi','media');
  if(media==='v'){grabFrames(card).then(function(im){handle('Bunlar bir videodan eşit aralıklı alınmış 4 kare. '+q,im,card,true)})}
  else{card.step('Fotoğraf küçültülüyor');var u=smallJpg(cvv);addImg(u,'me');handle(q,[u.split(',')[1]],card,true)}
};
var rh=document.getElementById('rh'),lh=rh.cloneNode(true);lh.removeAttribute('id');lh.setAttribute('transform','translate(400 0) scale(-1 1)');rh.parentNode.insertBefore(lh,rh);
var lastMs=0,lastImgs=[],wv=document.getElementById('wave');
for(var i=0;i<30;i++){var sp=document.createElement('span');sp.style.setProperty('--i',i);sp.style.setProperty('--h',(4+Math.round(Math.abs(Math.sin(i*1.7))*14))+'px');wv.appendChild(sp)}
function tab(n){document.getElementById('v1').hidden=n!==1;document.getElementById('v2').hidden=n!==2;document.getElementById('t1').classList.toggle('on',n===1);document.getElementById('t2').classList.toggle('on',n===2);document.getElementById('t3').classList.toggle('on',n===3);document.getElementById('v3').hidden=n!==3;upd()}
document.getElementById('t1').onclick=function(){tab(1)};
document.getElementById('t2').onclick=function(){tab(2)};
document.getElementById('t3').onclick=function(){tab(3)};
function upd(){
  var d=new Date();
  document.getElementById('clk').textContent=d.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('dt').textContent=d.toLocaleDateString('tr-TR',{day:'numeric',month:'short',year:'numeric'});
  document.getElementById('mc').textContent=document.querySelectorAll('.m.me').length;
  document.getElementById('lm').textContent=lastMs?(lastMs/1000).toFixed(1)+' sn':'-';
  document.getElementById('pf').style.width=Math.min(100,lastMs/100)+'%';
  document.getElementById('on').textContent=navigator.onLine?'Çevrimiçi':'Çevrimdışı';
  document.getElementById('vm').textContent=S.voice==='browser'?'Tarayıcı sesi':'ElevenLabs';
  document.getElementById('lg').textContent=LANG;
}
setInterval(upd,1000);upd();
var set=document.getElementById('set');
document.getElementById('gear').onclick=function(){document.getElementById('sl').value=S.lang;document.getElementById('sx').value=S.extra;document.getElementById('sr').value=S.rate;document.getElementById('sv').value=S.voice;document.getElementById('st').value=S.theme;set.hidden=false};
document.getElementById('ok').onclick=function(){S={lang:document.getElementById('sl').value,extra:document.getElementById('sx').value.slice(0,1000),rate:parseFloat(document.getElementById('sr').value),voice:document.getElementById('sv').value,theme:document.getElementById('st').value};LANG=S.lang;document.documentElement.setAttribute('data-theme',S.theme);try{localStorage.setItem('jarvis_set',JSON.stringify(S))}catch(e){}set.hidden=true;add('ai','Ayarlar kaydedildi.')};
document.getElementById('rp').onclick=function(){try{localStorage.removeItem('jarvis_pass')}catch(e){}set.hidden=true;add('ai','Şifre silindi. Sonraki mesajda yeniden sorulacak.')};
add('ai','Merhaba, ben JARVIS. Konuş düğmesine bas ya da yaz.');
</script>
</body>
</html>`;
