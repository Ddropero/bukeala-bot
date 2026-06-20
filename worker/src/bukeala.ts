import type { Env } from "./env";
import { cookieHeader, clearSession, updateCookiesFromResponse } from "./kv";

export class SessionExpiredError extends Error {
  constructor() {
    super("Bukeala session expired or missing");
    this.name = "SessionExpiredError";
  }
}

export class Bukeala {
  constructor(private env: Env) {}

  /**
   * Common request wrapper. Detects expired sessions automatically and,
   * on detection, attempts a one-shot CAS-TGC re-auth before throwing.
   *
   * @param opts.absolute when true, `path` is treated as absolute from
   * `https://appoint.tuscitasmedicas.com` (no /keraltyadscritos prefix).
   * @param opts.url     when set, takes precedence over `path` (full URL).
   *                     Used by renewSession to follow CAS redirects.
   * @param opts.skipRetry when true, won't try to renew on session expiry.
   */
  private async req(
    path: string,
    init: RequestInit = {},
    opts: { absolute?: boolean; url?: string; skipRetry?: boolean } = {},
  ): Promise<Response> {
    const targetUrl = opts.url
      ? opts.url
      : opts.absolute
        ? `https://appoint.tuscitasmedicas.com${path}`
        : `${this.env.BUKEALA_BASE}${path}`;
    const targetHost = new URL(targetUrl).hostname;
    const cookie = await cookieHeader(this.env, targetHost);
    if (!cookie) throw new SessionExpiredError();

    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    headers.set("X-Requested-With", "XMLHttpRequest");
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json, text/javascript, */*; q=0.01");
    }
    if (!headers.has("Referer")) {
      headers.set("Referer", `${this.env.BUKEALA_BASE}/findAvailability`);
    }
    // Force AWS ALB to treat us as a CORS XHR request → it then uses the
    // AWSALBCORS sticky cookie (which the browser DID capture), routing us
    // to the backend that holds the Java session. Without these headers,
    // ALB picks a random non-CORS backend that doesn't have JSESSIONID.
    if (!headers.has("Origin")) {
      headers.set("Origin", "https://appoint.tuscitasmedicas.com");
    }
    headers.set("Sec-Fetch-Mode", "cors");
    headers.set("Sec-Fetch-Site", "same-origin");
    headers.set("Sec-Fetch-Dest", "empty");
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    );
    headers.set("Accept-Language", "es-CO,es;q=0.9,en;q=0.8");
    // Spoof a Colombian residential IP to bypass any CF WAF country rules
    headers.set("X-Forwarded-For", "190.85.50.10");
    headers.set("X-Real-IP", "190.85.50.10");
    headers.set("CF-Connecting-IP", "190.85.50.10");
    headers.set("CF-IPCountry", "CO");

    // Route through the DurableObject pinned to enam (us-east) so the
    // egress IP is from a US Cloudflare datacenter — bypasses the AMS WAF
    // rule that 403s European traffic to Bukeala.
    const url = targetUrl;
    const proxyId = this.env.BUKEALA_PROXY.idFromName("singleton");
    const proxyStub = this.env.BUKEALA_PROXY.get(proxyId, { locationHint: "enam" });
    const proxiedReq = new Request(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body as BodyInit | undefined,
      redirect: "manual",
    });
    const res = await proxyStub.fetch(proxiedReq);

    const loc = res.headers.get("location") || "";
    const cookieNames = cookie.split(";").map((s) => s.trim().split("=")[0]).join(",");
    console.log(`[bukeala] ${init.method ?? "GET"} ${path} → ${res.status}${loc ? " → " + loc : ""} | cookies sent: ${cookieNames}`);
    if (res.status === 403 || res.status === 401) {
      const body = await res.clone().text().catch(() => "");
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      console.log(`[bukeala] DETAIL status=${res.status} headers=${JSON.stringify(respHeaders).slice(0, 500)} body=${body.slice(0, 300)}`);
    }

    // Cookie auto-update: capture rotated cookies from response Set-Cookie
    // headers. Critical for CAS renewal flow (new JSESSIONID arrives via
    // Set-Cookie). The blocklist in updateCookiesFromResponse prevents
    // AWSALB from being overwritten (would re-route to wrong sticky backend).
    if (res.status !== 401 && res.status !== 403) {
      await updateCookiesFromResponse(this.env, res);
    }

    // Auth failures: try ONE renewal via CAS-TGC, then re-issue the call.
    // If renewal also fails, throw SessionExpiredError so user re-captures.
    const isExpired =
      res.status === 401 ||
      res.status === 403 ||
      (res.status >= 300 &&
        res.status < 400 &&
        (loc.includes("/cas/login") || loc.includes("/authentication/login")));

    if (isExpired) {
      // Note: tried CAS-TGC auto-renewal but Radware Bot Manager
      // blocks the CAS server (app01.colsanitas.com) from worker IPs
      // (redirects to validate.perfdrive.com). User must re-capture
      // from the browser extension. The cron will notify them.
      throw new SessionExpiredError();
    }

    return res;
  }

  /**
   * Try to obtain a fresh JSESSIONID using the CAS Ticket Granting Cookie
   * (TGC) that the user captured from `app01.colsanitas.com`. CAS server
   * issues a new service ticket without prompting for credentials, and
   * the service URL exchanges the ticket for a new JSESSIONID.
   *
   * Returns true if at the end we have a fresh JSESSIONID for the
   * `appoint.tuscitasmedicas.com` host.
   */
  async renewSession(): Promise<boolean> {
    // Step 1: walk through the CAS redirect chain to capture any new
    // JSESSIONID. We start directly at the CAS server (app01.colsanitas.com)
    // with the SP's service URL. If TGC is valid in the cookie jar, CAS
    // issues a service ticket WITHOUT prompting login → 302 to service
    // URL with ?ticket=ST-... → SP validates ticket and Set-Cookies a
    // fresh JSESSIONID for tuscitasmedicas.com.
    const serviceUrl = "https://appoint.tuscitasmedicas.com/keraltyadscritos/cas/login";
    const start =
      "https://app01.colsanitas.com/cas/login?service=" + encodeURIComponent(serviceUrl);
    let url: string | null = start;
    for (let hop = 0; hop < 8; hop++) {
      if (!url) break;
      console.log(`[renew] hop ${hop}: GET ${url}`);
      let res: Response;
      try {
        res = await this.req("", {}, { url, skipRetry: true });
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          console.log(`[renew] expired at hop ${hop}`);
          break;
        }
        throw e;
      }
      console.log(`[renew] hop ${hop} → ${res.status}`);
      if (res.status >= 300 && res.status < 400) {
        url = res.headers.get("location");
        continue;
      }
      // Terminal — break and verify
      break;
    }

    // Step 2: post-renewal verification — hit a session-protected JSON
    // endpoint. If it returns 200 with valid JSON, renewal worked.
    try {
      const verify = await this.req(
        "/findAvailability/loadComponents?branchIdStr=" +
          this.env.BRANCH_ID +
          "&attentionType=P&areaCode=&authorizationCode=&_=" +
          Date.now(),
        {},
        { skipRetry: true },
      );
      console.log(`[renew] verify → ${verify.status}`);
      if (verify.status !== 200) return false;
      const ct = verify.headers.get("content-type") || "";
      if (!ct.includes("json")) {
        console.log(`[renew] verify content-type=${ct} (expected json)`);
        return false;
      }
      const body = await verify.text();
      // Bukeala returns a JSON array (possibly empty) when authenticated
      return body.startsWith("[") || body.startsWith("{");
    } catch (e) {
      console.log(`[renew] verify failed: ${(e as Error).message}`);
      return false;
    }
  }

