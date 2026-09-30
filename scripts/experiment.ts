// Runs a platform's question battery over its labelled samples against the live API and
// prints, per post, every signal, the holistic verdict, the composite, and the routing
// under each preset.
//
//   npm run experiment                          # both platforms, all presets
//   npm run experiment -- --platform linkedin   # one platform
//   npm run experiment -- --preset strict       # one preset
//   npm run experiment -- --id short_joke       # one post, full answer dump
//   npm run experiment -- --misses              # only rows that disagree with `expect`
//
// Needs TYPESAFE_API_KEY, or OPENROUTER_API_KEY with `--provider openrouter` (both loaded
// from .env by the npm script). Raw responses are cached in
// temp/experiment-cache.json so re-scoring after editing weights or thresholds is FREE;
// editing a question's wording changes the cache key and re-asks only that request.
//
// `expect` is a human guess at the right answer, not ground truth. Use the misses to
// decide whether the question, the weight, or the expectation was wrong — all three have
// happened.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  STRUCTURAL_WEIGHTS,
  buildQuestions,
  buildState,
  policyFor,
  signalsFor,
} from "../src/shared/questions/index.ts";
import { compositeSlop, decide, extractAnswers } from "../src/shared/scoring.ts";
import { systemOne } from "../src/shared/typesafe.ts";
import {
  PLATFORMS,
  PROVIDER_INFO,
  isProvider,
  type Platform,
  type PostState,
  type Preset,
  type SystemOneResponse,
  type Verdict,
} from "../src/shared/types.ts";

interface Sample {
  id: string;
  expect: Verdict;
  note?: string;
  author_headline?: string;
  text: string;
  /**
   * Set false when the post is suppressed by a rule OTHER than the slop score — an
   * excluded topic, for instance. The separation report compares slop scores between the
   * two label groups, and a post hidden at P(slop)=0.02 by the exclusion rule makes that
   * comparison meaningless. It is still checked for the right verdict.
   */
  separation?: boolean;
}

const args = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyPlatform = argOf("--platform") as Platform | undefined;
const onlyPreset = argOf("--preset") as Preset | undefined;
const onlyId = argOf("--id");
const onlyMisses = args.includes("--misses");
const providerArg = argOf("--provider") ?? process.env.SLOP_PROVIDER ?? "typesafe";
if (!isProvider(providerArg)) {
  console.error(`Unknown provider "${providerArg}". Use typesafe or openrouter.`);
  process.exit(1);
}
const provider = providerArg;
const model =
  argOf("--model") ??
  (provider === "typesafe" ? process.env.TYPESAFE_DEFAULT_MODEL : undefined) ??
  PROVIDER_INFO[provider].defaultModel;

const keyVar = provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
const apiKey = process.env[keyVar] ?? "";
if (!apiKey) {
  console.error(`${keyVar} is not set. Put it in .env (see .env.example).`);
  process.exit(1);
}

const config = JSON.parse(readFileSync("samples/config.json", "utf8")) as {
  interests: string[];
  excludedTopics: string[];
};

const CACHE_PATH = "temp/experiment-cache.json";
mkdirSync("temp", { recursive: true });
const cache: Record<string, SystemOneResponse> = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
  : {};

function key(state: unknown, questions: unknown): string {
  return createHash("sha1").update(JSON.stringify([model, state, questions])).digest("hex");
}

function asPost(s: Sample, platform: Platform): PostState {
  return {
    platform,
    id: `sample:${s.id}`,
    author: "",
    handle: platform === "x" ? "sample" : "",
    authorHeadline: s.author_headline ?? "",
    text: s.text,
    quotedText: "",
    hasMedia: false,
    hasLink: false,
    isRepost: false,
    isQuote: false,
    isReply: false,
    isPromoted: false,
  };
}

