// Turn raw Jev answers into a verdict. Pure functions: no I/O, no chrome.* — so the same
// code runs in the service worker and in scripts/experiment.ts.

import {
  AI_STYLE_AT,
  AI_STYLE_SIGNALS,
  BLEND,
  DASH_WEIGHT,
  EMPTY_MEDIA_DAMPING,
  HARD_SIGNAL_HOLISTIC_FLOOR,
  STRUCTURAL_WEIGHTS,
  VERDICT_BLEND,
  dashSignal,
  policyFor,
  signalsFor,
  structuralSignals,
  substanceFor,
  type Policy,
} from "./questions/index.ts";
import type { AiStyleMode, Answer, Evaluation, Platform, PostState, Preset, SystemOneResponse, Verdict } from "./types.ts";

export interface RawAnswers {
  signals: Record<string, number>;
  /** P(slop) from the holistic VERDICT_CHOICE, or null if absent. */
  holistic: number | null;
  holisticConfidence: number | null;
  substance: number | null; // normalized 0..1
  substanceConfidence: number | null;
  interestHits: Record<string, number>;
  excludedHits: Record<string, number>;
  /** AI-style Nouls; empty when the style questions were not asked. */
  aiSignals: Record<string, number>;
}

/** Pull the numbers out of a response. Unknown/missing answers are skipped, not invented. */
export function extractAnswers(
  response: SystemOneResponse,
  platform: Platform,
  interests: string[],
  excludedTopics: string[],
): RawAnswers {
  // A malformed or proxied response can carry a null/absent answers map. Measured:
  // this threw, putting every card into the error state instead of degrading quietly.
  const a = (response?.answers ?? {}) as SystemOneResponse["answers"];

  const signals: Record<string, number> = {};
  for (const id of Object.keys(signalsFor(platform))) {
    const ans = a[id];
    if (ans && ans.type === "noul") signals[id] = clamp01(ans.noul);
  }

  const vAns = a.verdict;
  const holistic = vAns && vAns.type === "choice" ? clamp01(vAns.probabilities?.slop ?? 0) : null;
  const holisticConfidence = vAns && vAns.type === "choice" ? vAns.confidence : null;

  let substance: number | null = null;
  let substanceConfidence: number | null = null;
  const sub = a.substance;
  if (sub && sub.type === "score") {
    substance = clamp01(sub.score / (substanceFor(platform).criteria.length - 1));
    substanceConfidence = sub.confidence;
  }

  const interestHits: Record<string, number> = {};
  interests.forEach((topic, i) => {
    const ans = a[`interest_${i}`];
    if (ans && ans.type === "noul") interestHits[topic] = clamp01(ans.noul);
  });

  const excludedHits: Record<string, number> = {};
  excludedTopics.forEach((topic, i) => {
    const ans = a[`excluded_${i}`];
    if (ans && ans.type === "noul") excludedHits[topic] = clamp01(ans.noul);
  });

  const aiSignals: Record<string, number> = {};
  for (const id of Object.keys(AI_STYLE_SIGNALS)) {
    const ans = a[id];
    if (ans && ans.type === "noul") aiSignals[id] = clamp01(ans.noul);
  }

  return { signals, holistic, holisticConfidence, substance, substanceConfidence, interestHits, excludedHits, aiSignals };
}

/**
 * AI-style score in 0..1, or null when no style answer came back.
 *
 * Noisy-OR: 1 - Π(1 - weight·p). Unlike the slop battery's "worst signal", this rewards
 * co-occurrence, because one stylistic habit is how some people write and several at
 * once are a template. The dash feature joins the same product.
 */
export function aiStyleScore(raw: RawAnswers, text: string): { score: number | null; signals: Record<string, number> } {
  const signals: Record<string, number> = { ...raw.aiSignals };
  if (!Object.keys(signals).length) return { score: null, signals };
  signals.dash_density = clamp01(dashSignal(text));

  let clean = 1 - DASH_WEIGHT * signals.dash_density;
  for (const [id, { weight }] of Object.entries(AI_STYLE_SIGNALS)) {
    const v = signals[id];
    if (v !== undefined) clean *= 1 - weight * v;
  }
  return { score: clamp01(1 - clean), signals };
}

export interface Flags {
  hasMedia?: boolean;
  hasLink?: boolean;
}

