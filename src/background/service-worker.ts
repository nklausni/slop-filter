// MV3 service worker. Owns the API keys, the per-post cache, and session stats for both
// platforms. The content script sends a PostState; this returns an Evaluation. The content
// script never sees a key: settings replies carry only `hasKey`.

import { buildQuestions, buildState } from "../shared/questions/index.ts";
import { buildEvaluation } from "../shared/scoring.ts";
import { activeKey, loadKeys, loadSettings, saveKeys, saveSettings } from "../shared/storage.ts";
import { listModels, openRouterKeyInfo, openRouterKeyVerdict, systemOne, TypeSafeError } from "../shared/typesafe.ts";
import {
  EMPTY_PLATFORM_STATS,
  EMPTY_STATS,
  PLATFORMS,
  PROVIDER_INFO,
  type Evaluation,
  type Message,
  type MessageReply,
  type Platform,
  type PostState,
  type LogEntry,
  LOG_MAX,
  type SessionStats,
  type Settings,
  type SystemOneResponse,
} from "../shared/types.ts";

const CACHE_PREFIX = "cache:";
const CACHE_MAX_ENTRIES = 800;
const RECENT_KEY = "recent";
const RECENT_MAX = 60;
const STATS_KEY = "stats";
const LOG_KEY = "log";
const MAX_IN_FLIGHT = 4;

// ---- in-flight limiter ----
let inFlight = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  inFlight++;
}
function release(): void {
  inFlight--;
  waiters.shift()?.();
}

// ---- session storage (cleared when the browser closes = "this session") ----
async function getStats(): Promise<SessionStats> {
  const got = await chrome.storage.session.get(STATS_KEY);
  const stored = (got[STATS_KEY] ?? {}) as Partial<SessionStats>;
  const byPlatform = {} as SessionStats["byPlatform"];
  for (const p of PLATFORMS) {
    byPlatform[p] = { ...EMPTY_PLATFORM_STATS, ...(stored.byPlatform?.[p] ?? {}) };
  }
  return { ...EMPTY_STATS, ...stored, byPlatform };
}
async function updateStats(mut: (s: SessionStats) => void): Promise<void> {
  const s = await getStats();
  mut(s);
  await chrome.storage.session.set({ [STATS_KEY]: s });
}
async function pushRecent(e: Evaluation): Promise<void> {
  const got = await chrome.storage.session.get(RECENT_KEY);
  const list = ((got[RECENT_KEY] ?? []) as Evaluation[]).filter((x) => x.id !== e.id);
  list.unshift(e);
  await chrome.storage.session.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) });
}

/**
 * Append one decision to the session log.
 *
 * Both feeds virtualize, so counting verdicts by scraping the DOM only ever sees the 8-13
 * posts currently mounted. This is the record that makes a real suppression rate possible.
 */
async function pushLog(entry: LogEntry): Promise<void> {
  const got = await chrome.storage.session.get(LOG_KEY);
  const list = (got[LOG_KEY] ?? []) as LogEntry[];
  list.push(entry);
  await chrome.storage.session.set({ [LOG_KEY]: list.slice(-LOG_MAX) });
}

async function getLog(): Promise<LogEntry[]> {
  const got = await chrome.storage.session.get(LOG_KEY);
  return (got[LOG_KEY] ?? []) as LogEntry[];
}

/** Highest-scoring signal or structural feature, for "why was this suppressed". */
function topDriver(e: Evaluation): string {
  const all = [...Object.entries(e.signals), ...Object.entries(e.structural)];
  if (!all.length) return "";
  return all.sort((a, b) => b[1] - a[1])[0][0];
}

