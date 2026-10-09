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

function systemPrompt(tz, extra) {
  let zone = "UTC";
  try { new Intl.DateTimeFormat("tr-TR", { timeZone: tz }); zone = tz; } catch (e) {}
  const now = new Date().toLocaleString("tr-TR", { timeZone: zone, dateStyle: "full", timeStyle: "short" });
  return "Sen JARVIS adında, kullanıcının kişisel sesli asistanısın. Kullanıcının dilinde, kısa ve doğal konuş (en fazla 2-3 cümle). Markdown, liste, emoji ve bağlantı kullanma; cevapların sesli okunacak. " +
    "Şu an: " + now + " (saat dilimi: " + zone + "). Hava durumu, haber, fiyat gibi güncel bilgiler için web aramasını kullan. Hava durumunda şehir belirtilmemişse saat diliminden çıkarım yap ve hangi şehir için baktığını söyle." +
    (extra ? " Kullanıcının kendi ayarladığı ek talimatlar: " + String(extra).slice(0, 1000) : "");
}

export default {
  async fetch(req, env) {
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
      try {
      const { messages, tz, extra } = await req.json();
      const convo = (messages || []).slice(-20);
      const system = systemPrompt(tz, extra);
      let data;
      for (let i = 0; i < 3; i++) {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1000,
            system,
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
            messages: convo,
          }),
        });
        data = await r.json();
        if (!r.ok) {
          return Response.json({ error: (data.error && data.error.message) || "API hatası" }, { status: 502 });
        }
        if (data.stop_reason !== "pause_turn") break;
        convo.push({ role: "assistant", content: data.content });
      }
      const reply = (data.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim() || "Cevap alamadım, tekrar dener misin?";
      return Response.json({ reply });
      } catch (e) {
        return Response.json({ error: "Sunucu hatası: " + (e && e.message) }, { status: 500 });
      }
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
.tabs button{background:var(--panel);color:var(--dim);border:1px solid var(--line);border-radius:4px 4px 0 0;padding:7px 11px;font:600 12px "Chakra Petch",sans-serif;letter-spacing:.12em}
.tabs button.on{color:var(--text);border-color:var(--accent);box-shadow:0 0 12px var(--glow),inset 0 -2px var(--accent)}
#status{margin-left:auto;color:var(--dim);font-size:12px;display:flex;align-items:center;gap:6px}
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
</style>
</head>
<body>
<header><div class="br"><svg class="lg" viewBox="0 0 24 24"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="none" stroke="currentColor" stroke-width="2"/></svg><h1>J.A.R.V.I.S</h1></div><div class="tm"><b id="clk">--:--:--</b><small id="dt"></small></div></header>
<nav class="tabs"><button id="t1" class="on" type="button">KOMUT</button><button id="t2" type="button">DURUM</button><button id="gear" type="button">AYARLAR</button><span id="status">Hazır</span></nav>
<section id="set" hidden>
<h1>Ayarlar</h1>
<label>Konuşma dili<select id="sl"><option value="tr-TR">Türkçe</option><option value="ja-JP">日本語</option><option value="en-US">English</option></select></label>
<label>Ses hızı<input id="sr" type="range" min="0.7" max="1.4" step="0.1" value="1"></label>
<label>Ses motoru<select id="sv"><option value="eleven">ElevenLabs (doğal ses)</option><option value="browser">Tarayıcı sesi</option></select></label>
<label>JARVIS'e özel talimatların<textarea id="sx" placeholder="Örnek: Bana adımla hitap et. Cevapların çok kısa olsun."></textarea></label>
<button id="ok" type="button">Kaydet</button>
<button id="rp" type="button">Şifreyi sil</button>
</section>
<main id="v1" class="v"><div class="stage"><button id="orb" type="button" aria-label="Konuşmaya başla"><svg viewBox="0 0 200 200"><circle class="c0" cx="100" cy="100" r="97"/><polygon class="h1" points="100,8 179.7,54 179.7,146 100,192 20.3,146 20.3,54"/><polygon class="h2" points="100,26 164.1,63 164.1,137 100,174 35.9,137 35.9,63"/><polygon class="h3" points="100,44 148.5,72 148.5,128 100,156 51.5,128 51.5,72"/></svg><span>KONUŞ</span></button><div id="wave" class="wave"></div></div>
<div class="pn chat"><div class="pt">SOHBET</div><div id="log" aria-live="polite"></div></div>
<form id="f"><input id="t" placeholder="Yaz ya da Konuş'a bas" autocomplete="off"><button class="send" type="submit">Gönder</button></form></main>
<main id="v2" class="v" hidden><div class="grid">
<div class="pn"><div class="pt">ÇEKİRDEK</div><p class="kv">Durum <b id="ai">Hazır</b></p><p class="kv">Model <b>Claude</b></p></div>
<div class="pn"><div class="pt">SİSTEM</div><p class="kv">Bağlantı <b id="on"></b></p><p class="kv">Ses <b id="vm"></b></p><p class="kv">Dil <b id="lg"></b></p></div>
<div class="pn"><div class="pt">AKTİVİTE</div><p class="kv">Mesajlarım <b id="mc"></b></p><p class="kv">Son yanıt <b id="lm"></b></p></div>
<div class="pn"><div class="pt">PERFORMANS</div><div class="bar"><i id="pf"></i></div><small>Yanıt süresi (10 sn = dolu)</small></div>
</div></main>
<script>
var log=document.getElementById('log'),orb=document.getElementById('orb'),st=document.getElementById('status'),inp=document.getElementById('t');
var LANG='tr-TR',msgs=[],S={lang:'tr-TR',extra:'',rate:1,voice:'eleven'};
try{S=Object.assign(S,JSON.parse(localStorage.getItem('jarvis_set')||'{}'))}catch(e){}
LANG=S.lang;

