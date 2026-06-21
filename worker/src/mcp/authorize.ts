/**
 * Pantalla de consentimiento OAuth para el MCP (single-user).
 *
 * OAuthProvider implementa /token y /register; el endpoint /authorize lo
 * implementa la app. Como solo lo usa el Dr. Duque, en vez de un IdP externo
 * usamos un gate por contraseña (secret MCP_PASSWORD). Al validar, emitimos la
 * autorización con props {user:"david"}.
 *
 * Flujo:
 *   GET  /authorize  → muestra formulario (lleva la petición OAuth codificada)
 *   POST /authorize  → valida contraseña → completeAuthorization → redirect
 */
import type { Hono } from "hono";
import type { Env } from "../env";

function consentPage(encodedReq: string, error?: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar agenda · Dr. David Duque</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f3a3a;color:#f5efe0;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#11403f;border:1px solid #1f5e5c;border-radius:16px;padding:32px;max-width:360px;width:90%}
  h1{font-size:18px;margin:0 0 4px} p{font-size:13px;color:#bcd3cf;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2b6f6c;
        background:#0c3231;color:#f5efe0;font-size:15px;margin-bottom:14px}
  button{width:100%;padding:12px;border:0;border-radius:10px;background:#d8b25a;color:#0c2b2b;
         font-weight:600;font-size:15px;cursor:pointer}
  .err{background:#5e1f1f;color:#ffd9d9;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:12px}
  .brand{font-size:12px;color:#8fb3ae;margin-top:16px;text-align:center}
</style></head>
<body><form class="card" method="POST" action="/authorize">
  <h1>Conectar agenda</h1>
  <p>Autoriza a Claude a gestionar la agenda del Dr. David Duque.</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <input type="password" name="password" placeholder="Contraseña de acceso" autofocus required>
  <input type="hidden" name="req" value="${encodedReq}">
  <button type="submit">Autorizar</button>
  <div class="brand">David Duque · Cirugía Plástica</div>
</form></body></html>`;
}

export function registerMcpAuthRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/authorize", async (c) => {
    let info: any;
    try {
      info = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch {
      return c.text("Solicitud OAuth inválida o incompleta.", 400);
    }
    if (!info || !info.clientId) return c.text("Solicitud OAuth inválida.", 400);
    const encoded = btoa(JSON.stringify(info));
    return c.html(consentPage(encoded));
  });

  app.post("/authorize", async (c) => {
    const body = await c.req.parseBody();
    const password = String(body.password ?? "");
    const encoded = String(body.req ?? "");
    if (!encoded) return c.text("Falta la solicitud OAuth.", 400);

    const expected = c.env.MCP_PASSWORD ?? "";
    if (!expected || password !== expected) {
      return c.html(consentPage(encoded, "Contraseña incorrecta."), 401);
    }

    let info: any;
    try { info = JSON.parse(atob(encoded)); } catch { return c.text("Solicitud corrupta.", 400); }

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "david",
      metadata: { label: "Dr. David Duque" },
      scope: info.scope ?? [],
      props: { user: "david" },
    });
    return c.redirect(redirectTo, 302);
  });
}
