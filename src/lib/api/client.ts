// The API client of the website (task WEB01). Every call to the JewelVault API goes through here; nothing else in the site calls `fetch`.
//
// What it promises, with the spec line each rule comes from:
//   - the address is NEXT_PUBLIC_API_URL and nothing else (H4); only that origin is ever called; the cookie travels with every call (`credentials: 'include'`, U12) and
//     JavaScript never sees it; nothing is kept in the browser (C8): no business data, no storage, no cookie code;
//   - every state-changing call carries `X-JV-Client: web` (A12, S8); a call with a body says `Content-Type: application/json`, a call without one says nothing about it
//     (an empty body that claims to be JSON is a 422), so `logout` and `activity` send none;
//   - a function of section 10 (X1 to X12 except X7) carries an `Idempotency-Key`, made ONCE per call and sent again on every retry of that call, inside the client or by
//     the person pressing Save again (the key is on the error: `error.idempotencyKey`) (L5, C5, C6);
//   - money and weight go out and come in as decimal TEXT (S3): a JS number in a money or weight field is refused before any call, and an answer that has one is an error;
//   - every error is an `ApiError` with the S8 code, the HTTP status, the details and the request id, and a plain message from one map (C13): a refusal before any write
//     says that nothing was changed; JV_INTERNAL, and a JV_BUSY that fails again, say "Could not confirm that this was saved." and call the re-read hook (C17);
//   - a JV_BUSY is retried ONCE, with the same key, after the Retry-After the API names (S8);
//   - a gateway error, or any reply that is not JSON (an idle app being started, H7), is "Waking up": the call is retried 1, 2, 4, 8 and 15 seconds later, 30 seconds in all,
//     with the same key (C7). A network failure is "Offline" at once and is not retried here; the poller backs off 8, 16, then 30 seconds (`nextPollDelayMs`);
//   - `me` carries the SHA-256 of the API's pricing.ts; it is compared with the build's own, and a mismatch means Save on bills stays off (C12);
//   - a 401 runs the hook of the session gate (U6), except the wrong password of the login screen;
//   - a call that saves data tells, when it is over (it worked or it did not), whoever asked to hear it (`onWriteFinished`): the poller of WEB04 polls at once after any write
//     the screen made (C4);
//   - a photo goes up as the raw bytes of a file (`upload`, WEB06): the body is the Blob and `Content-Type` is its picture type, never JSON; the address of a photo to show is
//     `photoUrl`, on the API's origin (P2, P3).
//
// The module keeps no state of its own besides the connection banner and the pricing check; the session itself (who is signed in) is authStore's (WEB02).
import { NOTHING_WRITTEN, NOT_ACTIVE_MESSAGE, plainMessage, type MessageOptions } from './errorMap';
import { BUILD_PRICING_SHA256 } from './pricingHash';
import {
  ERROR_CODES,
  type ErrorBody,
  type LoginResponse,
  type MeResponse,
  type OkResponse,
  type PollRequest,
  type PollResponse,
  type SyncPage,
  type SyncResource,
  type SyncRows,
} from './types';

// ------------------------------------------------------------------------------------------------ constants

/** 1, 2, 4, 8 and 15 seconds: the waits between the tries of a call while the app wakes up. They add up to the 30 seconds of C7. */
export const WAKING_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;
/** The wait after the first, the second and every later failed poll (C7). */
export const POLL_BACKOFF_MS = [8000, 16000, 30000] as const;
/** The wait between two polls when all is well (C4: every 8 seconds). */
export const POLL_INTERVAL_MS = 8000;
/** The longest one try may take: longer than the API's own 25-second timer, shorter than the host's cut at about 60 seconds (NODE-DESIGN 4.0). */
export const REQUEST_TIMEOUT_MS = 45_000;

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);
const BUSY_RETRY_MIN_MS = 1000;
const BUSY_RETRY_MAX_MS = 5000;
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** How long to wait before the next poll after `failures` failed polls in a row (C7: 8, 16, then 30 seconds; none: the normal interval). */
export function nextPollDelayMs(failures: number): number {
  if (!(failures > 0)) return POLL_INTERVAL_MS;
  return POLL_BACKOFF_MS[Math.min(Math.floor(failures), POLL_BACKOFF_MS.length) - 1];
}

// ------------------------------------------------------------------------------------------------ the plain messages (C13)