/**
 * Composite slop score in 0..1.
 *
 * Two opinions, both asked in the same request:
 *
 *   HOLISTIC  one relative Choice, "is this slop?". Measured on 25 labelled X posts it
 *             separated good from slop by 0.31, against 0.05 for the battery composite,
 *             at a fifth of the tokens. A Choice forces a commitment between two named
 *             options; independent Nouls averaged together regress to the middle. So it
 *             leads.
 *   BATTERY   the per-signal Nouls, the substance Score, and the code-side structural
 *             features. It is worse at deciding and it is the only thing that can say
 *             WHICH signal fired — which is how every false positive so far got fixed.
 *
 * Inside the battery the dominant term is the WORST single signal rather than a mean: a
 * slop post usually trips one pattern hard, and averaging buries that. The docs make the
 * same point — a weighted score suits compensating preferences, while "any one of these
 * disqualifies" needs its own condition.
 */
export function compositeSlop(
  raw: RawAnswers,
  text: string,
  platform: Platform,
  flags: Flags = {},
): { score: number; structural: Record<string, number> } {
  const structural = structuralSignals(text, platform);

  let worst = 0;
  let num = 0;
  let den = 0;

  for (const [id, { weight }] of Object.entries(signalsFor(platform))) {
    const v = raw.signals[id];
    if (v === undefined) continue;
    worst = Math.max(worst, weight * v);
    num += weight * v;
    den += weight;
  }

  // Structural features join the same "worst" competition, capped low enough that none
  // can cross a hide threshold alone. See STRUCTURAL_WEIGHTS.
  for (const [id, weight] of Object.entries(STRUCTURAL_WEIGHTS[platform])) {
    const v = structural[id];
    if (v === undefined) continue;
    worst = Math.max(worst, weight * v);
  }

  const mean = den ? num / den : 0;

  // Thin text is expected when the post carries media or a link — the content is there,
  // not in the caption.
  const damp = flags.hasMedia || flags.hasLink ? EMPTY_MEDIA_DAMPING : 1;
  const empty = raw.substance === null ? 0 : (1 - raw.substance) * damp;

  const battery = BLEND.worst * worst + BLEND.mean * mean + BLEND.empty * empty;
  const score =
    raw.holistic === null ? battery : VERDICT_BLEND * raw.holistic + (1 - VERDICT_BLEND) * battery;

  return { score: clamp01(score), structural };
}

export interface Decision {
  verdict: Verdict;
  slopScore: number;
  structural: Record<string, number>;
  aiStyle: number | null;
  aiSignals: Record<string, number>;
  reason: string;
}

/**
 * The routing. Ordered so the most consequential rule wins first:
 *   1. excluded topic          -> hide
 *   2. hard single signal      -> hide   (the "any serious violation" rule)
 *   3. composite >= hideAt     -> hide
 *   4. composite >= collapseAt -> collapse (uncertain band; one click to recover)
 *   5. AI style >= AI_STYLE_AT -> collapse, only in "collapse" mode
 *   6. interest hit            -> highlight
 *   7. otherwise               -> show
 *
 * Interests never rescue a hidden post: "I care about AI" must not surface AI slop.
 * The same holds for AI style, and AI style never hides: it is not a judgment of value.
 */
