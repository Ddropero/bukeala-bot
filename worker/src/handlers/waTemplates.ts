/**
 * Crea/lista plantillas de WhatsApp vía la Graph API (sin tocar el navegador).
 *
 * Endpoints:
 *   GET /wa/templates?token=..            → lista las plantillas existentes
 *   GET /wa/templates/create?token=..     → crea confirmar_cita + appointment_reminder
 *
 * Deriva el WABA (WhatsApp Business Account) ID desde el phone number ID.
 */
import type { Context } from "hono";
import type { Env } from "../env";

const API_VERSION = "v21.0";

/** Obtiene el WABA ID. Intenta varias vías + permite override por query. */
async function getWabaId(env: Env, override?: string): Promise<{ id: string | null; debug: any }> {
  if (override) return { id: override, debug: { source: "override" } };
  const debug: any = {};

  // Vía 0 (la buena): el WABA id que Meta manda en cada webhook, guardado por
  // whatsappWebhook.ts. Es autoritativo — es LA WABA del número que envía — y
  // no depende de permisos del token, que es justo lo que bloqueaba las vías
  // 1 y 2 (el token no puede derivarlo ni enumerar negocios).
  try {
    const fromWebhook = await env.STATE.get("wa:wabaId");
    if (fromWebhook) return { id: fromWebhook, debug: { source: "webhook" } };
    debug.via0 = "sin wa:wabaId en KV (aún no ha llegado ningún mensaje entrante)";
  } catch (e) { debug.via0err = (e as Error).message; }

  // Vía 1: campo whatsapp_business_account del phone
  try {
    const r1 = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${env.WA_PHONE_ID}?fields=whatsapp_business_account&access_token=${encodeURIComponent(env.WA_TOKEN)}`,
    );
    const d1 = await r1.json<any>().catch(() => ({}));
    debug.via1 = d1;
    if (d1?.whatsapp_business_account?.id) return { id: d1.whatsapp_business_account.id, debug };
  } catch (e) { debug.via1err = (e as Error).message; }

  // Vía 2: debug_token → granular_scopes suele listar el WABA id
  try {
    const r2 = await fetch(
      `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${encodeURIComponent(env.WA_TOKEN)}&access_token=${encodeURIComponent(env.WA_TOKEN)}`,
    );
    const d2 = await r2.json<any>().catch(() => ({}));
    debug.via2scopes = d2?.data?.granular_scopes;
    const scopes = d2?.data?.granular_scopes ?? [];
    for (const s of scopes) {
      if (
        (s.scope === "whatsapp_business_messaging" || s.scope === "whatsapp_business_management") &&
        Array.isArray(s.target_ids) && s.target_ids.length
      ) {
        return { id: s.target_ids[0], debug };
      }
    }
  } catch (e) { debug.via2err = (e as Error).message; }

  return { id: null, debug };
}

/**
 * Lista las plantillas desde Meta. Reusable por el endpoint HTTP y por el
 * comando de Telegram /wa_templates. Devuelve el WABA usado + las plantillas
 * con su CÓDIGO DE IDIOMA real (clave para diagnosticar el 132001).
 */
export async function listTemplates(
  env: Env,
  override?: string,
): Promise<{ waba: string | null; templates: Array<{ name: string; status: string; language: string; category?: string }>; debug: any }> {
  const { id: waba, debug } = await getWabaId(env, override);
  if (!waba) return { waba: null, templates: [], debug };
  const res = await fetch(
    // SIN `fields`: Meta devuelve por defecto name/language/status/category y
    // **components** (con `fields=...,components` los omite — probado).
    `https://graph.facebook.com/${API_VERSION}/${waba}/message_templates?limit=100&access_token=${encodeURIComponent(env.WA_TOKEN)}`,
  );
  const data = await res.json<any>().catch(() => ({}));
  const templates = (data?.data ?? []).map((t: any) => {
    const comps = t.components ?? [];
    const body = comps.find((x: any) => x.type === "BODY");
    const buttons = comps.find((x: any) => x.type === "BUTTONS");
    // nº de parámetros {{n}} que espera el BODY — clave para no mandar de más
    // o de menos (Meta rechaza con 132000 si no coinciden).
    const params = body?.text ? (body.text.match(/\{\{\d+\}\}/g) ?? []).length : 0;
    return {
      name: t.name, status: t.status, category: t.category, language: t.language,
      params,
      buttons: (buttons?.buttons ?? []).map((b: any) => `${b.type}:${b.text}`),
    };
  });
  return { waba, templates, debug };
}

export async function handleListTemplates(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const { waba, templates, debug } = await listTemplates(c.env, c.req.query("waba"));
  if (!waba) return c.json({ error: "no se pudo derivar WABA id", debug }, 500);
  return c.json({ waba, count: templates.length, templates });
}