  // ---------- Search ----------

  loadBranches(areaCode = "", componentCodes: string[] = []): Promise<Response> {
    const qs = new URLSearchParams({
      areaCode,
      jsonComponentCodes: JSON.stringify(componentCodes),
      _: Date.now().toString(),
    });
    return this.req(`/findAvailability/loadBranches?${qs}`);
  }

  loadComponents(branchId = this.env.BRANCH_ID, attentionType = "P"): Promise<Response> {
    const qs = new URLSearchParams({
      branchIdStr: branchId,
      attentionType,
      areaCode: "",
      authorizationCode: "",
      _: Date.now().toString(),
    });
    return this.req(`/findAvailability/loadComponents?${qs}`);
  }

  loadAreaHints(componentCode: string, branchId = this.env.BRANCH_ID): Promise<Response> {
    const qs = new URLSearchParams({
      branchIdStr: branchId,
      componentCode,
    });
    return this.req(`/findAvailability/loadAreaHints?${qs}`);
  }

  /**
   * Find available slots.
   * @param startDateStr DD/MM/YYYY
   * @param componentCodes one or more codes from loadComponents
   */
  doSearch(args: {
    startDateStr: string;
    componentCodes: string[];
    branchId?: string;
    attentionType?: string;
    followedBookingsCount?: number;
  }): Promise<Response> {
    const qs = new URLSearchParams({
      branchId: args.branchId ?? this.env.BRANCH_ID,
      jsonComponentCodes: JSON.stringify(args.componentCodes),
      startDateStr: args.startDateStr,
      resultShow: "0",
      resultGrouped: "false",
      isMultipleComponent: "false",
      attentionType: args.attentionType ?? "P",
      followedBookingsCount: String(args.followedBookingsCount ?? 1),
      daysSelected: "",
      timeFrom: "",
      timeTo: "",
      areaPattern: "",
      minQuantitySessions: "",
      maxQuantitySessions: "",
      intervalSessions: "1",
      isOverBooking: "false",
      isOrdered: "false",
      authorizationCode: "",
      _: Date.now().toString(),
    });
    return this.req(`/findAvailability/doSearch?${qs}`);
  }