export function decide(
  raw: RawAnswers,
  text: string,
  platform: Platform,
  preset: Preset,
  highlightInterests: boolean,
  flags: Flags = {},
  aiStyleMode: AiStyleMode = "off",
): Decision {
  const policy: Policy = policyFor(platform, preset);
  const { score: slopScore, structural } = compositeSlop(raw, text, platform, flags);
  const ai = aiStyleMode === "off" ? { score: null, signals: {} } : aiStyleScore(raw, text);
  const base = { slopScore, structural, aiStyle: ai.score, aiSignals: ai.signals };

  const excluded = topEntry(raw.excludedHits);
  if (excluded && excluded[1] >= policy.excludeAt) {
    return { ...base, verdict: "hide", reason: `excluded topic "${excluded[0]}" (${excluded[1].toFixed(2)})` };
  }

  // The hard rule is vetoed when the holistic Choice confidently says "not slop".
  // See HARD_SIGNAL_HOLISTIC_FLOOR.
  const hardAllowed = raw.holistic === null || raw.holistic >= HARD_SIGNAL_HOLISTIC_FLOOR;
  if (hardAllowed) {
    for (const id of policy.hardSignals) {
      const v = raw.signals[id];
      if (v !== undefined && v >= policy.hardSignalAt) {
        return { ...base, verdict: "hide", reason: `${id} ${v.toFixed(2)} ≥ ${policy.hardSignalAt}` };
      }
    }
  }

  // Degraded mode: if the holistic Choice is missing, the battery is deciding alone —
  // and the battery is the weaker judge. Measured: with no holistic, LinkedIn's
  // `no_substance` at 1.00 clears the hide bar by itself, an implicit hard rule that
  // bypasses the explicit hardSignals list. A missing answer means something went wrong
  // with the request, so the most a partial picture may do is collapse, which is one
  // click to recover.
  if (slopScore >= policy.hideAt && raw.holistic === null) {
    return {
      ...base,
      verdict: "collapse",
      reason: `slop ${slopScore.toFixed(2)} ≥ ${policy.hideAt} but no holistic answer; collapsing rather than hiding`,
    };
  }

  if (slopScore >= policy.hideAt) {
    return {
      ...base,
      verdict: "hide",
      reason: `slop ${slopScore.toFixed(2)} ≥ ${policy.hideAt}; top: ${topSignals(raw, 3, structural)}`,
    };
  }
  if (slopScore >= policy.collapseAt) {
    return {
      ...base,
      verdict: "collapse",
      reason: `slop ${slopScore.toFixed(2)} in uncertain band [${policy.collapseAt}, ${policy.hideAt}); top: ${topSignals(raw, 3, structural)}`,
    };
  }

  if (aiStyleMode === "collapse" && ai.score !== null && ai.score >= AI_STYLE_AT) {
    return {
      ...base,
      verdict: "collapse",
      reason: `AI style ${ai.score.toFixed(2)} ≥ ${AI_STYLE_AT}; top: ${topOf(ai.signals, 3)}`,
    };
  }

  if (highlightInterests) {
    const interest = topEntry(raw.interestHits);
    if (interest && interest[1] >= policy.interestAt) {
      return { ...base, verdict: "highlight", reason: `interest "${interest[0]}" (${interest[1].toFixed(2)})` };
    }
  }
  return { ...base, verdict: "show", reason: `slop ${slopScore.toFixed(2)} < ${policy.collapseAt}` };
}

export function buildEvaluation(
  post: PostState,
  response: SystemOneResponse,
  interests: string[],
  excludedTopics: string[],
  preset: Preset,
  highlightInterests: boolean,
  fromCache: boolean,
  aiStyleMode: AiStyleMode = "off",
): Evaluation {
  const raw = extractAnswers(response, post.platform, interests, excludedTopics);
  const d = decide(
    raw,
    post.text,
    post.platform,
    preset,
    highlightInterests,
    { hasMedia: post.hasMedia, hasLink: post.hasLink },
    aiStyleMode,
  );
  return {
    platform: post.platform,
    id: post.id,
    verdict: d.verdict,
    slopScore: d.slopScore,
    holistic: raw.holistic,
    signals: raw.signals,
    structural: d.structural,
    substance: raw.substance,
    substanceConfidence: raw.substanceConfidence,
    interestHits: raw.interestHits,
    excludedHits: raw.excludedHits,
    reason: d.reason,
    aiStyle: d.aiStyle,
    aiSignals: d.aiSignals,
    aiStyled: d.aiStyle !== null && d.aiStyle >= AI_STYLE_AT,
    model: response.model,
    inputTokens: response.usage?.input_tokens ?? 0,
    evaluatedAt: Date.now(),
    fromCache,
  };
}

/** Top contributors by raw value, including the code-side structural features. */
function topSignals(raw: RawAnswers, n: number, structural: Record<string, number> = {}): string {
  return [...Object.entries(raw.signals), ...Object.entries(structural)]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");
}

function topOf(m: Record<string, number>, n: number): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");
}

function topEntry(m: Record<string, number>): [string, number] | undefined {
  let best: [string, number] | undefined;
  for (const e of Object.entries(m)) if (!best || e[1] > best[1]) best = e;
  return best;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

export function isAnswer(x: unknown): x is Answer {
  return !!x && typeof x === "object" && "type" in x;
}
