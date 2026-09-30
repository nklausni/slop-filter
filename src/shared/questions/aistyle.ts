// The AI-style axis: does a post READ as machine-written?
//
// This is a different question from slop, on purpose. The slop score asks whether a post
// is worth reading and deliberately ignores who wrote it: a substantive post polished by a
// chatbot is not slop. Measured on the sample sets, em dashes appear in 4 of 10 GOOD
// LinkedIn posts and in 0 of 11 slop ones, so folding a dash count into the slop score
// would push exactly the wrong posts toward hiding.
//
// So style gets its own score, its own badge and its own setting, and the slop score and
// its fitted thresholds stay untouched.
//
// Combination is noisy-OR over weighted signals, not the maximum: one pattern proves
// nothing, several together are a rhythm nobody hits by accident. Every Jev signal's
// weight is below AI_STYLE_AT, so none of them can flag a post on its own.
//
// The dash feature is the one exception, by the user's decision: em dashes are the best
// known machine tell, and DASH_FLAG_COUNT of them flag a post alone. A single one does not
// (see test/aistyle.test.ts).
//
// The weights and the threshold are first guesses. Nothing in samples/ has been labelled
// for style yet; calibrate them on real posts with `npm run experiment -- --ai-style`.

import { LEADING_EMOJI, noul, ramp, type SignalSet } from "./core.ts";

/** At or above this, a post counts as AI-styled (badge colour, optional collapse). */
export const AI_STYLE_AT = 0.6;

/**
 * Weight of the code-side dash feature in the noisy-OR. At or above AI_STYLE_AT on
 * purpose: at full strength the dash count flags a post by itself. One em dash
 * contributes 0.23, two 0.47, three or more 0.70.
 */
export const DASH_WEIGHT = 0.7;

/** Separator em dashes at which the dash feature reaches 1. */
export const DASH_FLAG_COUNT = 3;

export const AI_STYLE_SIGNALS: SignalSet = {
  contrast_punchline: {
    weight: 0.5,
    question: noul(
      {
        question:
          "Does `post.text` end one or more paragraphs with a short punchline sentence that only twists, inverts or dramatises the sentence before it, instead of adding a new fact?",
        focus:
          "Test the last sentence of each paragraph: does it carry information that was not there before? If it only comments on or reframes what was just said, it is a punchline. Disguised forms count too: 'The same X that does Y does Z here', 'X, just aimed at Y', two opposed adjectives in one sentence. A paragraph that simply ends on a fact, a number, a question or a next step is NOT this.",
      },
      {
        what: "One or more paragraphs close on a reframing twist rather than on content",
        examples: [
          "The fix was one line. Finding it took a week.",
          "We didn't need more people. We needed fewer meetings. And that changed everything.",
          "Der Fix war eine Zeile. Sie zu finden hat länger gedauert.",
        ],
      },
      {
        what: "Paragraphs end on a fact, figure, question, or next step",
        examples: [
          "The fix was one line: the config pinned the wrong region.",
          "Next week we move the remaining two services.",
        ],
      },
    ),
  },

  negative_parallelism: {
    weight: 0.5,
    question: noul(
      {
        question:
          "Does `post.text` use the formulaic 'not X, but Y' contrast as a rhetorical device, where X is a strawman or an abstraction set up only to be knocked down?",
        focus:
          "Forms: 'It's not X. It's Y.', 'This isn't about X, it's about Y', 'not just X, but Y', 'X isn't Y. It's Z.'. German forms count: 'nicht nur ..., sondern auch', 'Es geht nicht um X. Es geht um Y.', 'kein X, sondern Y'. A single factual correction naming concrete things on both sides is NOT this.",
      },
      {
        what: "The contrast is a rhetorical move, often repeated",
        examples: [
          "It's not about the tools. It's about the mindset.",
          "Leadership isn't a title. It's a choice.",
          "Es geht nicht um Technik. Es geht um Haltung.",
        ],
      },
      {
        what: "No such figure, or a plain correction of a specific claim",
        examples: ["The outage was not the database; a DNS change broke the resolver."],
      },
    ),
  },

  inflated_significance: {
    weight: 0.4,
    question: noul(
      {
        question:
          "Does `post.text` assert the importance of its subject with stock significance or promotional phrasing instead of stating what concretely happened?",
        focus:
          "Importance asserted, not shown: 'game-changer', 'a testament to', 'marks a pivotal moment', 'unlock', 'elevate', 'revolutionise', 'in today's fast-paced world', 'the evolving landscape', 'delve into', 'seamless'. German: 'spielt eine entscheidende Rolle', 'unterstreicht die Bedeutung', 'ein echter Meilenstein', 'nahtlos'. One enthusiastic word next to real specifics is NOT this.",
      },
      "Significance or promotional stock phrases carry the post: the reader is told it matters rather than shown what happened",
      "States what happened or what it does; any enthusiasm sits next to concrete specifics",
    ),
  },

  section_scaffold: {
    weight: 0.4,
    question: noul(
      {
        question:
          "Is `post.text` organised under a symmetric scaffold of announced section labels imposed on the content, such as 'The problem: / The solution: / The result:' or 'What went well: / What didn't: / Where it stands:'?",
        focus:
          "Parallel labels, each followed by a short block, where the structure is a template rather than something the content needs. A genuine list of steps, specs or requirements is NOT this.",
      },
      "Three or more parallel section labels frame the post like a template",
      "No such labels, or a list the content genuinely requires (steps, specs, a job's requirements)",
    ),
  },
};

