// Wire types for POST /v1/systemone (docs: https://docs.typesafe.ai/api). The same shape is
// served by TypeSafe directly and by OpenRouter's System One API; OpenRouter adds `id`,
// `provider` and `usage.cost` to the response.

export type EntryType = string | JsonValue[] | { [key: string]: JsonValue } | null;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: "noul";
  instructions: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
}
export interface ChoiceQuestion {
  type: "choice";
  instructions: EntryType;
  criteria: Record<string, EntryType>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: EntryType;
  criteria: EntryType[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, EntryType>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  state: EntryType;
  model: string;
  questions: Questions;
}
export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  /** `cost` is USD and only reported by OpenRouter. */
  usage: { input_tokens: number; output_tokens: number; cost?: number };
  id?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// API providers
// ---------------------------------------------------------------------------

export const PROVIDERS = ["typesafe", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ProviderInfo {
  label: string;
  /** Fixed in code on purpose: no setting can redirect the key to another host. */
  baseUrl: string;
  defaultModel: string;
  keyUrl: string;
  keyPlaceholder: string;
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  typesafe: {
    label: "TypeSafe",
    baseUrl: "https://api.typesafe.ai",
    defaultModel: "jev-1.13.0",
    keyUrl: "https://console.typesafe.ai/keys",
    keyPlaceholder: "ts-…",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    // Moves with new Jev releases (currently Jev 1.13). Pin `typesafe/jev-1.13` to freeze
    // the scale the thresholds were fitted to.
    defaultModel: "~typesafe/jev-latest",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-…",
  },
};

export function isProvider(v: unknown): v is Provider {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

/**
 * API keys, stored apart from Settings under their own storage key.
 *
 * Settings travel to the content script (via `get-settings` and `storage.onChanged`);
 * keys must not. Only the service worker and the options page ever read them.
 */
export type ApiKeys = Record<Provider, string>;
export const EMPTY_KEYS: ApiKeys = { typesafe: "", openrouter: "" };

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PLATFORMS = ["x", "linkedin"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  x: "X",
  linkedin: "LinkedIn",
};

/**
 * One scraped post, in a shape both platforms can fill.
 *
 * Fields that only one platform can supply are optional and the questions that use them
 * are added per-platform, so neither side pays for the other's state.
 */
export interface PostState {
  platform: Platform;
  /** Stable per-post identity. X: status id from the permalink. LinkedIn: URN or SDUI key. */
  id: string;
  author: string;
  /** X: @handle. LinkedIn: "" (no stable handle in the feed markup). */
  handle: string;
  /** LinkedIn: the actor's headline line. X: "". */
  authorHeadline: string;
  text: string;
  /** X: quote-tweeted post's text. LinkedIn: "" (reposts carry their own card). */
  quotedText: string;
  hasMedia: boolean;
  hasLink: boolean;
  isRepost: boolean;
  isQuote: boolean;
  isReply: boolean;
  isPromoted: boolean;
}

export type Verdict = "hide" | "collapse" | "show" | "highlight";

export interface Evaluation {
  platform: Platform;
  id: string;
  verdict: Verdict;
  slopScore: number;
  /** P(slop) from the holistic Choice, or null. */
  holistic: number | null;
  signals: Record<string, number>;
  structural: Record<string, number>;
  substance: number | null;
  substanceConfidence: number | null;
  interestHits: Record<string, number>;
  excludedHits: Record<string, number>;
  reason: string;
  /** AI-style score (noisy-OR of style signals and the dash feature), null when the axis is off. */
  aiStyle: number | null;
  /** Style signals and `dash_density`, for the badge tooltip. */
  aiSignals: Record<string, number>;
  /** aiStyle at or above AI_STYLE_AT. */
  aiStyled: boolean;
  model: string;
  inputTokens: number;
  evaluatedAt: number;
  fromCache: boolean;
}

export type Preset = "relaxed" | "balanced" | "strict";

/**
 * What the AI-style axis does. "off" does not ask the style questions at all; "badge"
 * only shows the score; "collapse" also blurs AI-styled posts that the slop score let
 * through. It never hides: style is not value.
 */
export type AiStyleMode = "off" | "badge" | "collapse";

/** Settings that can differ between X and LinkedIn. */
export interface PlatformSettings {
  enabled: boolean;
  preset: Preset;
  /** Posts shorter than this are left alone. X posts are short; LinkedIn's are not. */
  minPostChars: number;
  /** Replies lose their parent's context, so judgments are unreliable. */
  skipReplies: boolean;
}

export interface Settings {
  /** Master switch; each platform also has its own. */
  enabled: boolean;
  /** Which host receives the requests. The key for it lives in ApiKeys, not here. */
  provider: Provider;
  /** Model id per provider; the two use different naming. */
  models: Record<Provider, string>;
  /** Shared across platforms — the same person cares about the same things on both. */
  interests: string[];
  excludedTopics: string[];
  allowHandles: string[];
  highlightInterests: boolean;
  hideMode: "placeholder" | "remove";
  showBadges: boolean;
  aiStyleMode: AiStyleMode;
  maxPostChars: number;
  platforms: Record<Platform, PlatformSettings>;
}

export const DEFAULT_PLATFORM_SETTINGS: Record<Platform, PlatformSettings> = {
  // X posts are short by nature; 80 chars cuts roughly the bottom quarter of a real
  // timeline (measured median 206 chars).
  x: { enabled: true, preset: "balanced", minPostChars: 80, skipReplies: true },
  // LinkedIn posts are long; almost nothing legitimate lands under 120 chars.
  linkedin: { enabled: true, preset: "balanced", minPostChars: 120, skipReplies: true },
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: "openrouter",
  models: { typesafe: PROVIDER_INFO.typesafe.defaultModel, openrouter: PROVIDER_INFO.openrouter.defaultModel },
  interests: [],
  excludedTopics: [],
  allowHandles: [],
  highlightInterests: true,
  hideMode: "placeholder",
  showBadges: true,
  // Watch the scores first; the weights are not calibrated yet.
  aiStyleMode: "badge",
  maxPostChars: 4000,
  platforms: DEFAULT_PLATFORM_SETTINGS,
};

export interface PlatformStats {
  evaluated: number;
  hidden: number;
  collapsed: number;
  highlighted: number;
  excluded: number;
  skipped: number;
  cacheHits: number;
  inputTokens: number;
  /** USD as reported by the provider (OpenRouter reports it, TypeSafe does not). */
  costUsd: number;
  /** Tokens from responses without a reported cost; the popup estimates these. */
  unpricedTokens: number;
  /** Posts at or above AI_STYLE_AT, whatever the mode did with them. */
  aiStyled: number;
}

export const EMPTY_PLATFORM_STATS: PlatformStats = {
  evaluated: 0,
  hidden: 0,
  collapsed: 0,
  highlighted: 0,
  excluded: 0,
  skipped: 0,
  cacheHits: 0,
  inputTokens: 0,
  costUsd: 0,
  unpricedTokens: 0,
  aiStyled: 0,
};

export interface SessionStats {
  byPlatform: Record<Platform, PlatformStats>;
  errors: number;
  lastError: string | null;
  lastModel: string | null;
}

export const EMPTY_STATS: SessionStats = {
  byPlatform: { x: { ...EMPTY_PLATFORM_STATS }, linkedin: { ...EMPTY_PLATFORM_STATS } },
  errors: 0,
  lastError: null,
  lastModel: null,
};

/** Sum across platforms, for the popup's headline numbers. */
export function totalStats(s: SessionStats): PlatformStats {
  const out = { ...EMPTY_PLATFORM_STATS };
  for (const p of PLATFORMS) {
    const ps = s.byPlatform[p] ?? EMPTY_PLATFORM_STATS;
    for (const k of Object.keys(out) as (keyof PlatformStats)[]) out[k] += ps[k] ?? 0;
  }
  return out;
}

/**
 * One decision, compactly. Kept for the whole browser session so a suppression rate can
 * be computed over a real scroll rather than over whatever happens to be in the DOM —
 * both feeds virtualize, so a DOM scrape only ever sees 8-13 posts at a time.
 *
 * Short keys on purpose: these are stored in chrome.storage.session, and a few thousand
 * of them should stay small.
 */
export interface LogEntry {
  /** epoch ms */
  t: number;
  p: Platform;
  /** verdict, or "skip" for a post that was never sent */
  v: Verdict | "skip";
  /** composite slop score; 0 for a skip */
  s: number;
  /** holistic P(slop), null if the answer was missing */
  h: number | null;
  /** highest-scoring signal or structural feature, "" for a skip */
  d: string;
  /** true when the answers came from cache rather than the API */
  c: boolean;
  /** AI-style score, null when the axis is off or for a skip */
  a?: number | null;
}

export const LOG_MAX = 5000;

export type Message =
  | { kind: "evaluate"; post: PostState }
  | { kind: "outcome"; platform: Platform; verdict: Verdict; excluded: boolean; aiStyled: boolean }
  | { kind: "skipped"; platform: Platform }
  | { kind: "get-stats" }
  | { kind: "reset-stats" }
  | { kind: "get-settings" }
  | { kind: "set-settings"; patch: Partial<Settings> }
  | { kind: "test-key"; provider: Provider; apiKey: string; model: string }
  | { kind: "get-keys" }
  | { kind: "set-keys"; keys: Partial<ApiKeys> }
  /** Service worker → content scripts, after any settings or key change. Never carries a key. */
  | { kind: "settings-changed"; settings: Settings; hasKey: boolean }
  | { kind: "clear-cache" }
  | { kind: "get-recent" }
  | { kind: "get-log" }
  | { kind: "clear-log" };

export type MessageReply =
  | { ok: true; evaluation: Evaluation }
  | { ok: true; stats: SessionStats }
  | { ok: true; settings: Settings; hasKey: boolean }
  | { ok: true; keys: ApiKeys }
  | { ok: true; message: string }
  | { ok: true; recent: Evaluation[] }
  | { ok: true; log: LogEntry[] }
  | { ok: true; stats: SessionStats; log: LogEntry[] }
  | { ok: true }
  | { ok: false; error: string };