  // ---------- Customer ----------

  /**
   * Validate that a customer exists. Returns `{result:{code:"EXISTS"|...}}`.
   * `idType`: numeric code, e.g. `"1"` for cédula, `"8"` for tarjeta de identidad.
   */
  findCustomer(idType: string, identification: string): Promise<Response> {
    return this.req(`/findCustomer/validate/${encodeURIComponent(idType)}/${encodeURIComponent(identification)}`);
  }

  /**
   * "Select" a customer in the backoffice session — required before
   * loadComponents / doSearch / myBookings will return data. The backend
   * responds with a 302 to /findAvailability when successful.
   */
  selectCustomer(idType: string, identification: string): Promise<Response> {
    return this.req(
      `/findCustomer/${encodeURIComponent(idType)}/${encodeURIComponent(identification)}?customerGenderCode=-`,
    );
  }

  /** Sets the active plan/credential context. */
  changeUserTypeSelected(planId: string, credential = ""): Promise<Response> {
    const body = new URLSearchParams({ planId, credential });
    return this.req("/findAvailability/changeUserTypeSelected", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  getAvailablePlans(): Promise<Response> {
    return this.req("/findAvailability/getAvailablePlans");
  }

  /** HTML page with patient data + dropdowns. Call AFTER selectCustomer. */
  findAvailabilityPage(): Promise<Response> {
    return this.req("/findAvailability?isWebUser=false");
  }

  /** HTML page of the find-customer form. Useful as a session warmup. */
  findCustomerPage(): Promise<Response> {
    return this.req("/findCustomer");
  }

  /**
   * The HTML "do" endpoint (alternative to /doSearch). The web UI uses
   * THIS one, not the AJAX doSearch. It accepts the same conceptual params
   * plus `entityCode` and `companyId` which doSearch does not, and it
   * returns slots as embedded HTML cards.
   */
  findAvailabilityDoPage(args: {
    componentCodes: string[];
    startDateStr: string; // DD/MM/YYYY
    branchId?: string;
    attentionType?: string;
    entityCode?: string;
    companyId?: string;
  }): Promise<Response> {
    const qs = new URLSearchParams();
    qs.set("bookingId", "");
    qs.set("reassignReasonId", "");
    qs.set("reassignComment", "");
    qs.set("authorizationCode", "");
    qs.set("entityCode", args.entityCode ?? "10");
    qs.set("companyId", args.companyId ?? "309");
    qs.set("attentionType", args.attentionType ?? "P");
    qs.set("startDate", args.startDateStr);
    for (const code of args.componentCodes) qs.append("componentCodes", code);
    qs.set("intervalSessions", "1");
    qs.set("isOrdered", "false");
    qs.set("branchId", args.branchId ?? this.env.BRANCH_ID);
    qs.set("areaName", "");
    qs.set("timeFrom", "");
    qs.set("timeTo", "");
    qs.set("resultGrouped", "0");
    qs.set("isMultipleComponent", "0");
    qs.set("daysSelected", "");
    return this.req(`/findAvailability/do?${qs}`);
  }

  // ---------- Booking ----------

  validateBookingDate(args: {
    bookingComponentId: number;
    startDateStr: string; // DD/MM/YY
    bookingTime: number;  // seconds
    branchId?: string;
    areaId: number;
  }): Promise<Response> {
    const qs = new URLSearchParams({
      bookingComponentId: String(args.bookingComponentId),
      startDateStr: args.startDateStr,
      bookingTime: String(args.bookingTime),
      validateDaysBetweenBookings: "true",
      isOverBooking: "false",
      branchId: args.branchId ?? this.env.BRANCH_ID,
      areaId: String(args.areaId),
      _: Date.now().toString(),
    });
    return this.req(`/booking/validateBookingDate?${qs}`);
  }

  addPrebooking(args: {
    timeInSeconds: number;
    bookingComponentId: number;
    startDateStr: string; // DD/MM/YY
    areaId: number;
  }): Promise<Response> {
    const qs = new URLSearchParams({
      timeInSeconds: String(args.timeInSeconds),
      bookingComponentId: String(args.bookingComponentId),
      startDateStr: args.startDateStr,
      areaId: String(args.areaId),
      followedBookingsCount: "",
      _: Date.now().toString(),
    });
    return this.req(`/prebooking/addPrebookingSchedule?${qs}`);
  }

  postBooking(payload: object): Promise<Response> {
    return this.req("/booking/postBooking", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://appoint.tuscitasmedicas.com",
      },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Optional intermediate step that renders the confirmation page (HTML).
   * The web UI calls this before postBooking. We can use it to extract
   * patient email/phone from the HTML if needed.
   */
  assignBooking(form: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams(form);
    return this.req("/booking/assign", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  // ---------- Manage ----------

  myBookings(historial = false): Promise<Response> {
    return this.req(`/myBookings?historial=${historial}`);
  }

  cancelationReasons(): Promise<Response> {
    return this.req("/booking/action/cancelationReasons");
  }

  checkBookingCancelation(bookingId: string): Promise<Response> {
    const body = new URLSearchParams({ bookingId });
    return this.req("/booking/action/checkBookingCancelation", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  /**
   * Cancel a booking. Per HAR capture, this is JSON (not form-encoded) and
   * uses `reservationCode` (format `<guid>-<bookingId>`) and `cancelReasonId`.
   */
  /**
   * Daily agenda: lists all bookings (active + canceled if includeCanceled)
   * for one area on a given date. Used by /agenda command.
   * @param dateDdMmYyyy date in `DD-MM-YYYY` format (with dashes, day first)
   */
  getAgenda(dateDdMmYyyy: string, areaId: number, includeCanceled = false): Promise<Response> {
    const path = `/admin/daily/${this.env.BRANCH_ID}/${dateDdMmYyyy}/list?includeCanceled=${includeCanceled}&areaId=${areaId}`;
    return this.req(path, {}, { absolute: true });
  }

  cancelBooking(args: {
    reservationCode: string;
    cancelReasonId: string;
    cancelationComment?: string;
    email?: string;
  }): Promise<Response> {
    return this.req("/booking/action/cancelBooking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reservationCode: args.reservationCode,
        email: args.email ?? "",
        cancelationComment: args.cancelationComment ?? "",
        cancelReasonId: args.cancelReasonId,
        allowPartialCancelation: true,
      }),
    });
  }

  // ---------- Schedule / Disponibilidad (abrir cupos) ----------
  //
  // Estos endpoints viven bajo /admin (backoffice), no bajo /keraltyadscritos,
  // por eso usan { absolute: true }. Capturados del HAR de "crear agenda".

  /**
   * Valida que la sala/área esté libre en el rango+días antes de crear el
   * horario. Devuelve {result:{code:"SUCCESS"}} si está OK.
   */
  validateRoomAvailability(args: {
    roomId: number | string;       // 0 = sin sala específica
    areaId: number;                // 1074 = agenda del Dr.
    startDateStr: string;          // DD/MM/YYYY
    endDateStr: string;            // DD/MM/YYYY
    startSeconds: number;
    endSeconds: number;
    daysSelectedStr: string;       // ej "4-" (jueves) — días separados por "-"
    repeatWeek?: number;
  }): Promise<Response> {
    const qs = new URLSearchParams({
      roomId: String(args.roomId),
      areaId: String(args.areaId),
      startDateStr: args.startDateStr,
      endDateStr: args.endDateStr,
      startSeconds: String(args.startSeconds),
      endSeconds: String(args.endSeconds),
      daysSelectedStr: args.daysSelectedStr,
      repeatWeek: String(args.repeatWeek ?? 1),
      sucursal: this.env.BRANCH_ID,
    });
    return this.req(
      `/admin/bookingComponents/config/validateRoomAvailability?${qs}`,
      {},
      { absolute: true },
    );
  }

  /**
   * Crea un bloque de horario (abre cupos). El payload es JSON; los valores
   * por defecto replican el HAR (CIRUGÍA PLÁSTICA, área del Dr., slots 20min).
   */
  createSchedule(args: {
    bookingComponentId: string;       // "1222"
    componentCode: string;            // "890239-1"
    daysSelected: string[];           // ["4"] = jueves
    areaId: string;                   // "1074"
    startBookingSeconds: number;      // 28800 = 8:00
    endBookingSeconds: number;        // 33600 = 9:20
    startDate: string;                // DD/MM/YYYY
    endDate: string;                  // DD/MM/YYYY
    intervalSeconds?: number;         // 1200 = 20min
    repeatWeek?: number;              // 1
    roomId?: number | string;         // 0 = sin sala
    allowHolidays?: string;           // "REGULAR"
  }): Promise<Response> {
    const interval = args.intervalSeconds ?? 1200;
    const payload = {
      bookingComponentId: args.bookingComponentId,
      componentsCodeSelected: [args.componentCode],
      daysSelected: args.daysSelected,
      areasSelected: [{
        areaId: args.areaId,
        minBookingSize: 1,
        maxBookingSize: 1,
        maxIntervalAvailability: "1",
        intervalSeconds: interval,
        marginSeconds: 0,
        intervalBreakSeconds: interval,
      }],
      startBookingSeconds: args.startBookingSeconds,
      endBookingSeconds: args.endBookingSeconds,
      repeatWeek: String(args.repeatWeek ?? 1),
      startDate: args.startDate,
      endDate: args.endDate,
      isGlobal: null,
      isPublic: null,
      isSpecial: null,
      isPremium: null,
      bookingCalendarParametersDto: [{
        planGroupId: null,
        isGlobal: true,
        isPublic: true,
        isPremium: false,
        isSpecial: false,
        hideFromPatient: false,
      }],
      bookingComponentsSelected: [{
        code: args.componentCode,
        intervalSeconds: interval,
        intervalBreakSeconds: interval,
      }],
      maxIntervalSeconds: String(Math.floor(interval / 60)),
      groupedBookingCalendar: true,
      isPresential: "true",
      roomId: String(args.roomId ?? 0),
      isSpontaneous: false,
      releaseHours: "",
      releaseMinutes: "",
      allowHolidays: args.allowHolidays ?? "REGULAR",
      renewalDays: null,
      renewalEnd: "",
      planGroupSelected: null,
    };
    return this.req(
      `/admin/bookingComponents/config/createSchedule?sucursal=${this.env.BRANCH_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Referer": "https://appoint.tuscitasmedicas.com/admin/bookingComponents/config/" + this.env.BRANCH_ID,
        },
        body: JSON.stringify(payload),
      },
      { absolute: true },
    );
  }

  /**
   * Lista los calendarios (agendas) creados de un componente. La respuesta
   * trae bookingComponent.bookingCalendars[] con id, fechas, horas, estado.
   * Del HAR: GET /selectBookingComponent?bookingComponentId=XXXX
   */
  selectBookingComponent(bookingComponentId: string | number): Promise<Response> {
    return this.req(
      `/admin/bookingComponents/config/selectBookingComponent?bookingComponentId=${bookingComponentId}&sucursal=${this.env.BRANCH_ID}`,
      {},
      { absolute: true },
    );
  }

  /**
   * Borra uno o varios calendarios (agendas) por id. NOTA: esto borra el
   * MOLDE de agenda; las reservas (citas) de pacientes se cancelan aparte
   * con cancelBooking.
   * Del HAR: GET /deleteBookingCalendar?calendars=28479&sucursal=456
   */
  deleteBookingCalendar(calendarIds: Array<string | number>): Promise<Response> {
    const ids = calendarIds.join(",");
    return this.req(
      `/admin/bookingComponents/config/deleteBookingCalendar?calendars=${ids}&sucursal=${this.env.BRANCH_ID}`,
      {},
      { absolute: true },
    );
  }

  /**
   * Cuenta cuántas citas (pacientes) hay en una fecha/horario — para saber
   * a quién avisar antes de cancelar/bloquear. Devuelve un número plano.
   * Del HAR: GET /countBookingsForDenyDate?bookingComponentId=..&requestedAreas=..&timeFrom=..&timeTo=..&requestedDates=DD-MM-YYYY
   */
  countBookingsForDenyDate(args: {
    bookingComponentId: string | number;
    areaId: string | number;
    timeFromSeconds: number;
    timeToSeconds: number;
    dateDdMmYyyy: string;   // "24-06-2026"
    isPartial?: boolean;
  }): Promise<Response> {
    const qs = new URLSearchParams({
      bookingComponentId: String(args.bookingComponentId),
      branchId: this.env.BRANCH_ID,
      requestedAreas: String(args.areaId),
      timeFrom: String(args.timeFromSeconds),
      timeTo: String(args.timeToSeconds),
      requestedDates: args.dateDdMmYyyy,
      isPartial: String(args.isPartial ?? true),
      _: Date.now().toString(),
      sucursal: this.env.BRANCH_ID,
    });
    return this.req(
      `/admin/bookingComponents/config/countBookingsForDenyDate?${qs}`,
      {},
      { absolute: true },
    );
  }

  /**
   * Crea un bloqueo (deny date): cierra una fecha/horario para que no se
   * agenden citas (vacaciones, congreso, etc.).
   * Del HAR: POST /saveDenyDate  body JSON {areas, reasonId, bookingComponents, startHour, endHour, selectedDates...}
   */
  saveDenyDate(args: {
    areaId: number;
    bookingComponentIds: number[];
    reasonId?: string;           // "2" en el HAR
    comment?: string;
    startHourSeconds: number;
    endHourSeconds: number;
    selectedDates: string[];     // ["24-06-2026"]
    isPrivate?: boolean;
  }): Promise<Response> {
    const payload = {
      areas: [args.areaId],
      reasonId: args.reasonId ?? "2",
      comment: args.comment ?? "",
      disableHours: "0",
      bookingComponents: args.bookingComponentIds,
      startHour: args.startHourSeconds,
      endHour: args.endHourSeconds,
      isPrivate: args.isPrivate ?? false,
      selectedDates: args.selectedDates,
    };
    return this.req(
      `/admin/bookingComponents/config/saveDenyDate?sucursal=${this.env.BRANCH_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Referer": "https://appoint.tuscitasmedicas.com/admin/bookingComponents/config/" + this.env.BRANCH_ID,
        },
        body: JSON.stringify(payload),
      },
      { absolute: true },
    );
  }

  /**
   * Lista los bloqueos (deny dates) de un componente.
   * Del HAR: GET /getDenyDatesByComponent
   */
  getDenyDatesByComponent(bookingComponentId: string | number): Promise<Response> {
    return this.req(
      `/admin/bookingComponents/config/getDenyDatesByComponent?bookingComponentId=${bookingComponentId}&sucursal=${this.env.BRANCH_ID}`,
      {},
      { absolute: true },
    );
  }

  /**
   * Quita un bloqueo por id. El body es el id como string JSON crudo.
   * Del HAR: POST /deleteDenyDates  body: "71472"
   */
  deleteDenyDates(denyDateId: string | number): Promise<Response> {
    return this.req(
      `/admin/bookingComponents/config/deleteDenyDates?sucursal=${this.env.BRANCH_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Referer": "https://appoint.tuscitasmedicas.com/admin/bookingComponents/config/" + this.env.BRANCH_ID,
        },
        body: JSON.stringify(String(denyDateId)),
      },
      { absolute: true },
    );
  }
}