async function ask(post: PostState): Promise<{ response: SystemOneResponse; cached: boolean; ms: number }> {
  const state = buildState(post, config.interests, config.excludedTopics);
  const questions = buildQuestions(post.platform, config.interests, config.excludedTopics);
  const k = key(state, questions);
  if (cache[k]) return { response: cache[k], cached: true, ms: 0 };
  const t0 = performance.now();
  const response = await systemOne({ provider, apiKey, model }, state as never, questions);
  const ms = performance.now() - t0;
  cache[k] = response;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  return { response, cached: false, ms };
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const num = (v: number | undefined | null) => (v === undefined || v === null ? "  – " : v.toFixed(2));
const presets: Preset[] = onlyPreset ? [onlyPreset] : ["relaxed", "balanced", "strict"];

let grandTokens = 0;
let grandCalls = 0;

for (const platform of onlyPlatform ? [onlyPlatform] : PLATFORMS) {
  const samples = JSON.parse(readFileSync(`samples/${platform}.json`, "utf8")) as Sample[];
  const chosen = onlyId ? samples.filter((s) => s.id === onlyId) : samples;
  if (!chosen.length) continue;

  const signalIds = Object.keys(signalsFor(platform));
  const structIds = Object.keys(STRUCTURAL_WEIGHTS[platform]);

  console.log(`\n${"=".repeat(100)}\n${platform.toUpperCase()} · ${model} · ${chosen.length} posts\n`);
  console.log(
    pad("post", 24) +
      signalIds.map((s) => pad(abbrev(s), 6)).join("") +
      pad("sub", 5) +
      pad("str", 5) +
      pad("P(slop)", 8) +
      pad("slop", 6) +
      presets.map((p) => pad(p, 11)).join("") +
      "expect",
  );

  const rows: { id: string; expect: Verdict; verdicts: Record<Preset, Verdict>; slop: number; holistic: number | null; separation?: boolean }[] = [];

  for (const s of chosen) {
    const post = asPost(s, platform);
    let response: SystemOneResponse, cached: boolean, ms: number;
    try {
      ({ response, cached, ms } = await ask(post));
    } catch (e) {
      console.log(pad(s.id, 24) + `ERROR ${(e as Error).message}`);
      continue;
    }
    if (!cached) {
      grandCalls++;
      grandTokens += response.usage?.input_tokens ?? 0;
    }

    const raw = extractAnswers(response, platform, config.interests, config.excludedTopics);
    const { score: slop, structural } = compositeSlop(raw, s.text, platform);
    const verdicts = {} as Record<Preset, Verdict>;
    for (const p of presets) verdicts[p] = decide(raw, s.text, platform, p, true).verdict;
    rows.push({ id: s.id, expect: s.expect, verdicts, slop, holistic: raw.holistic, separation: s.separation });

    const structSummary = structIds.filter((k) => (structural[k] ?? 0) > 0).map((k) => k[0]).join("");
    const missed = presets.some((p) => verdicts[p] !== s.expect);
    if (!onlyMisses || missed) {
      console.log(
        pad(s.id, 24) +
          signalIds.map((id) => pad(num(raw.signals[id]), 6)).join("") +
          pad(num(raw.substance), 5) +
          pad(structSummary || "–", 5) +
          pad(num(raw.holistic), 8) +
          pad(slop.toFixed(2), 6) +
          presets.map((p) => pad(mark(verdicts[p], s.expect), 11)).join("") +
          s.expect +
          (cached ? "  (cached)" : `  ${ms.toFixed(0)}ms ${response.usage?.input_tokens ?? "?"}tok`),
      );
    }

    if (onlyId) {
      console.log(`\nnote: ${s.note ?? "–"}`);
      console.log("text:\n" + s.text.split("\n").map((l) => "  | " + l).join("\n"));
      console.log("\nstructural:", structural);
      console.log("interests:", raw.interestHits);
      console.log("excluded:", raw.excludedHits);
      for (const p of presets) console.log(`${p}: ${JSON.stringify(decide(raw, s.text, platform, p, true))}`);
      console.log("\nraw answers:", JSON.stringify(response.answers, null, 1));
    }
  }

  console.log("\nsignals: " + signalIds.map((s) => `${abbrev(s)}=${s}`).join("  "));
  console.log("struct:  " + structIds.map((k) => `${k[0]}=${k}`).join("  ") + "\n");

  for (const p of presets) {
    const ok = rows.filter((r) => r.verdicts[p] === r.expect).length;
    // Asymmetric error: hiding something good is much worse than showing something bad.
    // A false hide is a post we wanted VISIBLE that got suppressed. An expected
    // "collapse" that collapses is correct, not a false hide.
    const falseHide = rows.filter(
      (r) => (r.expect === "show" || r.expect === "highlight") && (r.verdicts[p] === "hide" || r.verdicts[p] === "collapse"),
    );
    const missedSlop = rows.filter((r) => r.expect === "hide" && (r.verdicts[p] === "show" || r.verdicts[p] === "highlight"));
    const pol = policyFor(platform, p);
    console.log(
      `${pad(p, 10)} ${ok}/${rows.length} match   ` +
        `false-hide ${falseHide.length}${falseHide.length ? ` (${falseHide.map((r) => r.id).join(", ")})` : ""}   ` +
        `missed-slop ${missedSlop.length}${missedSlop.length ? ` (${missedSlop.map((r) => r.id).join(", ")})` : ""}`,
    );
    console.log(`${pad("", 10)} hide≥${pol.hideAt} collapse≥${pol.collapseAt} hard≥${pol.hardSignalAt}`);
  }

  const sep = rows.filter((r) => r.separation !== false);
  if (sep.length < rows.length) {
    console.log(`(separation excludes ${rows.length - sep.length} post(s) suppressed by a non-score rule)`);
  }
  report("holistic P(slop) ", sep.map((r) => ({ v: r.holistic, e: r.expect })));
  report("blended composite", sep.map((r) => ({ v: r.slop, e: r.expect })));
}

console.log(
  grandCalls
    ? `\n${grandCalls} live calls, ${grandTokens} input tokens ≈ $${((grandTokens / 1e6) * 0.042).toFixed(5)}`
    : "\nall cached — no API calls, no cost",
);

/** Separation between the two label groups. The gap is where a threshold has to live. */
function report(label: string, xs: { v: number | null; e: Verdict }[]): void {
  const slop = xs.filter((x) => x.e === "hide" && x.v !== null).map((x) => x.v!);
  const good = xs.filter((x) => x.e !== "hide" && x.v !== null).map((x) => x.v!);
  if (!slop.length || !good.length) return;
  const gap = Math.min(...slop) - Math.max(...good);
  console.log(
    `${label}: good max ${Math.max(...good).toFixed(2)} · slop min ${Math.min(...slop).toFixed(2)} · ` +
      (gap > 0
        ? `gap ${gap.toFixed(2)} → put hideAt near ${((Math.min(...slop) + Math.max(...good)) / 2).toFixed(2)}`
        : `OVERLAP ${(-gap).toFixed(2)} — no threshold separates these; fix a question or a weight`),
  );
}

function abbrev(id: string): string {
  const map: Record<string, string> = {
    engagement_bait: "bait",
    ai_prose: "aipro",
    rage_bait: "rage",
    sells_something: "sell",
    self_promo: "flex",
    empty_wisdom: "empty",
    stolen_or_recycled: "recyc",
    bait_hook: "hook",
    hype_shill: "hype",
    engagement_farm_format: "list",
    formula_story: "story",
    no_substance: "nosub",
  };
  return map[id] ?? id.slice(0, 5);
}
function mark(v: Verdict, expect: Verdict): string {
  return `${v === expect ? "✓" : "✗"} ${v}`;
}