// The map itself is src/lib/api/errorMap.ts (WEB11): one place for every code of S8, also read by the pure helpers of the screens. It is re-exported here, where it always was.
export { NOT_ACTIVE_MESSAGE, plainMessage, type MessageOptions };

export interface UnconfirmedSave {
  method: string;
  path: string;
  error: ApiError;
  /** The customer whose bills and receipts the screen should read again (what the call said in `context`). */
  customerId?: string;
}

export interface ApiErrorInit {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string | null;
  idempotencyKey?: string | null;
  retryAfterS?: number | null;
  write: boolean;
}

/**
 * Everything the screens need to know about a failed call. `message` is the plain message for the person (C13); `code` is the S8 code, or one of the client's own:
 * NETWORK (no answer), GATEWAY (a gateway that stays down) and BAD_RESPONSE (an answer that is not in the agreed shape).
 */
export class ApiError extends Error {
  readonly code: string;
  /** The HTTP status, or 0 when no answer arrived. */
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  /** The key of the call, to send again when the person retries the same action. */
  readonly idempotencyKey: string | null;
  /** Seconds, from `Retry-After` (JV_RATE_LIMITED). */
  readonly retryAfterS: number | null;
  /** Refused before any write: nothing was changed. */
  readonly nothingChanged: boolean;
  /** A call that saves data and whose outcome is not known: the screen must read again before it lets the person key it a second time. */
  readonly unconfirmed: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
    this.idempotencyKey = init.idempotencyKey ?? null;
    this.retryAfterS = init.retryAfterS ?? null;
    this.nothingChanged = NOTHING_WRITTEN.has(init.code);
    this.unconfirmed = init.write && !this.nothingChanged && init.code !== 'JV_UNAVAILABLE';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

// ------------------------------------------------------------------------------------------------ money and weight are text (S3)

/**
 * The names of the fields that hold money, a rate or a weight, in what the API takes and gives (the DECIMAL columns of the schema, the derived figures of V1 to V4, the
 * inputs of the functions). A JS number under one of these names is refused: it cannot carry a trailing zero and loses digits above 2^53. Counts (quantity, line_no,
 * item_count, stones, kundan, pricing_version) are not here: they are whole numbers.
 */
// prettier-ignore
export const WIRE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  // money and rates
  'amount', 'silver_rate', 'discount', 'additional_charges', 'round_off', 'gst_percent', 'gst_amount', 'grand_total', 'subtotal', 'tax_rate', 'tax_amount',
  'metal_rate', 'labour_rate', 'labour_amount', 'piroi', 'other_charges', 'metal_amount', 'item_total', 'list_metal_rate', 'list_labour_rate', 'rate_per_gram',
  'labour_retail', 'labour_semi', 'labour_wholesale', 'billed', 'total_purchases', 'received', 'refunded', 'allocated', 'outstanding', 'advance', 'balance',
  'pending', 'dues', 'debit', 'credit', 'money_in', 'money_out', 'net', 'advance_applied', 'advance_remaining',
  // weights
  'gross_weight', 'customer_net_weight', 'original_net_weight', 'stone_weight', 'kundan_weight', 'fine_weight_due', 'fine_grams', 'grams', 'fine_due', 'fine_settled',
  'fine_pending', 'fine_billed', 'fine_received', 'fine_allocated', 'fine_outstanding', 'fine_advance', 'fine_balance', 'fine_debit', 'fine_credit', 'fine_remaining',
]);

/** Fields that hold JSON of the owner's own (a settings value, an audit row's before and after): free-form, not money. */
const FREE_FORM_FIELDS: ReadonlySet<string> = new Set(['value', 'details', 'old_row', 'new_row']);

/**
 * The path of the first value that breaks the rule of S3 (`items[0].metal_rate`), or null. Going out: a number in a money or weight field, a fraction, NaN or Infinity
 * anywhere. Coming in: a number in a money or weight field.
 */