function getPass(force){
  var p=null;
  try{p=localStorage.getItem('jarvis_pass')}catch(e){}
  if(!p||force){p=(prompt('Şifre:')||'').trim();try{localStorage.setItem('jarvis_pass',p)}catch(e){}}
  return p;
}

async function getReply(text){
  msgs.push({role:'user',content:text});
  var res=await fetch('/chat',{method:'POST',headers:{'content-type':'application/json','x-pass':encodeURIComponent(getPass(false).trim())},body:JSON.stringify({messages:msgs,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,extra:S.extra})});
  var data=await res.json().catch(function(){return {}});
  if(res.status===401){getPass(true);msgs.pop();throw new Error('Şifre yanlış, tekrar dene.')}
  if(!res.ok){msgs.pop();throw new Error(data.error||'Bir hata oluştu.')}
  msgs.push({role:'assistant',content:data.reply});
  return data.reply;
}

function add(cls,text){var e=document.createElement('div');e.className='m '+cls;e.textContent=text;log.appendChild(e);log.scrollTop=log.scrollHeight}
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

async function handle(text){
  text=text.trim();if(!text)return;
  add('me',text);setState('','Düşünüyor');
  try{var t0=Date.now();var r=await getReply(text);lastMs=Date.now()-t0;add('ai',r);speak(r)}
  catch(e){add('ai',e.message||'Yanıt alınamadı. Bağlantını kontrol edip tekrar dene.');setState('','Hazır')}
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
var lastMs=0,wv=document.getElementById('wave');
for(var i=0;i<30;i++){var sp=document.createElement('span');sp.style.setProperty('--i',i);sp.style.setProperty('--h',(4+Math.round(Math.abs(Math.sin(i*1.7))*14))+'px');wv.appendChild(sp)}
function tab(n){document.getElementById('v1').hidden=n!==1;document.getElementById('v2').hidden=n!==2;document.getElementById('t1').classList.toggle('on',n===1);document.getElementById('t2').classList.toggle('on',n===2);upd()}
document.getElementById('t1').onclick=function(){tab(1)};
document.getElementById('t2').onclick=function(){tab(2)};
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
document.getElementById('gear').onclick=function(){document.getElementById('sl').value=S.lang;document.getElementById('sx').value=S.extra;document.getElementById('sr').value=S.rate;document.getElementById('sv').value=S.voice;set.hidden=false};
document.getElementById('ok').onclick=function(){S={lang:document.getElementById('sl').value,extra:document.getElementById('sx').value.slice(0,1000),rate:parseFloat(document.getElementById('sr').value),voice:document.getElementById('sv').value};LANG=S.lang;try{localStorage.setItem('jarvis_set',JSON.stringify(S))}catch(e){}set.hidden=true;add('ai','Ayarlar kaydedildi.')};
document.getElementById('rp').onclick=function(){try{localStorage.removeItem('jarvis_pass')}catch(e){}set.hidden=true;add('ai','Şifre silindi. Sonraki mesajda yeniden sorulacak.')};
add('ai','Merhaba, ben JARVIS. Konuş düğmesine bas ya da yaz.');
</script>
</body>
</html>`;
