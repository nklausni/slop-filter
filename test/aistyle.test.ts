// Unit tests for the AI-style axis. No key, no network: scoring is pure.
//
//   npm test
//
// The axis is a second opinion next to slop, so most of these cases are about what it
// must NOT do: flag a post on one Jev pattern alone, change a slop verdict, hide
// anything, or let an interest rescue a post it blurred. The dash feature is the one
// signal allowed to flag alone, and only from DASH_FLAG_COUNT em dashes on.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  AI_STYLE_AT,
  AI_STYLE_SIGNALS,
  DASH_FLAG_COUNT,
  DASH_WEIGHT,
  buildQuestions,
  dashSignal,
  signalsFor,
} from "../src/shared/questions/index.ts";
import { aiStyleScore, decide, extractAnswers } from "../src/shared/scoring.ts";
import type { AiStyleMode, Platform, SystemOneResponse } from "../src/shared/types.ts";

/** A clean, substantive post; `ai` sets style signals, every unnamed one answers 0.02. */
function response(
  platform: Platform,
  opts: { ai?: Record<string, number>; askAi?: boolean; slop?: Record<string, number>; holistic?: number; interest?: number } = {},
): SystemOneResponse {
  const answers: SystemOneResponse["answers"] = {};
  for (const id of Object.keys(signalsFor(platform))) answers[id] = { type: "noul", noul: opts.slop?.[id] ?? 0.02 };
  if (opts.askAi !== false) {
    for (const id of Object.keys(AI_STYLE_SIGNALS)) answers[id] = { type: "noul", noul: opts.ai?.[id] ?? 0.02 };
  }
  const h = opts.holistic ?? 0.05;
  answers.verdict = { type: "choice", choice: h >= 0.5 ? "slop" : "not_slop", probabilities: { slop: h, not_slop: 1 - h }, confidence: 0.9 };
  answers.substance = { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.9 };
  if (opts.interest !== undefined) answers.interest_0 = { type: "noul", noul: opts.interest };
  return { model: "test", answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

const TEXT = "We moved fraud scoring off the request path and p95 dropped from 340ms to 41ms.";
const raw = (o: Parameters<typeof response>[1] = {}, interests: string[] = []) =>
  extractAnswers(response("linkedin", o), "linkedin", interests, []);
const run = (mode: AiStyleMode, o: Parameters<typeof response>[1] = {}, interests: string[] = []) =>
  decide(raw(o, interests), TEXT, "linkedin", "balanced", true, {}, mode);

const TWO_STRONG = { contrast_punchline: 0.95, negative_parallelism: 0.95 };

const EM = "\u2014";

describe("dashSignal", () => {
  test("counts separator em dashes, reaching 1 at DASH_FLAG_COUNT", () => {
    assert.equal(dashSignal("No dashes here."), 0);
    assert.equal(dashSignal(`We shipped it ${EM} finally.`), 1 / DASH_FLAG_COUNT);
    assert.equal(dashSignal(`One ${EM} two ${EM} in a line.`), 2 / DASH_FLAG_COUNT);
    assert.equal(dashSignal(`a ${EM} b.\nc ${EM} d.\ne ${EM} f.\ng ${EM} h.`), 1);
  });

  test("two unmarked sentences with an early dash are prose, not a list", () => {
    const t = `Most teams don't fail at AI ${EM} they fail at data.\nThe fix isn't more tools ${EM} it's fewer.`;
    assert.equal(dashSignal(t), 2 / DASH_FLAG_COUNT);
  });

  test("the separator of a marked label list is not counted", () => {
    const list = `\u{1F4DA} Atomic Habits ${EM} a masterpiece\n\u{1F4DA} Deep Work ${EM} essential\n- Sapiens ${EM} brilliant`;
    assert.equal(dashSignal(list), 0);
  });

  test("a further dash on a label row still counts", () => {
    const list = `\u{1F4DA} Atomic Habits ${EM} a masterpiece ${EM} read it twice\n\u{1F4DA} Deep Work ${EM} essential`;
    assert.equal(dashSignal(list), 1 / DASH_FLAG_COUNT);
  });

  test("a single marked row is not a list", () => {
    assert.equal(dashSignal(`1. A named buddy per hire ${EM} the rota meant nobody owned it.`), 1 / DASH_FLAG_COUNT);
  });

  test("ranges, en dashes and hyphens are not counted", () => {
    assert.equal(dashSignal(`2020${EM}2024, 10 ${EM} 12 %`), 0);
    assert.equal(dashSignal("Wir haben es getestet \u2013 und es lief. Dann \u2013 nach zwei Wochen \u2013 kam der Fehler."), 0);
    assert.equal(dashSignal("It works -- mostly - and that's fine."), 0);
  });
});

describe("aiStyleScore", () => {
  test("no single Jev signal can flag a post on its own", () => {
    for (const [id, { weight }] of Object.entries(AI_STYLE_SIGNALS)) {
      assert.ok(weight < AI_STYLE_AT, `${id} weight ${weight} must stay below ${AI_STYLE_AT}`);
      const alone = aiStyleScore(raw({ ai: { [id]: 1 } }), TEXT).score!;
      assert.ok(alone < AI_STYLE_AT, `${id} alone scored ${alone.toFixed(2)}`);
    }
  });

  test("em dashes flag a post alone from DASH_FLAG_COUNT on, but one does not", () => {
    assert.ok(DASH_WEIGHT >= AI_STYLE_AT);
    const one = aiStyleScore(raw(), `We moved it ${EM} finally.`).score!;
    const two = aiStyleScore(raw(), `We moved it ${EM} finally ${EM} after a month.`).score!;
    const three = aiStyleScore(raw(), `a ${EM} b ${EM} c ${EM} d.`).score!;
    assert.ok(one < AI_STYLE_AT, `one dash scored ${one.toFixed(2)}`);
    assert.ok(two < AI_STYLE_AT, `two dashes scored ${two.toFixed(2)}`);
    assert.ok(three >= AI_STYLE_AT, `three dashes scored ${three.toFixed(2)}`);
  });

  test("one em dash plus one strong pattern stays below the line, two dashes plus one cross it", () => {
    const pattern = { ai: { contrast_punchline: 0.9 } };
    assert.ok(aiStyleScore(raw(pattern), `x ${EM} y.`).score! < AI_STYLE_AT);
    assert.ok(aiStyleScore(raw(pattern), `x ${EM} y ${EM} z.`).score! >= AI_STYLE_AT);
  });

  test("two strong patterns together cross the line", () => {
    assert.ok(aiStyleScore(raw({ ai: TWO_STRONG }), TEXT).score! >= AI_STYLE_AT);
  });

  test("co-occurrence scores higher than the strongest single signal", () => {
    const one = aiStyleScore(raw({ ai: { contrast_punchline: 0.8 } }), TEXT).score!;
    const two = aiStyleScore(raw({ ai: { contrast_punchline: 0.8, inflated_significance: 0.8 } }), TEXT).score!;
    assert.ok(two > one);
  });

  test("a clean post stays well below the line", () => {
    assert.ok(aiStyleScore(raw(), TEXT).score! < 0.15);
  });

  test("null when the style questions were not asked", () => {
    assert.equal(aiStyleScore(raw({ askAi: false }), TEXT).score, null);
  });
});

describe("decide with AI style", () => {
  test("off ignores style answers entirely", () => {
    const d = run("off", { ai: TWO_STRONG });
    assert.equal(d.aiStyle, null);
    assert.equal(d.verdict, "show");
  });

  test("badge reports the score but keeps the verdict", () => {
    const d = run("badge", { ai: TWO_STRONG });
    assert.ok(d.aiStyle! >= AI_STYLE_AT);
    assert.equal(d.verdict, "show");
  });

  test("collapse blurs an AI-styled post the slop score let through", () => {
    const d = run("collapse", { ai: TWO_STRONG });
    assert.equal(d.verdict, "collapse");
    assert.match(d.reason, /^AI style/);
  });

  test("never hides: style is not value", () => {
    const d = run("collapse", { ai: { contrast_punchline: 1, negative_parallelism: 1, inflated_significance: 1, section_scaffold: 1 } });
    assert.equal(d.verdict, "collapse");
  });

  test("a slop hide wins over AI style", () => {
    const d = run("collapse", { ai: TWO_STRONG, slop: { engagement_bait: 0.97 }, holistic: 0.9 });
    assert.equal(d.verdict, "hide");
  });

  test("an interest does not rescue an AI-styled post in collapse mode", () => {
    const d = run("collapse", { ai: TWO_STRONG, interest: 0.95 }, ["databases"]);
    assert.equal(d.verdict, "collapse");
  });

  test("the slop score is identical with and without style questions", () => {
    const withAi = run("collapse", { ai: TWO_STRONG }).slopScore;
    const without = run("off", { askAi: false }).slopScore;
    assert.equal(withAi, without);
  });
});

describe("buildQuestions", () => {
  test("style questions ride along only when the axis is on", () => {
    for (const p of ["x", "linkedin"] as const) {
      const off = Object.keys(buildQuestions(p, [], []));
      const on = Object.keys(buildQuestions(p, [], [], true));
      assert.equal(on.length, off.length + Object.keys(AI_STYLE_SIGNALS).length, "no id may collide");
      for (const id of Object.keys(AI_STYLE_SIGNALS)) {
        assert.ok(!off.includes(id));
        assert.ok(on.includes(id));
      }
    }
  });
});