const EM_DASH = "\u2014";

/** Emoji, bullet, "-", "*" or "1." at the start of a line. */
const LIST_MARKER = /^\s*(?:[-*]|\d{1,2}[.)])\s+/;

/**
 * A list row with a short label and a spaced em dash: "\u{1F4DA} Deep Work \u2014 essential".
 *
 * The list marker is required. Without it, two ordinary sentences with an early dash
 * ("Most teams don't fail at AI \u2014 they fail at data.") would pass as a list and drop
 * out of the count, and those are exactly the posts the feature is for.
 */
function isLabelRow(line: string): boolean {
  const m = line.match(LEADING_EMOJI) ?? line.match(LIST_MARKER);
  if (!m) return false;
  return /^[^\n\u2014]{1,40}\s\u2014\s/.test(line.slice(m[0].length));
}

/** "2020\u20142024": a range typed with the long dash, not a sentence separator. */
function isRange(line: string, i: number): boolean {
  return /\d\s?$/.test(line.slice(0, i)) && /^\s?\d/.test(line.slice(i + 1));
}

/**
 * Code-side dash feature, 0..1: separator em dashes, linear from 0 to DASH_FLAG_COUNT.
 * Counted here rather than asked, because jev-1.13 does not count reliably and a regex
 * counts exactly and for free.
 *
 * Only the em dash (U+2014) counts. The spaced en dash is ordinary German typography, and
 * a hyphen or "--" is what people type on a keyboard; chat models emit the em dash.
 * An absolute count rather than a density, because the tell is the habit: a human who
 * uses the character at all in a social post rarely uses it three times.
 *
 * Not counted:
 *  - ranges between digits, a wrong dash but not a separator
 *  - the separator of a label list: two or more marked rows like "\u{1F4DA} Title \u2014
 *    adjective". That shape is judged by emoji_bullets and engagement_farm_format;
 *    counting it here would flag a book list on its punctuation. Measured: the X
 *    listicle sample has 7 of them. Further dashes on such a row still count.
 *
 * Measured on samples/: 4 of 10 good LinkedIn posts carry exactly one separator em dash
 * (feature 0.33, not flagged); no slop post carries any outside a label list.
 */
export function dashSignal(text: string): number {
  const lines = text.split("\n");
  const isList = lines.filter(isLabelRow).length >= 2;
  let count = 0;
  for (const line of lines) {
    let skipLabel = isList && isLabelRow(line);
    for (let i = line.indexOf(EM_DASH); i >= 0; i = line.indexOf(EM_DASH, i + 1)) {
      if (skipLabel) {
        skipLabel = false; // only the first dash on a label line is the separator
        continue;
      }
      if (!isRange(line, i)) count++;
    }
  }
  return ramp(count, 0, DASH_FLAG_COUNT);
}
