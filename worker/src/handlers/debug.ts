import type { Context } from "hono";
import type { Env } from "../env";
import { Bukeala, SessionExpiredError } from "../bukeala";
import { loadSession } from "../kv";

/**
 * /debug/<resource>?token=<CAPTURE_TOKEN>&...
 *
 * Returns the raw response from Bukeala for inspection. Use this once to
 * confirm the actual JSON shape and finish parsing in telegram.ts.
 */
export async function handleDebug(c: Context<{ Bindings: Env }>) {
  if (c.req.query("token") !== c.env.CAPTURE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const resource = c.req.param("resource");
  const b = new Bukeala(c.env);

  try {
    let res: Response;
    switch (resource) {
      case "branches":
        res = await b.loadBranches();
        break;
      case "components":
        res = await b.loadComponents();
        break;
      case "areaHints": {
        const code = c.req.query("componentCode");
        if (!code) return c.json({ error: "componentCode required" }, 400);
        res = await b.loadAreaHints(code);
        break;
      }
      case "search": {
        const startDateStr = c.req.query("date") ?? todayDDMMYYYY();
        const componentCode = c.req.query("componentCode");
        if (!componentCode) return c.json({ error: "componentCode required" }, 400);
        res = await b.doSearch({ startDateStr, componentCodes: [componentCode] });
        break;
      }
      case "customer": {
        const idType = c.req.query("type") ?? "1";
        const id = c.req.query("id");
        if (!id) return c.json({ error: "id required" }, 400);
        res = await b.findCustomer(idType, id);
        break;
      }
      case "selectCustomer": {
        const idType = c.req.query("type") ?? "1";
        const id = c.req.query("id");
        if (!id) return c.json({ error: "id required" }, 400);
        res = await b.selectCustomer(idType, id);
        break;
      }
      case "changeUserType": {
        const planId = c.req.query("planId") ?? "";
        res = await b.changeUserTypeSelected(planId);
        break;
      }
      case "findAvailability":
        res = await b.findAvailabilityPage();
        break;
      case "findCustomerPage":
        res = await b.findCustomerPage();
        break;
      case "doPage": {
        const startDateStr = c.req.query("date") ?? todayDDMMYYYY();
        const componentCode = c.req.query("componentCode");
        if (!componentCode) return c.json({ error: "componentCode required" }, 400);
        res = await b.findAvailabilityDoPage({
          componentCodes: [componentCode],
          startDateStr,
        });
        break;
      }
      case "warmup": {
        // Hit the static landing pages to let the WAF set its cookies
        // and the ALB set sticky-session cookies. Best-effort.
        const r1 = await b.findCustomerPage();
        await r1.text();
        return c.json({ warmupStatus: r1.status });
      }
      case "renew": {
        const ok = await b.renewSession();
        return c.json({ renewed: ok });
      }
      case "inspect": {
        const s = await loadSession(c.env);
        if (!s) return c.json({ session: null });
        return c.json({
          session: {
            capturedAt: s.capturedAt,
            cookieCount: s.cookies.length,
            cookies: s.cookies.map((k) => ({
              name: k.name,
              domain: k.domain,
              httpOnly: k.httpOnly ?? false,
              valueLen: k.value.length,
            })),
          },
        });
      }
      case "myBookings":
        res = await b.myBookings(c.req.query("historial") === "true");
        break;
      case "cancelationReasons":
        res = await b.cancelationReasons();
        break;
      default:
        return c.json({ error: "unknown resource" }, 400);
    }

    const text = await res.text();
    const headers: Record<string, string> = {
      "content-type": res.headers.get("content-type") ?? "text/plain",
      "x-bukeala-status": String(res.status),
    };
    const loc = res.headers.get("location");
    if (loc) headers["x-bukeala-location"] = loc;
    return new Response(text, { status: res.status, headers });
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      return c.json({ error: "session_expired" }, 401);
    }
    return c.json({ error: (e as Error).message }, 500);
  }
}

function todayDDMMYYYY(): string {
  const d = new Date();
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function pad2(n: number) {
  return String(n).padStart(2, "0");
}
