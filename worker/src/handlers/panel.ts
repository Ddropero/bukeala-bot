/**
 * Panel visual en vivo — `GET /panel?token=<CAPTURE_TOKEN>`.
 *
 * La versión "vendible" del dashboard: una sola página que se ve como producto
 * y muestra DATOS REALES. A diferencia del panel del competidor (que pinta
 * datos simulados en el mismo navegador), este hace fetch cada 20 s a los
 * endpoints reales del Worker:
 *   - /api/agenda?days=2      → citas de hoy y mañana + confirmaciones
 *   - /debug/session-stats    → sesión viva, cola, captchas del día
 *
 * El token viaja en la URL del panel y el JS lo reusa para esos fetches (mismo
 * patrón que el /dashboard clásico, que reenvía el token a sus links).
 *
 * Es de solo lectura: no agenda ni cancela nada, así que sirve igual como panel
 * de operación del día y como demo para mostrarle el sistema a un colega.
 */
import type { Context } from "hono";
import type { Env } from "../env";

export async function handlePanel(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = c.req.query("token") ?? "";
  const marca = (c.env as any).PANEL_BRAND || "Dr. David Duque · Cirugía Plástica";
  // ?date=DD-MM-YYYY opcional: ver un día concreto (o demostrar con uno que
  // tenga citas). Sin él, el panel muestra hoy y mañana.
  const date = /^\d{2}-\d{2}-\d{4}$/.test(c.req.query("date") ?? "") ? c.req.query("date")! : "";
  return c.html(
    PAGE.replace("__TOKEN__", token).replace("__MARCA__", escapeHtml(marca)).replace("__DATE__", date),
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PAGE = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Panel · Agenda IA</title>
<style>
  :root{
    --bg:#0b1220; --bg2:#0f1a2e; --card:#131f36; --card2:#182742;
    --line:#243350; --txt:#e8eefc; --muted:#8ea3c7; --dim:#5f7599;
    --teal:#2dd4bf; --green:#34d399; --amber:#fbbf24; --red:#f87171;
    --blue:#60a5fa; --violet:#a78bfa;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(1200px 600px at 80% -10%,#16233f 0%,var(--bg) 55%);
    color:var(--txt);-webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:1180px;margin:0 auto;padding:20px 18px 60px}
  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
  .logo{width:42px;height:42px;border-radius:12px;flex:0 0 auto;
    background:linear-gradient(135deg,var(--teal),var(--blue));
    display:grid;place-items:center;font-size:22px;box-shadow:0 6px 22px rgba(45,212,191,.28)}
  .brand b{font-size:16px;letter-spacing:.2px}
  .brand span{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
  .live{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--muted)}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}
  .dot.on{background:var(--green);box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:pulse 2s infinite}
  .dot.bad{background:var(--red);animation:none}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 8px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
  .kpi{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);
    border-radius:16px;padding:14px 16px;position:relative;overflow:hidden}
  .kpi .n{font-size:30px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
  .kpi .l{color:var(--muted);font-size:12px;margin-top:7px}
  .kpi .ico{position:absolute;top:12px;right:12px;font-size:16px;opacity:.5}
  .kpi.g .n{color:var(--green)} .kpi.b .n{color:var(--blue)}
  .kpi.a .n{color:var(--amber)} .kpi.t .n{color:var(--teal)}

  .grid{display:grid;grid-template-columns:1.35fr 1fr;gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
  .card h2{margin:0;padding:14px 16px;font-size:13.5px;letter-spacing:.3px;
    border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px;color:var(--txt)}
  .card h2 .tag{margin-left:auto;font-weight:400;font-size:11.5px;color:var(--dim)}
  .body{padding:6px 0}

  .cita{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid rgba(36,51,80,.5)}
  .cita:last-child{border-bottom:0}
  .hora{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px;width:64px;flex:0 0 auto;color:var(--txt)}
  .quien{flex:1;min-width:0}
  .quien .nm{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .quien .sub{color:var(--dim);font-size:11.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .estado{flex:0 0 auto;font-size:11px;font-weight:600;padding:4px 9px;border-radius:999px;white-space:nowrap}
  .e-si{background:rgba(52,211,153,.14);color:var(--green)}
  .e-no{background:rgba(248,113,113,.14);color:var(--red)}
  .e-pend{background:rgba(251,191,36,.13);color:var(--amber)}
  .e-conf{background:rgba(96,165,250,.14);color:var(--blue)}

  .rowline{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(36,51,80,.5)}
  .rowline:last-child{border-bottom:0}
  .rowline .k{color:var(--muted);font-size:12.5px;display:flex;align-items:center;gap:9px}
  .rowline .v{font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}
  .v.ok{color:var(--green)} .v.warn{color:var(--amber)} .v.bad{color:var(--red)}

  .bar{height:8px;border-radius:999px;background:var(--line);overflow:hidden;margin:10px 16px 4px}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--teal),var(--green));width:0;transition:width .6s ease}
  .barlbl{display:flex;justify-content:space-between;padding:0 16px 12px;color:var(--dim);font-size:11.5px}

  .empty{padding:26px 16px;text-align:center;color:var(--dim);font-size:13px}
  .foot{margin-top:20px;text-align:center;color:var(--dim);font-size:11.5px}
  .spin{animation:sp 1s linear infinite;display:inline-block}@keyframes sp{to{transform:rotate(360deg)}}
  @media(max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">🩺</div>
    <div class="brand"><b>Agenda IA</b><span>__MARCA__</span></div>
    <div class="live"><span id="dot" class="dot"></span><span id="live-txt">conectando…</span></div>
  </header>

  <section class="kpis" id="kpis">
    <div class="kpi t"><div class="n" id="k-hoy">–</div><div class="l">Citas hoy</div><div class="ico">📅</div></div>
    <div class="kpi g"><div class="n" id="k-conf">–</div><div class="l">Confirmadas</div><div class="ico">✅</div></div>
    <div class="kpi a"><div class="n" id="k-pend">–</div><div class="l">Por confirmar</div><div class="ico">📞</div></div>
    <div class="kpi b"><div class="n" id="k-man">–</div><div class="l">Citas mañana</div><div class="ico">🗓️</div></div>
  </section>

  <div class="grid">
    <div class="card">
      <h2>👥 Agenda de hoy <span class="tag" id="fecha-hoy"></span></h2>
      <div class="body" id="lista-hoy"><div class="empty">Cargando…</div></div>
    </div>

    <div>
      <div class="card" style="margin-bottom:14px">
        <h2>⚙️ Estado del sistema <span class="tag">24/7</span></h2>
        <div class="body" id="sistema"><div class="empty">Cargando…</div></div>
      </div>
      <div class="card">
        <h2>🤖 Renovación de sesión <span class="tag">hoy</span></h2>
        <div class="bar"><i id="bar-free"></i></div>
        <div class="barlbl"><span id="lbl-free">– sin captcha</span><span id="lbl-cap">– con captcha</span></div>
      </div>
    </div>
  </div>

  <div class="foot" id="foot">—</div>
</div>

<script>
(function(){
  var TOKEN="__TOKEN__";
  var DATE="__DATE__"; // "" = hoy/mañana; "DD-MM-YYYY" = ese día y el siguiente
  var $=function(id){return document.getElementById(id)};
  var esc=function(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};

  function estadoBadge(c){
    if(c.confirmacionWa==="si"||c.estado==="confirmada") return '<span class="estado e-si">✅ Confirmó</span>';
    if(c.confirmacionWa==="no") return '<span class="estado e-no">❌ No asiste</span>';
    if(c.estado==="atendida") return '<span class="estado e-conf">Atendida</span>';
    return '<span class="estado e-pend">Por llamar</span>';
  }

  function pintarAgenda(dia){
    $("fecha-hoy").textContent = dia? (dia.fechaLegible||"") : "";
    var cont=$("lista-hoy");
    if(!dia||!dia.citas||dia.citas.length===0){cont.innerHTML='<div class="empty">Sin citas para hoy 🎉</div>';return;}
    cont.innerHTML=dia.citas.map(function(c){
      var nombre=c.paciente||c.nombre||"—";
      var doc=c.documento||c.cedula||"";
      var tel=c.telefono?("📞 "+esc(c.telefono)):"sin teléfono";
      var sub=[esc(doc),tel].filter(Boolean).join(" · ");
      return '<div class="cita"><div class="hora">'+esc(c.hora||"")+'</div>'+
        '<div class="quien"><div class="nm">'+esc(nombre)+'</div><div class="sub">'+sub+'</div></div>'+
        estadoBadge(c)+'</div>';
    }).join("");
  }

  function fila(k,v,cls){return '<div class="rowline"><div class="k">'+k+'</div><div class="v '+(cls||"")+'">'+v+'</div></div>'}

  function pintarSistema(st,alive){
    var s=$("sistema");
    var ses=st&&st.session;
    var cola=st?st.pendingQueue:null;
    var rc=(st&&st.renewCounters&&st.renewCounters[hoyISO()])||{};
    var html="";
    html+=fila("🟢 Bukeala en línea", alive? "Sí":"Revisando…", alive?"ok":"warn");
    html+=fila("🔑 Sesión", ses?("hace "+ses.ageMin+" min"):"—", ses?"ok":"bad");
    html+=fila("⏳ Pacientes en cola", cola==null?"—":cola, cola?"warn":"ok");
    var errs=rc["error"]||0;
    html+=fila("⚠️ Errores hoy", errs, errs?"warn":"ok");
    s.innerHTML=html;

    var free=(rc["ok:alive"]||0)+(rc["ok:tgc"]||0);
    var cap=(rc["ok:captcha"]||0)+(rc["ok:captcha-fallback"]||0);
    var tot=free+cap||1;
    $("bar-free").style.width=Math.round(free/tot*100)+"%";
    $("lbl-free").textContent=free+" sin captcha";
    $("lbl-cap").textContent=cap+" con captcha";
  }

  function hoyISO(){
    // Hoy en Bogotá (UTC-5), como YYYY-MM-DD — así casa con las llaves del server.
    var d=new Date(Date.now()-5*3600*1000);
    return d.toISOString().slice(0,10);
  }

  function setLive(ok){
    $("dot").className="dot "+(ok?"on":"bad");
    $("live-txt").textContent=ok?"en vivo":"sin conexión";
  }

  async function jget(path){
    var r=await fetch(path+(path.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(TOKEN)+"&_="+Date.now());
    if(!r.ok) throw new Error(path+" → "+r.status);
    return r.json();
  }

  async function tick(){
    try{
      var agUrl="/api/agenda?days=2"+(DATE?("&date="+DATE):"");
      var res=await Promise.all([
        jget(agUrl).catch(function(){return null}),
        jget("/debug/session-stats").catch(function(){return null}),
        jget("/debug/measure").catch(function(){return null})
      ]);
      var ag=res[0], st=res[1], me=res[2];
      var alive=!!(me&&me.alive);

      var hoy = ag&&ag.dias&&ag.dias[0];
      var man = ag&&ag.dias&&ag.dias[1];
      $("k-hoy").textContent = hoy? hoy.total : "0";
      $("k-conf").textContent = hoy? hoy.confirmadas : "0";
      $("k-pend").textContent = hoy? hoy.sinConfirmar : "0";
      $("k-man").textContent = man? man.total : "0";
      pintarAgenda(hoy);
      pintarSistema(st,alive);

      // Si la agenda vino como 503 la sesión está temporalmente caída.
      var agBien = !!(ag&&ag.dias);
      setLive(agBien||alive);
      $("foot").textContent="Actualizado "+new Date().toLocaleTimeString("es-CO")+" · se refresca solo cada 20 s";
    }catch(e){
      setLive(false);
      $("foot").textContent="Error de conexión — reintentando…";
    }
  }

  tick();
  setInterval(tick,20000);
})();
</script>
</body>
</html>`;
