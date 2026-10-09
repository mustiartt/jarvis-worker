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
:root{--bg:#eef3f8;--panel:rgba(255,255,255,.75);--line:rgba(10,127,176,.28);--text:#0b1626;--dim:#52667c;--accent:#0a7fb0;--listen:#c26a00;--glow:rgba(10,127,176,.35);--grid:rgba(10,127,176,.07);box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root{--bg:#050a12;--panel:rgba(14,26,42,.72);--line:rgba(79,216,255,.22);--text:#dff6ff;--dim:#7f9bb4;--accent:#4fd8ff;--listen:#ffb347;--glow:rgba(79,216,255,.5);--grid:rgba(79,216,255,.06)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:radial-gradient(ellipse at 50% 22%,var(--glow) -40%,transparent 55%),linear-gradient(var(--grid) 1px,transparent 1px) 0 0/36px 36px,linear-gradient(90deg,var(--grid) 1px,transparent 1px) 0 0/36px 36px,var(--bg);color:var(--text);font:400 16px/1.5 "Chakra Petch",system-ui,sans-serif;display:flex;flex-direction:column;max-width:640px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px 0}
h1{font-size:19px;font-weight:600;letter-spacing:.32em;margin:0}
.hd{display:flex;align-items:center;gap:10px}
#status{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:13px;border:1px solid var(--line);border-radius:99px;padding:3px 11px;background:var(--panel)}
#status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent)}
body:has(#orb.listening) #status::before{background:var(--listen);box-shadow:0 0 8px var(--listen)}
#gear{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:99px;padding:3px 13px;font:inherit;font-size:13px}
.stage{display:flex;justify-content:center;padding:26px 0 18px}
#orb{position:relative;width:176px;height:176px;border:0;background:none;padding:0;cursor:pointer;color:var(--text);font:600 15px "Chakra Petch",sans-serif;letter-spacing:.12em;-webkit-tap-highlight-color:transparent}
#orb i{position:absolute;border-radius:50%;pointer-events:none}
#orb .r1{inset:0;border:1px dashed var(--accent);opacity:.7;animation:spin 40s linear infinite}
#orb .r2{inset:12px;border:3px solid transparent;border-top-color:var(--accent);border-bottom-color:var(--accent);filter:drop-shadow(0 0 6px var(--accent));animation:spin 14s linear infinite reverse}
#orb .r3{inset:30px;border:1px solid var(--line);background:radial-gradient(circle at 38% 32%,var(--glow),transparent 72%);box-shadow:0 0 34px var(--glow),inset 0 0 26px var(--glow)}
#orb span{position:relative}
#orb:focus-visible{outline:2px solid var(--text);outline-offset:6px;border-radius:50%}
#orb.listening .r2{border-top-color:var(--listen);border-bottom-color:var(--listen);filter:drop-shadow(0 0 8px var(--listen));animation-duration:2.4s}
#orb.listening .r3{box-shadow:0 0 44px var(--listen),inset 0 0 28px var(--listen);animation:beat 1s ease-in-out infinite}
#orb.speaking .r3{animation:beat 1.6s ease-in-out infinite}
#orb.speaking .r2{animation-duration:4s}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes beat{50%{transform:scale(1.09)}}
@media (prefers-reduced-motion:reduce){#orb i{animation:none!important}}
#log{flex:1;overflow-y:auto;padding:8px 18px;display:flex;flex-direction:column;gap:10px}
.m{max-width:86%;padding:10px 14px;border:1px solid var(--line);border-radius:14px;background:var(--panel);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);white-space:pre-wrap;overflow-wrap:anywhere}
.m.ai{align-self:flex-start;border-left:3px solid var(--accent);border-top-left-radius:4px}
.m.me{align-self:flex-end;border-right:3px solid var(--listen);border-top-right-radius:4px}
form{display:flex;gap:8px;padding:10px 18px 14px}
input{flex:1;min-width:0;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:99px;padding:12px 18px;font:inherit;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent)}
button.send{background:var(--accent);color:var(--bg);border:0;border-radius:99px;padding:0 20px;font:600 15px "Chakra Petch",sans-serif;box-shadow:0 0 18px var(--glow)}
#set[hidden]{display:none}
#set{position:fixed;inset:0;background:var(--bg);z-index:5;overflow-y:auto;padding:calc(env(safe-area-inset-top,0px) + 18px) 18px 24px;max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
#set label{display:flex;flex-direction:column;gap:6px;color:var(--dim);font-size:14px}
#set select,#set textarea{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit}
#set textarea{min-height:120px;resize:vertical}
#set button{border-radius:99px;padding:12px;font:600 16px "Chakra Petch",sans-serif;border:1px solid var(--line);background:var(--panel);color:var(--text)}
#set #ok{background:var(--accent);color:var(--bg);border:0}
</style>
</head>
<body>
<header><h1>J.A.R.V.I.S</h1><div class="hd"><span id="status">Hazır</span><button id="gear" type="button">Ayarlar</button></div></header>
<section id="set" hidden>
<h1>Ayarlar</h1>
<label>Konuşma dili<select id="sl"><option value="tr-TR">Türkçe</option><option value="ja-JP">日本語</option><option value="en-US">English</option></select></label>
<label>Ses hızı<input id="sr" type="range" min="0.7" max="1.4" step="0.1" value="1"></label>
<label>JARVIS'e özel talimatların<textarea id="sx" placeholder="Örnek: Bana adımla hitap et. Cevapların çok kısa olsun."></textarea></label>
<button id="ok" type="button">Kaydet</button>
<button id="rp" type="button">Şifreyi sil</button>
</section>
<div class="stage"><button id="orb" type="button" aria-label="Konuşmaya başla"><i class="r1"></i><i class="r2"></i><i class="r3"></i><span>KONUŞ</span></button></div>
<div id="log" aria-live="polite"></div>
<form id="f"><input id="t" placeholder="Yaz ya da Konuş'a bas" autocomplete="off"><button class="send" type="submit">Gönder</button></form>
<script>
var log=document.getElementById('log'),orb=document.getElementById('orb'),st=document.getElementById('status'),inp=document.getElementById('t');
var LANG='tr-TR',msgs=[],S={lang:'tr-TR',extra:'',rate:1};
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
function setState(s,label){orb.className=s;st.textContent=label}

function speak(text){
  if(!('speechSynthesis' in window))return setState('','Hazır');
  speechSynthesis.cancel();
  var u=new SpeechSynthesisUtterance(text);u.lang=LANG;u.rate=S.rate;
  u.onstart=function(){setState('speaking','Konuşuyor')};
  u.onend=u.onerror=function(){setState('','Hazır')};
  speechSynthesis.speak(u);
}

async function handle(text){
  text=text.trim();if(!text)return;
  add('me',text);setState('','Düşünüyor');
  try{var r=await getReply(text);add('ai',r);speak(r)}
  catch(e){add('ai',e.message||'Yanıt alınamadı. Bağlantını kontrol edip tekrar dene.');setState('','Hazır')}
}

document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();var v=inp.value;inp.value='';handle(v)});

var SR=window.SpeechRecognition||window.webkitSpeechRecognition,rec=null,on=false;
orb.addEventListener('click',function(){
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
var set=document.getElementById('set');
document.getElementById('gear').onclick=function(){document.getElementById('sl').value=S.lang;document.getElementById('sx').value=S.extra;document.getElementById('sr').value=S.rate;set.hidden=false};
document.getElementById('ok').onclick=function(){S={lang:document.getElementById('sl').value,extra:document.getElementById('sx').value.slice(0,1000),rate:parseFloat(document.getElementById('sr').value)};LANG=S.lang;try{localStorage.setItem('jarvis_set',JSON.stringify(S))}catch(e){}set.hidden=true;add('ai','Ayarlar kaydedildi.')};
document.getElementById('rp').onclick=function(){try{localStorage.removeItem('jarvis_pass')}catch(e){}set.hidden=true;add('ai','Şifre silindi. Sonraki mesajda yeniden sorulacak.')};
add('ai','Merhaba, ben JARVIS. Konuş düğmesine bas ya da yaz.');
</script>
</body>
</html>`;