// ---- cache of raw responses ----
//
// Keyed on a hash of the ACTUAL request payload — state, model and questions — rather than
// a hand-maintained list of fields. That list was wrong: removing `interests` from the
// state changed every answer while leaving the key identical, so a stale cache survived a
// change that invalidated it and the fix could only be measured after clearing by hand.
//
// Hashing the payload is complete by construction: anything that can change an answer is
// in it, and anything that cannot is not. The preset and the weights are deliberately
// absent from the request, so moving the strictness slider still re-scores cached answers
// for free — which is the property the old key was trying to preserve.
interface CacheEntry {
  response: SystemOneResponse;
  at: number;
}
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function cacheKey(post: PostState, request: unknown): string {
  return `${CACHE_PREFIX}${post.platform}:${post.id}:${hash(JSON.stringify(request))}`;
}
async function cacheGet(key: string): Promise<CacheEntry | undefined> {
  const got = await chrome.storage.session.get(key);
  return got[key] as CacheEntry | undefined;
}
async function cacheSet(key: string, entry: CacheEntry): Promise<void> {
  await chrome.storage.session.set({ [key]: entry });
  if (Math.random() < 0.05) await trimCache();
}
async function trimCache(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  keys.sort((a, b) => ((all[a] as CacheEntry).at ?? 0) - ((all[b] as CacheEntry).at ?? 0));
  await chrome.storage.session.remove(keys.slice(0, keys.length - CACHE_MAX_ENTRIES));
}
async function clearCache(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)));
}

// ---- the evaluation itself ----
async function evaluate(post: PostState): Promise<Evaluation> {
  const settings = await loadSettings();
  const provider = settings.provider;
  const model = settings.models[provider];
  const apiKey = await activeKey(provider);
  if (!apiKey.trim()) throw new TypeSafeError(`No ${PROVIDER_INFO[provider].label} API key set. Open the extension options.`);

  const text = post.text.slice(0, settings.maxPostChars);
  const trimmed: PostState = {
    ...post,
    text,
    quotedText: post.quotedText.slice(0, settings.maxPostChars),
  };
  // Build the request first so the cache key can be derived from it.
  const state = buildState(trimmed, settings.interests, settings.excludedTopics);
  const questions = buildQuestions(post.platform, settings.interests, settings.excludedTopics, settings.aiStyleMode !== "off");
  const key = cacheKey(post, { state, model, questions });
  const cached = await cacheGet(key);

  let response: SystemOneResponse;
  let fromCache = false;
  if (cached) {
    response = cached.response;
    fromCache = true;
  } else {
    await acquire();
    try {
      response = await systemOne({ provider, apiKey, model }, state as never, questions);
    } finally {
      release();
    }
    await cacheSet(key, { response, at: Date.now() });
  }

  const evaluation = buildEvaluation(
    trimmed,
    response,
    settings.interests,
    settings.excludedTopics,
    settings.platforms[post.platform].preset,
    settings.highlightInterests,
    fromCache,
    settings.aiStyleMode,
  );

  await updateStats((s) => {
    const ps = s.byPlatform[post.platform];
    if (!fromCache) {
      ps.evaluated++;
      ps.inputTokens += evaluation.inputTokens;
      const cost = response.usage?.cost;
      if (typeof cost === "number" && Number.isFinite(cost)) ps.costUsd += cost;
      else ps.unpricedTokens += evaluation.inputTokens;
      s.lastModel = evaluation.model;
    } else {
      ps.cacheHits++;
    }
  });
  await pushRecent(evaluation);
  await pushLog({
    t: evaluation.evaluatedAt,
    p: post.platform,
    v: evaluation.verdict,
    s: Number(evaluation.slopScore.toFixed(3)),
    h: evaluation.holistic === null ? null : Number(evaluation.holistic.toFixed(3)),
    d: topDriver(evaluation),
    c: fromCache,
    a: evaluation.aiStyle === null ? null : Number(evaluation.aiStyle.toFixed(3)),
  });
  return evaluation;
}

/** The content script reports what it actually did, so stats match the DOM. */
async function recordOutcome(
  platform: Platform,
  verdict: Evaluation["verdict"],
  excluded: boolean,
  aiStyled: boolean,
): Promise<void> {
  await updateStats((s) => {
    const ps = s.byPlatform[platform];
    if (aiStyled) ps.aiStyled++;
    if (verdict === "hide") ps.hidden++;
    if (verdict === "collapse") ps.collapsed++;
    if (verdict === "highlight") ps.highlighted++;
    if (excluded) ps.excluded++;
  });
}

// ---- message router ----
chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      updateStats((s) => {
        s.errors++;
        s.lastError = error;
      }).finally(() => sendResponse({ ok: false, error } satisfies MessageReply));
    });
  return true; // keep the channel open for the async reply
});