function findWireNumber(
  value: unknown,
  key: string | null,
  at: string,
  outgoing: boolean
): string | null {
  if (typeof value === 'number') {
    if (key !== null && WIRE_TEXT_FIELDS.has(key)) return at;
    if (outgoing && !Number.isInteger(value)) return at;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findWireNumber(value[i], key, `${at}[${i}]`, outgoing);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) {
      if (FREE_FORM_FIELDS.has(name)) continue;
      const found = findWireNumber(inner, name, at === '' ? name : `${at}.${name}`, outgoing);
      if (found !== null) return found;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ small helpers

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A random UUID v4: the id of a new design and of its photos (P2, C11), and the Idempotency-Key. The page makes no other id. */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A new Idempotency-Key: a random UUID v4. One per user action (C6); make it when the action starts and keep it until the action ends. */
export const newIdempotencyKey = newUuid;

const abortError = () => new DOMException('The call was cancelled.', 'AbortError');

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[^.]+\.localhost)$/;

/** The one origin the client calls, from the text given or the variable: an origin only, https except on this computer. */
function originFrom(text: string | undefined): string {
  const given = (text ?? '').trim();
  if (given === '') {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set: this build does not know where the server is. Set it to the origin of the API, for example https://billing-api.example.com.'
    );
  }
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not an address. It must be an origin like https://billing-api.example.com.'
    );
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOST.test(url.hostname));
  if (
    !secure ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== ''
  ) {
    throw new Error(
      'NEXT_PUBLIC_API_URL must be an origin like https://billing-api.example.com: https (http only on this computer), no path, no query.'
    );
  }
  return url.origin;
}

/** The variable of the build (H4). The only place the client reads the environment; Next.js replaces exactly this text at build time. */
function addressOfTheBuild(): string | undefined {
  return process.env.NEXT_PUBLIC_API_URL;
}

function retryDelayMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  const wanted = Number.isFinite(seconds) ? seconds * 1000 : BUSY_RETRY_MIN_MS;
  return Math.min(Math.max(wanted, BUSY_RETRY_MIN_MS), BUSY_RETRY_MAX_MS);
}

function errorBodyOf(body: unknown): ErrorBody | null {
  if (body === null || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return null;
  const { code, message, details } = error as Record<string, unknown>;
  if (typeof code !== 'string') return null;
  const requestId = (body as { request_id?: unknown }).request_id;
  return {
    error: {
      code,
      message: typeof message === 'string' ? message : '',
      details:
        details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {},
    },
    request_id: typeof requestId === 'string' ? requestId : '',
  };
}

type Reply =
  | { kind: 'json'; body: unknown }
  | { kind: 'empty' }
  /** not JSON: an HTML page of a proxy, plain text, a body cut off half way */
  | { kind: 'other' };

async function readReply(response: Response, signal: AbortSignal): Promise<Reply> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: 'other' };
  }
  if (text.trim() === '') return { kind: 'empty' };
  try {
    const body: unknown = JSON.parse(text);
    if (body !== null && typeof body === 'object') return { kind: 'json', body };
  } catch {
    // not JSON
  }
  return { kind: 'other' };
}

// ------------------------------------------------------------------------------------------------ the client

/** The banner of C7: 'waking' is "Waking up…", 'offline' is "Offline: changes cannot be saved", 'ok' is no banner. */
export type ConnectionStatus = 'ok' | 'waking' | 'offline';

/** The words of the banner (C7), or null for none. Every Save control is disabled while there is one. */
export const CONNECTION_BANNER: Readonly<Record<ConnectionStatus, string | null>> = {
  ok: null,
  waking: 'Waking up…',
  offline: 'Offline: changes cannot be saved',
};

/** C12: is the API's pricing.ts the one this build was made from? */
export type PricingCheck =
  | { state: 'unknown' }
  | { state: 'match' }
  | { state: 'mismatch'; apiHash: string | null; buildHash: string };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Added to the address as the query string (undefined and null are left out). */
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
  /** The body is the raw bytes of a file (a photo, API17): sent as they are with this `Content-Type`, not as JSON. Not with `body`. */
  bytes?: { data: Blob; contentType: string };
  /**
   * The call saves no business data: a poll, a quote, a read, the session calls. Its failures never say "saved" and never trigger the re-read. A POST of this kind still needs
   * X-JV-Client, and is retried on JV_BUSY like any other.
   */
  readOnly?: boolean;
  /** The call is a function of section 10 (X1 to X12 except X7): it carries an Idempotency-Key, made here once. */
  idempotent?: boolean;
  /** The key of an earlier try of the same user action (`error.idempotencyKey`): the retry by hand sends it again. Implies `idempotent`. */
  idempotencyKey?: string;
  /** What to read again if the outcome cannot be confirmed. */
  context?: { customerId?: string };
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApiClientConfig {
  /** The origin of the API. Default: NEXT_PUBLIC_API_URL of the build, read at the first call. */
  baseUrl?: string;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  /** For tests. Default: the hash of src/lib/pricing.ts this build was made from. */
  buildPricingSha256?: string;
}