/** Definiciones de las plantillas que queremos asegurar que existan. */
function templateDefs() {
  // Botones Quick Reply para confirmar_cita
  // Meta NO acepta emojis/variables/saltos en botones Quick Reply.
  const confirmButtons = {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Sí, confirmo" },
      { type: "QUICK_REPLY", text: "No podré asistir" },
    ],
  };

  return [
    {
      // OJO: es_CO, no "es". TODAS las plantillas aprobadas de esta WABA están
      // en es_CO; con "es" Meta responde 132001 (no encuentra la plantilla).
      name: "confirmar_cita",
      language: "es_CO",
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hola {{1}}, le recordamos su cita con el Dr. David Duque para el {{2}} a las {{3}} en {{4}}. ¿Podrá asistir?",
          example: { body_text: [["María", "miércoles 10/06/26", "10:30 AM", "Calle 80 # 10-43, Cons 506"]] },
        },
        confirmButtons,
      ],
    },
    {
      name: "appointment_reminder",
      language: "es_CO",
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hola {{1}}, le recordamos su cita con el Dr. David Duque:\n📅 {{2}}\n⏰ {{3}}\n📍 {{4}}\n\nSi necesita reprogramar, respóndanos por aquí.",
          example: { body_text: [["María", "miércoles 10/06/26", "10:30 AM", "Calle 80 # 10-43, Cons 506"]] },
        },
      ],
    },
  ];
}

/**
 * Sube un archivo de MUESTRA con la Resumable Upload API y devuelve el
 * `header_handle` que Meta exige para crear una plantilla con cabecera de
 * DOCUMENTO. Es un paso aparte del /media normal: este handle solo sirve para
 * crear la plantilla, no para enviar mensajes.
 */
async function uploadSampleForHeader(
  env: Env,
  bytes: Uint8Array,
  mime: string,
): Promise<{ handle: string | null; debug: any }> {
  const debug: any = {};
  try {
    // 1. app_id (el token es de sistema; debug_token lo expone)
    const t = encodeURIComponent(env.WA_TOKEN);
    const dbg = await fetch(`https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${t}&access_token=${t}`);
    const dbgJson = await dbg.json<any>().catch(() => ({}));
    const appId = dbgJson?.data?.app_id;
    debug.appId = appId;
    if (!appId) return { handle: null, debug };

    // 2. abrir sesión de subida
    const startUrl =
      `https://graph.facebook.com/${API_VERSION}/${appId}/uploads` +
      `?file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}&access_token=${t}`;
    const startRes = await fetch(startUrl, { method: "POST" });
    const startJson = await startRes.json<any>().catch(() => ({}));
    debug.start = startJson;
    const uploadId = startJson?.id;
    if (!uploadId) return { handle: null, debug };

    // 3. subir los bytes (Authorization: OAuth, no Bearer — lo exige esta API)
    const upRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${uploadId}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${env.WA_TOKEN}`, file_offset: "0" },
      body: bytes,
    });
    const upJson = await upRes.json<any>().catch(() => ({}));
    debug.upload = upJson;
    return { handle: upJson?.h ?? null, debug };
  } catch (e) {
    debug.err = (e as Error).message;
    return { handle: null, debug };
  }
}

/**
 * Crea la plantilla `agenda_secretaria`: cabecera de DOCUMENTO (el PDF de la
 * agenda) + cuerpo corto. Es la ÚNICA forma de mandarle la agenda a la
 * secretaria FUERA de la ventana de 24h, porque los parámetros de plantilla no
 * admiten saltos de línea (o sea, la lista no cabe en un parámetro).
 */
export async function handleCreateAgendaTemplate(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const { id: waba, debug: wabaDebug } = await getWabaId(c.env, c.req.query("waba"));
  if (!waba) return c.json({ error: "no se pudo derivar WABA id", debug: wabaDebug }, 500);

  // PDF de muestra (contenido irrelevante, solo define el tipo de cabecera)
  const { buildAgendaPdf } = await import("../agendaPdf");
  const sample = buildAgendaPdf("Agenda de muestra", [{ text: "1.  08:00 AM   Paciente Ejemplo" }]);
  const { handle, debug: upDebug } = await uploadSampleForHeader(c.env, sample, "application/pdf");
  if (!handle) return c.json({ error: "no se pudo subir el PDF de muestra", debug: upDebug }, 500);

  const body = {
    name: "agenda_secretaria",
    language: "es_CO",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "DOCUMENT", example: { header_handle: [handle] } },
      {
        type: "BODY",
        text: "Hola {{1}}, te envío la agenda del {{2}}. Son {{3}} citas: por favor confirma llamando a cada paciente y marca las que confirmen.",
        example: { body_text: [["Laura", "miércoles 05/08/26", "7"]] },
      },
    ],
  };
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${waba}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.env.WA_TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await res.json<any>().catch(() => ({}));
  return c.json({ waba, ok: res.ok, status: res.status, respuesta: data });
}

export async function handleCreateTemplates(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const { id: waba, debug } = await getWabaId(c.env, c.req.query("waba"));
  if (!waba) return c.json({ error: "no se pudo derivar WABA id", debug }, 500);

  // ¿Cuáles ya existen? (para no duplicar)
  const existRes = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba}/message_templates?fields=name&limit=200&access_token=${encodeURIComponent(c.env.WA_TOKEN)}`,
  );
  const existData = await existRes.json<any>().catch(() => ({}));
  const existing = new Set((existData?.data ?? []).map((t: any) => t.name));

  const results: any[] = [];
  for (const def of templateDefs()) {
    if (existing.has(def.name)) {
      results.push({ name: def.name, skipped: "ya existe" });
      continue;
    }
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${waba}/message_templates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.env.WA_TOKEN}` },
        body: JSON.stringify(def),
      },
    );
    const data = await res.json<any>().catch(() => ({}));
    results.push({
      name: def.name,
      ok: res.ok,
      status: res.status,
      id: data?.id,
      templateStatus: data?.status,
      error: data?.error?.error_user_msg ?? data?.error?.message,
    });
  }
  return c.json({ waba, results, note: "Las creadas quedan en revisión de Meta (~24-48h)." });
}