/**
 * True for the extension's own pages (options, popup), false for content scripts.
 *
 * `sender.tab` cannot tell them apart, because the options page opens in a tab. A content
 * script's `sender.url` is the feed's URL, though, never a chrome-extension:// one.
 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
}

async function settingsReply(settings: Settings): Promise<MessageReply> {
  const hasKey = !!(await activeKey(settings.provider)).trim();
  return { ok: true, settings, hasKey };
}

/** Feed tabs the content script runs in; mirrors content_scripts.matches in the manifest. */
const FEED_URLS = chrome.runtime.getManifest().content_scripts?.flatMap((cs) => cs.matches ?? []) ?? [];

/**
 * Push the current settings to every open feed tab.
 *
 * Replaces the content script's old chrome.storage.onChanged listener, which received
 * every changed value in the area, the API key included, whenever it was saved.
 */
async function broadcastSettings(): Promise<void> {
  const settings = await loadSettings();
  const hasKey = !!(await activeKey(settings.provider)).trim();
  const msg: Message = { kind: "settings-changed", settings, hasKey };
  const tabs = await chrome.tabs.query({ url: FEED_URLS });
  await Promise.all(tabs.map((t) => (t.id === undefined ? undefined : chrome.tabs.sendMessage(t.id, msg).catch(() => {}))));
}

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<MessageReply> {
  switch (msg.kind) {
    case "evaluate":
      return { ok: true, evaluation: await evaluate(msg.post) };
    case "outcome":
      await recordOutcome(msg.platform, msg.verdict, msg.excluded, msg.aiStyled === true);
      // Returning stats lets the content script mirror them onto the page, where they can
      // be read without an extension context.
      return { ok: true, stats: await getStats() };
    case "skipped":
      await updateStats((s) => {
        s.byPlatform[msg.platform].skipped++;
      });
      await pushLog({ t: Date.now(), p: msg.platform, v: "skip", s: 0, h: null, d: "", c: false });
      return { ok: true, stats: await getStats() };
    case "get-stats":
      return { ok: true, stats: await getStats() };
    case "reset-stats":
      await chrome.storage.session.set({ [STATS_KEY]: EMPTY_STATS, [RECENT_KEY]: [] });
      await chrome.storage.session.remove(LOG_KEY);
      return { ok: true };
    case "get-settings":
      return settingsReply(await loadSettings());
    case "set-settings": {
      const reply = await settingsReply(await saveSettings(msg.patch));
      await broadcastSettings();
      return reply;
    }
    case "get-keys":
      if (!fromExtensionPage(sender)) throw new Error("Keys are only readable from the options page.");
      return { ok: true, keys: await loadKeys() };
    case "set-keys":
      if (!fromExtensionPage(sender)) throw new Error("Keys are only writable from the options page.");
      await saveKeys(msg.keys);
      await broadcastSettings();
      return { ok: true };
    case "clear-cache":
      await clearCache();
      return { ok: true };
    case "get-log":
      return { ok: true, log: await getLog() };
    case "clear-log":
      await chrome.storage.session.remove(LOG_KEY);
      return { ok: true };
    case "get-recent": {
      const got = await chrome.storage.session.get(RECENT_KEY);
      return { ok: true, recent: (got[RECENT_KEY] ?? []) as Evaluation[] };
    }
    case "test-key": {
      if (msg.provider === "openrouter") {
        const verdict = openRouterKeyVerdict(await openRouterKeyInfo({ apiKey: msg.apiKey }));
        if (!verdict.ok) throw new TypeSafeError(verdict.message);
        return { ok: true, message: verdict.message };
      }
      const models = await listModels({ apiKey: msg.apiKey });
      const names = models.models.map((m) => m.name);
      if (msg.model && !names.includes(msg.model) && !/^jev-\d/.test(msg.model)) {
        throw new TypeSafeError(`Key works, but model "${msg.model}" is not listed. Available: ${names.join(", ")}`);
      }
      return { ok: true, message: "Key works." };
    }
    default:
      throw new Error(`Unknown message kind ${(msg as { kind: string }).kind}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
});

// Keys live in storage.local, which content scripts can read by default. The content
// script no longer needs storage at all, so lock it to extension pages and this worker.
// Runs on every worker start; where Chrome does not support it for `local` this is a
// no-op and the key is still kept out of everything the content script is sent.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
} catch {
  /* unsupported */
}