interface FailInit {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  requestId?: string | null;
  retryAfterS?: number | null;
  /** The API's own sentence, used for the two codes whose sentence says what is wrong. */
  serverMessage?: string;
}

export interface SyncPageOptions {
  updatedAfter?: string;
  afterKey?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function createApiClient(config: ApiClientConfig = {}) {
  const fetchFn: typeof fetch = config.fetch ?? ((...args) => globalThis.fetch(...args));
  const sleep = config.sleep ?? defaultSleep;
  const defaultTimeout = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const buildHash = (config.buildPricingSha256 ?? BUILD_PRICING_SHA256).toLowerCase();
  let origin: string | null = config.baseUrl === undefined ? null : originFrom(config.baseUrl);

  // ---- the banner (C7)
  let connection: ConnectionStatus = 'ok';
  const connectionListeners = new Set<() => void>();
  function setConnection(next: ConnectionStatus): void {
    if (connection === next) return;
    connection = next;
    for (const listener of Array.from(connectionListeners)) listener();
  }

  // ---- the pricing check (C12)
  let pricing: PricingCheck = { state: 'unknown' };
  const pricingListeners = new Set<() => void>();
  function setPricing(apiHash: string | null): void {
    const next: PricingCheck =
      apiHash !== null && apiHash.toLowerCase() === buildHash
        ? { state: 'match' }
        : { state: 'mismatch', apiHash, buildHash };
    const same =
      pricing.state === next.state &&
      (pricing.state !== 'mismatch' ||
        (next.state === 'mismatch' && pricing.apiHash === next.apiHash));
    if (same) return;
    pricing = next;
    for (const listener of Array.from(pricingListeners)) listener();
  }

  // ---- the hooks
  const unauthorizedHooks = new Set<(error: ApiError) => void>();
  const unconfirmedHooks = new Set<(save: UnconfirmedSave) => void>();
  const writeFinishedHooks = new Set<(value: undefined) => void>();
  function runHooks<T>(hooks: Set<(value: T) => void>, value: T, what: string): void {
    for (const hook of Array.from(hooks)) {
      try {
        hook(value);
      } catch (error) {
        console.warn(`A ${what} hook failed`, error);
      }
    }
  }

  /**
   * One call, with everything the client promises. `sent` is set at the first try that leaves for the server, so that a call refused before any I/O (a bad path, a number in a
   * money field) is not taken for a write that happened.
   */
  async function request<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const trace = { sent: false };
    try {
      return await attempt<T>(method, path, options, trace);
    } finally {
      // C4: the screen polls at once after any write it made, whatever became of it (a failed write may still have changed something). A read, a poll and the
      // session calls save nothing and are not one.
      if (trace.sent && method !== 'GET' && options.readOnly !== true)
        runHooks(writeFinishedHooks, undefined, 'write-finished');
    }
  }

