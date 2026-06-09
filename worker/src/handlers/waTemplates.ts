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

export async function handleListTemplates(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const { id: waba, debug } = await getWabaId(c.env, c.req.query("waba"));
  if (!waba) return c.json({ error: "no se pudo derivar WABA id", debug }, 500);
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba}/message_templates?fields=name,status,category,language&limit=100&access_token=${encodeURIComponent(c.env.WA_TOKEN)}`,
  );
  const data = await res.json<any>().catch(() => ({}));
  const list = (data?.data ?? []).map((t: any) => ({ name: t.name, status: t.status, category: t.category, language: t.language }));
  return c.json({ waba, count: list.length, templates: list });
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
      name: "confirmar_cita",
      language: "es",
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
      language: "es",
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
