// Minimal client for POST /v1/systemone with exponential backoff on 408/429/5xx/529.
// Mirrors the SDK's default RetryPolicy (2 retries, 500ms initial, 5s max, honors Retry-After).
// A plain fetch is used instead of @typesafe-ai/sdk so nothing needs bundling into a
// service worker and there is no Node env-var lookup.
//
// Two hosts speak this protocol: TypeSafe itself and OpenRouter's System One API, which
// takes the same request body and returns the same answers. The host is looked up from
// PROVIDER_INFO and cannot be passed in, so no setting can send the key elsewhere.

import { PROVIDER_INFO, type EntryType, type Provider, type Questions, type SystemOneRequest, type SystemOneResponse } from "./types.ts";

export interface ClientOptions {
  provider: Provider;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class TypeSafeError extends Error {
  readonly status?: number;
  readonly requestId?: string;
  readonly body?: unknown;
  constructor(message: string, status?: number, requestId?: string, body?: unknown) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

function retryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const s = headers.get("retry-after");
  if (s && Number.isFinite(Number(s))) return Number(s) * 1000;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function systemOne(
  opts: ClientOptions,
  state: EntryType,
  questions: Questions,
): Promise<SystemOneResponse> {
  const { label, baseUrl } = PROVIDER_INFO[opts.provider];
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new TypeSafeError(`Missing ${label} API key. Add it in the extension options.`);
  if (!Object.keys(questions).length) throw new TypeSafeError("No questions to ask.");

  const url = `${baseUrl}/v1/systemone`;
  const body: SystemOneRequest = { state, model: opts.model, questions };
  const payload = JSON.stringify(body);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
      const requestId =
        res.headers.get("x-typesafe-request-id") ?? res.headers.get("x-generation-id") ?? res.headers.get("request-id") ?? undefined;
      if (res.ok) {
        return (await res.json()) as SystemOneResponse;
      }
      let errBody: unknown;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text().catch(() => undefined);
      }
      const err = new TypeSafeError(describeStatus(res.status, errBody, label), res.status, requestId, errBody);
      if (!RETRY_STATUSES.has(res.status) || attempt === maxRetries) throw err;
      lastError = err;
      const serverDelay = retryAfterMs(res.headers);
      await sleep(serverDelay !== undefined ? Math.min(serverDelay, 60_000) : backoff(attempt));
    } catch (e) {
      if (e instanceof TypeSafeError) throw e;
      // network / abort
      lastError = e;
      if (attempt === maxRetries) {
        const msg = (e as Error)?.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : `Connection error: ${(e as Error)?.message ?? e}`;
        throw new TypeSafeError(msg);
      }
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new TypeSafeError("Request failed");
}

function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 5000);
  const jitter = base * 0.25 * Math.random();
  return base - jitter;
}

/** Error detail from either host: TypeSafe sends `{detail}`, OpenRouter `{error: {message}}`. */
function errorDetail(body: unknown): string {
  if (body && typeof body === "object") {
    if ("detail" in body) return JSON.stringify((body as { detail: unknown }).detail).slice(0, 300);
    const msg = (body as { error?: { message?: unknown } }).error?.message;
    if (typeof msg === "string") return msg.slice(0, 300);
  }
  return typeof body === "string" ? body.slice(0, 300) : "";
}

function describeStatus(status: number, body: unknown, label: string): string {
  const detail = errorDetail(body);
  switch (status) {
    case 401:
      return `401 Unauthorized: invalid ${label} API key.`;
    case 402:
      return `402 Payment required: the ${label} account has no credits left. ${detail}`;
    case 403:
      return `403 Forbidden: this key is not allowed to call the API. ${detail}`;
    case 422:
      return `422 Unprocessable: the request failed validation. ${detail}`;
    case 429:
      return `429 Rate limited by ${label}.`;
    case 529:
      return `529 ${label} is overloaded.`;
    default:
      return `HTTP ${status} from ${label}. ${detail}`;
  }
}