  async function attempt<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    trace: { sent: boolean }
  ): Promise<T> {
    // ---- everything that can be wrong with the CALLER is found before any I/O
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('/../') ||
      path.includes('\\')
    ) {
      throw new Error(
        `The path of an API call must start with a single "/" and stay on the API's origin (got "${path}").`
      );
    }
    const base = origin ?? (origin = originFrom(addressOfTheBuild()));
    const keyGiven = options.idempotencyKey;
    if (keyGiven !== undefined && !UUID_TEXT.test(keyGiven)) {
      throw new Error('The Idempotency-Key must be a UUID (made by newIdempotencyKey).');
    }
    const write = method !== 'GET' && options.readOnly !== true;
    const key = keyGiven ?? (options.idempotent ? newIdempotencyKey() : null);
    let payload: string | Blob | undefined;
    if (options.bytes !== undefined) {
      if (options.body !== undefined)
        throw new Error('A call has a JSON body or the bytes of a file, not both.');
      payload = options.bytes.data;
    } else if (options.body !== undefined) {
      const offending = findWireNumber(options.body, null, '', true);
      if (offending !== null) {
        throw new TypeError(
          `The field "${offending}" is a number. Money and weight go to the server as text, for example "6920.00" or "35.420", and counts as whole numbers (S3).`
        );
      }
      payload = JSON.stringify(options.body);
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) query.set(name, String(value));
    }
    const queryText = query.toString();
    const url = `${base}${path}${queryText === '' ? '' : `?${queryText}`}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-JV-Client'] = 'web';
    if (key !== null) headers['Idempotency-Key'] = key;
    if (options.bytes !== undefined) headers['Content-Type'] = options.bytes.contentType;
    else if (payload !== undefined) headers['Content-Type'] = 'application/json';

    const fail = (init: FailInit): ApiError => {
      const error = new ApiError({
        ...init,
        message: plainMessage(init.code, {
          write,
          serverMessage: init.serverMessage,
          details: init.details,
        }),
        write,
        idempotencyKey: key,
      });
      if (error.unconfirmed || error.code === 'JV_INTERNAL' || !KNOWN_CODES.has(error.code)) {
        // The detail goes to the console only (C13): the code, the status and the request id, never the body of the call.
        console.warn('API call failed', {
          method,
          path,
          status: error.status,
          code: error.code,
          requestId: error.requestId,
        });
      }
      if (error.unconfirmed) {
        runHooks(
          unconfirmedHooks,
          { method, path, error, customerId: options.context?.customerId },
          'unconfirmed-save'
        );
      }
      return error;
    };

    let busyRetried = false;
    let wakingTries = 0;
    for (;;) {
      if (options.signal?.aborted) throw abortError();

      // ---- one try, with its own time limit; the caller's signal cancels it too
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? defaultTimeout);
      const onOuterAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onOuterAbort, { once: true });
      let response: Response;
      let reply: Reply;
      try {
        trace.sent = true;
        response = await fetchFn(url, {
          method,
          headers,
          body: payload,
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        reply = await readReply(response, controller.signal);
      } catch (cause) {
        if (options.signal?.aborted) throw cause; // the caller changed its mind: not the server's fault, the banner stays as it is
        setConnection('offline');
        throw fail({
          code: 'NETWORK',
          status: 0,
          details: { reason: timedOut ? 'timeout' : 'network' },
        });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOuterAbort);
      }

      const status = response.status;
      const body = reply.kind === 'json' ? reply.body : null;
      const apiError = errorBodyOf(body);
      const requestId = apiError?.request_id || response.headers.get('x-request-id') || null;

      // ---- success
      if (status >= 200 && status < 300) {
        if (reply.kind === 'json') {
          const offending = findWireNumber(reply.body, null, '', false);
          if (offending !== null) {
            setConnection('ok');
            throw fail({ code: 'BAD_RESPONSE', status, requestId, details: { field: offending } });
          }
          setConnection('ok');
          return reply.body as T;
        }
        if (reply.kind === 'empty' && (status === 204 || status === 205)) {
          setConnection('ok');
          return undefined as T;
        }
        // a success that is not JSON is a proxy's page: handled below as "Waking up"
      }

      // ---- a gateway error, or a reply that is not JSON: the app is being started (C7)
      const notFromTheApi =
        apiError === null && (reply.kind !== 'json' || GATEWAY_STATUSES.has(status));
      if (notFromTheApi) {
        setConnection('waking');
        if (wakingTries < WAKING_BACKOFF_MS.length) {
          await sleep(WAKING_BACKOFF_MS[wakingTries], options.signal);
          wakingTries += 1;
          continue;
        }
        throw fail({ code: 'GATEWAY', status, requestId });
      }
      if (apiError === null) {
        // JSON, but not our error body and not a gateway status: not the API we know
        setConnection('ok');
        throw fail({ code: 'BAD_RESPONSE', status, requestId });
      }

      // ---- the API answered with an S8 body
      const { code, message, details } = apiError.error;
      setConnection(code === 'JV_UNAVAILABLE' ? 'offline' : 'ok');
      if (code === 'JV_BUSY' && !busyRetried) {
        busyRetried = true;
        await sleep(retryDelayMs(response.headers.get('retry-after')), options.signal);
        continue;
      }
      const retryHeader = response.headers.get('retry-after');
      const error = fail({
        // a code the screens do not know keeps its name and is treated like JV_INTERNAL (C13)
        code,
        status,
        details,
        requestId,
        serverMessage: message,
        retryAfterS:
          retryHeader !== null && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) : null,
      });
      if (status === 401 && code !== 'JV_BAD_LOGIN')
        runHooks(unauthorizedHooks, error, 'unauthorized');
      throw error;
    }
  }

  const client = {
    request,
    get: <T>(path: string, options: RequestOptions = {}) => request<T>('GET', path, options),
    post: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
      request<T>('POST', path, { ...options, body }),
    put: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
      request<T>('PUT', path, { ...options, body }),
    patch: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
      request<T>('PATCH', path, { ...options, body }),

    /**
     * `PUT` of the raw bytes of a file (a photo: `/v1/designs/{design_id}/photos/{photo_id}?kind=full|thumb`, API17). The body is the Blob, its `type` is the `Content-Type`
     * (a Blob with no type goes as application/octet-stream, which the API reads by the first bytes). It carries no Idempotency-Key: a photo is insert-only and a second try of
     * the same id is answered `409 JV_NOT_ALLOWED` with `details.reason: 'duplicate'`.
     */
    upload: <T>(
      path: string,
      data: Blob,
      options: { query?: RequestOptions['query']; signal?: AbortSignal } = {}
    ) =>
      request<T>('PUT', path, {
        query: options.query,
        signal: options.signal,
        bytes: { data, contentType: data.type || 'application/octet-stream' },
      }),
    /** The address of a photo to show: `GET /v1/photos/{id}/full` or `/thumb` on the API's origin (public, no session: P3). The id must be a UUID. */
    photoUrl: (photoId: string, kind: 'full' | 'thumb'): string => {
      if (!UUID_TEXT.test(photoId)) throw new Error('A photo id is a UUID.');
      const base = origin ?? (origin = originFrom(addressOfTheBuild()));
      return `${base}/v1/photos/${photoId.toLowerCase()}/${kind}`;
    },

    // ---- the session calls (NODE-DESIGN 2.5). They change no business data, so a failure never says "saved".
    login: (email: string, password: string) =>
      request<LoginResponse>('POST', '/v1/auth/login', {
        body: { email, password },
        readOnly: true,
      }),
    me: async (options: { signal?: AbortSignal } = {}) => {
      const me = await request<MeResponse>('GET', '/v1/auth/me', options);
      setPricing(me.pricing_sha256 ?? null);
      return me;
    },
    /** No body and no Content-Type: an empty body that claims to be JSON is a 422. */
    logout: () => request<OkResponse>('POST', '/v1/auth/logout', { readOnly: true }),
    activity: () => request<OkResponse>('POST', '/v1/auth/activity', { readOnly: true }),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<LoginResponse>('POST', '/v1/auth/change-password', {
        body: { current_password: currentPassword, new_password: newPassword },
      }),

    // ---- the read side (C3, C4)
    syncPage: <R extends SyncResource>(resource: R, options: SyncPageOptions = {}) =>
      request<SyncPage<SyncRows[R]>>('GET', `/v1/sync/${resource}`, {
        query: {
          updated_after: options.updatedAfter,
          after_key: options.afterKey,
          limit: options.limit,
        },
        signal: options.signal,
      }),
    poll: (
      cursors: PollRequest['cursors'],
      limit?: number,
      options: { signal?: AbortSignal } = {}
    ) =>
      request<PollResponse>('POST', '/v1/sync/poll', {
        body: { limit, cursors },
        readOnly: true,
        signal: options.signal,
      }),

    // ---- the banner of C7
    getConnectionStatus: (): ConnectionStatus => connection,
    subscribeConnection: (listener: () => void) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },

    // ---- the pricing check of C12
    getPricingCheck: (): PricingCheck => pricing,
    subscribePricing: (listener: () => void) => {
      pricingListeners.add(listener);
      return () => {
        pricingListeners.delete(listener);
      };
    },
    /** Save on bills is on only when the API's pricing.ts is the build's (C12). Before `me` has answered it is off. */
    savingBillsAllowed: (): boolean => pricing.state === 'match',

    // ---- the hooks
    /** Any 401 except the wrong password of the login screen (U6): the session gate empties memory, stops the pollers and shows the login screen once. */
    onUnauthorized: (hook: (error: ApiError) => void) => {
      unauthorizedHooks.add(hook);
      return () => {
        unauthorizedHooks.delete(hook);
      };
    },
    /** A call that saves data ended without a confirmed answer (C13): read that customer's bills and receipts again (C17). */
    onUnconfirmedSave: (hook: (save: UnconfirmedSave) => void) => {
      unconfirmedHooks.add(hook);
      return () => {
        unconfirmedHooks.delete(hook);
      };
    },
    /** A call that saves data is over, however it ended (C4): the poller polls at once. Runs once for the call, not for each of its tries. */
    onWriteFinished: (hook: () => void) => {
      writeFinishedHooks.add(hook);
      return () => {
        writeFinishedHooks.delete(hook);
      };
    },
  };
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The client of the site: one per page load, its address read from NEXT_PUBLIC_API_URL at the first call. */
export const api: ApiClient = createApiClient();
