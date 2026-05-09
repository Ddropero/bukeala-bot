import type { Env } from "./env";

/**
 * Durable Object pinned to "enam" (Eastern North America = us-east). All
 * fetches to Bukeala route through here so they egress from a US Cloudflare
 * datacenter, bypassing the AMS WAF rule that blocks European traffic.
 *
 * The DO is a transparent forwarder: it just calls fetch() with the request
 * as-is. We use it as a "geographic relay".
 */
export class BukealaProxy {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // redirect: "manual" — the caller wants to inspect 302s itself.
    return fetch(request, { redirect: "manual" });
  }
}