/** TypeSafe's GET /v1/models, used by the options page "Test key" button. */
export async function listModels(opts: Pick<ClientOptions, "apiKey" | "fetchImpl">) {
  const { label, baseUrl } = PROVIDER_INFO.typesafe;
  const res = await (opts.fetchImpl ?? fetch)(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${opts.apiKey.trim()}` } });
  if (!res.ok) throw new TypeSafeError(describeStatus(res.status, await res.text().catch(() => ""), label), res.status);
  return (await res.json()) as { models: { name: string; description: string; release_date: string }[] };
}

/** Subset of OpenRouter's GET /api/v1/key response that the key test looks at. */
export interface OpenRouterKeyInfo {
  label: string;
  /** Credit limit in USD, null = unlimited. */
  limit: number | null;
  limit_remaining: number | null;
  /** USD spent with this key so far. */
  usage: number;
  is_free_tier: boolean;
}

/**
 * OpenRouter's GET /api/v1/key, used by the "Test key" button.
 *
 * OpenRouter's /v1/models has a different shape from TypeSafe's (the TypeSafe SDK rejects
 * it), and a model list proves little anyway: the key endpoint says whether the key is
 * valid AND whether it can still pay for requests.
 */
export async function openRouterKeyInfo(opts: Pick<ClientOptions, "apiKey" | "fetchImpl">): Promise<OpenRouterKeyInfo> {
  const { label, baseUrl } = PROVIDER_INFO.openrouter;
  const res = await (opts.fetchImpl ?? fetch)(`${baseUrl}/v1/key`, { headers: { Authorization: `Bearer ${opts.apiKey.trim()}` } });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new TypeSafeError(describeStatus(res.status, body, label), res.status);
  }
  return ((await res.json()) as { data: OpenRouterKeyInfo }).data;
}

/** ~3,500 input tokens at Jev 1.13's input price, rounded up. Only used for openRouterKeyVerdict's estimate. */
const EST_COST_PER_POST_USD = 0.00015;
/** Fewer posts of headroom than this, and "Test key" warns instead of just confirming. */
const LOW_LIMIT_POSTS = 1000;

/**
 * Turn a valid key's info into the verdict the options page shows after "Test key".
 *
 * Reaching this function means OpenRouter accepted the key. What is left to decide is
 * whether that key can actually run the filter: Jev is a paid model, so a key without
 * credit fails on the first post with a 402, long after the user closed the options.
 *
 * Only what the key itself reveals is judged. `limit` is the key's own spending cap, not
 * the account balance; the balance endpoint (GET /credits) accepts management keys only,
 * so an unlimited key on an empty account cannot be detected here and the message says so.
 */
export function openRouterKeyVerdict(info: OpenRouterKeyInfo): { ok: boolean; message: string } {
  if (info.limit_remaining !== null && info.limit_remaining <= 0) {
    return {
      ok: false,
      message: `Key is valid, but its spending limit is used up ($${usd(info.usage)} of $${usd(info.limit ?? 0)}). Raise it at openrouter.ai/settings/keys.`,
    };
  }
  if (info.is_free_tier) {
    return {
      ok: false,
      message: "Key is valid, but it is a free-tier key. Jev is a paid model, so every post would fail with 402. Add credits at openrouter.ai/settings/credits.",
    };
  }
  if (info.limit_remaining === null) {
    return { ok: true, message: "Key works. It has no spending limit; the account balance is not visible to this test." };
  }
  const posts = Math.floor(info.limit_remaining / EST_COST_PER_POST_USD);
  const left = `$${usd(info.limit_remaining)} left on this key's limit, roughly ${posts.toLocaleString("en-US")} posts`;
  return { ok: true, message: posts < LOW_LIMIT_POSTS ? `Key works, but only ${left}.` : `Key works: ${left}.` };
}

function usd(v: number): string {
  return v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2);
}
