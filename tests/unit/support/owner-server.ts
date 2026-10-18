// A fake of the owner's functions X4 `POST /v1/receipts/{id}/void`, X5 `POST /v1/bills/{id}/cancel`, X10 `POST /v1/bills/{id}/reissue`, X11 `POST /v1/customers/{id}/refunds` and X12
// `POST /v1/customers/{id}/opening-balance` (WEB11), spoken to through the REAL API client by a stubbed `fetch`. It keeps the rules the screen relies on and nothing else (the arithmetic is
// the API's, proved by the API's own tests and by tests/e2e/owner-actions.spec.ts): a repeat of an Idempotency-Key answers the stored result with `Idempotent-Replay: true` and makes
// nothing new, the same key with another body or another path is refused (L5), a call without the CSRF header or without a key is refused, and a role other than the owner is JV_FORBIDDEN.
//
// What the test decides is the answer: `answers(call)` returns the rows of the answer (or a refusal) for each call. What a test can do to the call: lose the answer AFTER it was saved
// (`dropAnswers`), answer a proxy's 502 page AFTER it was saved (`gatewayAfter`), refuse with an S8 code before anything is saved (`refuse`), and hold the call until the test lets it go
// (`hold`).
export interface OwnerCall {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, unknown> | undefined;
  header: Record<string, string>;
}

export type OwnerAnswer =
  | { status: number; body: unknown }
  | { refuse: { code: string; status: number; details?: Record<string, unknown> } };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const refusalResponse = (code: string, status: number, details: Record<string, unknown> = {}) =>
  json(status, {
    error: { code, message: 'made up by the test', details },
    request_id: 'req-owner',
  });
const proxyPage = () =>
  new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });

export class FakeOwnerApi {
  readonly seen: OwnerCall[] = [];
  /** key -> the path and body it was first used with, and the answer it got. */
  readonly stored = new Map<
    string,
    { path: string; body: string; status: number; answer: unknown }
  >();
  /** How many calls did real work (a repeat of a key does none). */
  made = 0;
  /** The role of the caller: only the owner may call these functions. */
  role: 'owner' | 'biller' | 'staff' = 'owner';
  dropAnswers = 0;
  /** The next N answers (a first answer or the replay of one) are a proxy's 502 page instead: after N = 6 the client's waking-up retries are used up and the call ends unconfirmed. */
  gatewayAfter = 0;
  refuse: {
    code: string;
    status: number;
    details?: Record<string, unknown>;
    times: number;
  } | null = null;
  hold: Promise<void> | null = null;

  constructor(private readonly answers: (call: OwnerCall) => OwnerAnswer) {}

  count(): number {
    return this.seen.filter((c) => c.method === 'POST').length;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const header: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      header[name.toLowerCase()] = value;
    });
    const call: OwnerCall = {
      method,
      path: url.pathname,
      key: header['idempotency-key'] ?? null,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      header,
    };
    this.seen.push(call);
    if (method !== 'POST') return refusalResponse('JV_NOT_FOUND', 404);
    if (this.hold) await this.hold;
    if (call.header['x-jv-client'] !== 'web') return refusalResponse('JV_CSRF', 403);
    if (this.role !== 'owner') return refusalResponse('JV_FORBIDDEN', 403);
    if (call.key === null || call.body === undefined)
      return refusalResponse('JV_INVALID_INPUT', 422, { field: 'idempotency_key' });
    if (this.refuse && this.refuse.times > 0) {
      this.refuse.times -= 1;
      return refusalResponse(this.refuse.code, this.refuse.status, this.refuse.details ?? {});
    }
    const text = JSON.stringify(Object.entries(call.body).sort(([a], [b]) => a.localeCompare(b)));
    const before = this.stored.get(call.key);
    if (before) {
      if (before.body !== text || before.path !== call.path)
        return refusalResponse('JV_INVALID_INPUT', 422, { field: 'idempotency_key' });
      if (this.gatewayAfter > 0) {
        this.gatewayAfter -= 1;
        return proxyPage();
      }
      return json(before.status, before.answer, { 'idempotent-replay': 'true' });
    }
    const made = this.answers(call);
    if ('refuse' in made)
      return refusalResponse(made.refuse.code, made.refuse.status, made.refuse.details);
    this.made += 1;
    this.stored.set(call.key, {
      path: call.path,
      body: text,
      status: made.status,
      answer: made.body,
    });
    if (this.dropAnswers > 0) {
      this.dropAnswers -= 1;
      throw new TypeError('Failed to fetch'); // saved, and the answer never arrives
    }
    if (this.gatewayAfter > 0) {
      this.gatewayAfter -= 1;
      return proxyPage();
    }
    return json(made.status, made.body);
  };
}
