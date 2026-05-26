/**
 * Discover endpoint: usa el WA_TOKEN existente para ver qué Pages de Facebook
 * tiene el usuario, cuáles están vinculadas a Instagram Business, y si los
 * permisos del token cubren mensajería de IG.
 *
 * Esto evita que el usuario tenga que pegar IDs y tokens manualmente — si su
 * System User token ya tiene scope a IG, podemos auto-configurar todo.
 */
import type { Context } from "hono";
import type { Env } from "../env";

const API_VERSION = "v21.0";

export async function handleIgDiscover(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const wa_token = c.env.WA_TOKEN;
  if (!wa_token) {
    return c.json({ error: "WA_TOKEN no configurado" }, 500);
  }

  const result: any = {
    token_used: "WA_TOKEN (System User)",
    permissions: null,
    pages: [],
    instagram_accounts: [],
    suggested_secrets: {},
    issues: [],
  };

  // 1) Introspectar el token: app_id, scopes, expira?
  try {
    const debugRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${wa_token}&access_token=${wa_token}`,
    );
    const debug = await debugRes.json<any>();
    result.token_debug = debug?.data ?? null;
    result.permissions = debug?.data?.scopes ?? [];
    if (!result.permissions.includes("instagram_basic")) {
      result.issues.push(
        "Token NO tiene scope 'instagram_basic'. Agrégalo en Meta Business Suite → System Users → tu user → Add Assets → marca tu cuenta IG.",
      );
    }
    if (!result.permissions.includes("instagram_manage_messages")) {
      result.issues.push(
        "Token NO tiene scope 'instagram_manage_messages'. Mismo lugar.",
      );
    }
  } catch (e) {
    result.issues.push(`debug_token falló: ${(e as Error).message}`);
  }

  // 2) Listar pages que el token puede acceder
  try {
    const pagesRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me/accounts?access_token=${wa_token}`,
    );
    const pages = await pagesRes.json<any>();
    if (pages?.data) {
      result.pages = pages.data.map((p: any) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        access_token_partial: p.access_token ? p.access_token.slice(0, 20) + "..." : null,
      }));

      // 3) Para cada page, intentar resolver instagram_business_account
      for (const p of pages.data) {
        try {
          const igRes = await fetch(
            `https://graph.facebook.com/${API_VERSION}/${p.id}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${wa_token}`,
          );
          const igData = await igRes.json<any>();
          if (igData?.instagram_business_account?.id) {
            const ig = igData.instagram_business_account;
            result.instagram_accounts.push({
              page_id: p.id,
              page_name: p.name,
              instagram_business_account_id: ig.id,
              instagram_username: ig.username,
              instagram_name: ig.name,
              profile_pic: ig.profile_picture_url,
              page_access_token_partial: p.access_token ? p.access_token.slice(0, 20) + "..." : null,
            });
          }
        } catch { /* ignore */ }
      }
    } else if (pages?.error) {
      result.issues.push(`me/accounts error: ${pages.error.message}`);
    }
  } catch (e) {
    result.issues.push(`me/accounts falló: ${(e as Error).message}`);
  }

  // 4) Sugerir qué secrets setear
  if (result.instagram_accounts.length === 1) {
    const ig = result.instagram_accounts[0];
    result.suggested_secrets = {
      IG_BUSINESS_ACCOUNT_ID: ig.instagram_business_account_id,
      IG_ACCESS_TOKEN: "(usar el page_access_token de la Page o el WA_TOKEN si tiene scope)",
      IG_VERIFY_TOKEN: "(elegir un string random, ej. random_xyz_2026)",
    };
  } else if (result.instagram_accounts.length > 1) {
    result.issues.push("Múltiples cuentas IG encontradas — necesitamos elegir cuál usar.");
  } else if (result.pages.length === 0) {
    result.issues.push(
      "Token no puede acceder a NINGUNA página de FB. Significa que el System User no tiene pages asignadas. " +
      "Ve a Meta Business Suite → Configuración → Usuarios del sistema → tu user → 'Agregar activos' → marca tus Páginas de FB.",
    );
  } else {
    result.issues.push(
      "Hay pages pero ninguna está vinculada a Instagram Business. " +
      "Conecta tu IG a una Page de FB: FB Page → Configuración → Cuentas vinculadas → Instagram.",
    );
  }

  return c.json(result);
}
