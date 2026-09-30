// LinkedIn feed DOM adapter.
//
// Two layouts are supported, both verified against a live feed on 2026-09-21:
//  - SDUI feed (2026): cards are div[role="listitem"][componentkey^="update-card-focus<id>"],
//    text in [data-testid="expandable-text-box"], no URNs anywhere in the DOM.
//  - classic feed: div[data-urn^="urn:li:activity:"] / .feed-shared-update-v2.
//
// Unlike X, LinkedIn does not recycle cards, so a card's identity is stable — but the
// content script treats both platforms the same way regardless, which costs nothing.

import type { PostState } from "../shared/types.ts";
import { cleanText, type PlatformAdapter } from "./types.ts";

const SDUI_CARD = 'div[role="listitem"][componentkey^="update-card-focus"]';
const SDUI_CARD_PREFIX = "update-card-focus";
const SDUI_TEXT = '[data-testid="expandable-text-box"]';

/**
 * LinkedIn's ad label, English and German. Deliberately not "Werbung": the header lines
 * include the author's headline, and "Werbung" is common in marketing people's headlines.
 */
export const PROMOTED_LABEL = /\b(promoted|anzeige|gesponsert)\b/i;

/**
 * LinkedIn's label above a post from an account you do not follow ("Suggested",
 * German "Vorgeschlagen"). Matched at the START of a header line only, so a headline
 * that merely contains the word does not count; no trailing boundary, in case the label
 * is glued to the next node the way "Feed post" is glued to the actor's name.
 */
const SUGGESTED_LINE = /^(suggested|vorgeschlagen)/i;

export function isSuggestedHeader(lines: string[]): boolean {
  return lines.some((l) => SUGGESTED_LINE.test(l.trim()));
}

const POST_SELECTORS = [
  SDUI_CARD,
  'div[data-urn^="urn:li:activity:"]',
  'div[data-id^="urn:li:activity:"]',
  'div[data-urn^="urn:li:aggregate:"]',
  'div[data-id^="urn:li:aggregate:"]',
  "div.feed-shared-update-v2",
];

const TEXT_SELECTORS = [
  SDUI_TEXT,
  ".update-components-text",
  ".feed-shared-update-v2__description",
  ".feed-shared-inline-show-more-text",
  ".feed-shared-text",
  '[data-test-id="main-feed-activity-card__commentary"]',
];

function outermostPost(el: HTMLElement): HTMLElement {
  let cur: HTMLElement = el;
  let parent = el.parentElement;
  while (parent && parent !== document.body) {
    if (POST_SELECTORS.some((s) => parent!.matches(s))) cur = parent;
    parent = parent.parentElement;
  }
  return cur;
}

function firstText(el: HTMLElement, sels: string[]): string {
  for (const sel of sels) {
    const n = el.querySelector<HTMLElement>(sel);
    if (n) {
      const t = cleanText(n.innerText);
      if (t) return t;
    }
  }
  return "";
}

function textOf(el: HTMLElement): string {
  const t = firstText(el, TEXT_SELECTORS);
  if (t) return t;
  // Fallback: the longest dir="ltr" span (classic LinkedIn wraps commentary in one).
  let best = "";
  el.querySelectorAll<HTMLElement>('span[dir="ltr"]').forEach((s) => {
    const c = cleanText(s.innerText);
    if (c.length > best.length) best = c;
  });
  return best;
}

/**
 * The actor's name, from the avatar's alt text.
 *
 * Do NOT parse this out of innerText. Measured on a live SDUI feed, LinkedIn glues the
 * "Feed post" label straight onto the name in one text node, so a line-based parse returns
 * "Feed postFinley Topping comm". The alt text is structural and carries one of two
 * shapes: "View <Name>'s profile" or "View company: <Company>". 15 of 18 cards on a live
 * feed; the rest have no avatar in the card at all.
 *
 * This is the same failure the X adapter hit on promoted posts, for the same reason.
 */
function actorName(el: HTMLElement): string {
  for (const img of el.querySelectorAll("img")) {
    const alt = (img.getAttribute("alt") ?? "").trim();
    let m = alt.match(/^View company:\s*(.+)$/i);
    if (m) return m[1].trim();
    m = alt.match(/^View\s+(.+?)[’']s profile$/i);
    if (m) return m[1].trim();
  }
  return "";
}

function scrapeSdui(el: HTMLElement, id: string): PostState {
  const box = el.querySelector<HTMLElement>(SDUI_TEXT);
  const text = box ? cleanText(box.innerText) : textOf(el);
  const firstTextLine = text.split("\n")[0]?.trim() ?? "";

  // Everything before the post text is the header; strip the known noise lines.
  const allLines = el.innerText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const cut = firstTextLine ? allLines.indexOf(firstTextLine) : -1;
  const header = (cut >= 0 ? allLines.slice(0, cut) : allLines.slice(0, 8)).slice(0, 10);
  const headerJoined = header.join(" | ").toLowerCase();
  const author = actorName(el);

  // authorHeadline is deliberately left empty.
  //
  // It can be recovered from the header lines, but innerText glues "• 2nd", "16,631
  // followers" and "Promoted" onto it, so the parse is unreliable — and nothing reads it:
  // no question on either platform references `author_headline`. Emitting it would cost
  // tokens to ship noise. If a question ever needs it, fix the parse then, with a test.

  const hasMedia =
    !!el.querySelector(
      'video, img[src*="feedshare"], img[src*="videocover"], img[src*="/articles/"], [data-testid*="video"], [data-testid*="image"]',
    ) || [...el.querySelectorAll<HTMLImageElement>("img")].some((i) => i.width >= 200);

  return {
    platform: "linkedin",
    id,
    author,
    handle: "",
    authorHeadline: "",
    text,
    quotedText: "",
    hasMedia,
    hasLink: !!el.querySelector('a[href^="https://lnkd.in/"], .update-components-article'),
    isRepost: /reposted this/.test(headerJoined),
    isQuote: false,
    isReply: false,
    isPromoted: PROMOTED_LABEL.test(headerJoined),
    isSuggested: isSuggestedHeader(header),
  };
}

function scrapeClassic(el: HTMLElement, id: string): PostState {
  const author = firstText(el, [
    '.update-components-actor__title span[aria-hidden="true"]',
    ".update-components-actor__title",
    ".update-components-actor__name",
    ".feed-shared-actor__name",
  ]);
  const authorHeadline = firstText(el, [
    '.update-components-actor__description span[aria-hidden="true"]',
    ".update-components-actor__description",
    ".feed-shared-actor__description",
  ]);
  const header = firstText(el, [".update-components-header", ".feed-shared-header"]).toLowerCase();
  const subDesc = firstText(el, [
    ".update-components-actor__sub-description",
    ".feed-shared-actor__sub-description",
  ]).toLowerCase();

  return {
    platform: "linkedin",
    id,
    author,
    handle: "",
    authorHeadline,
    text: textOf(el),
    quotedText: "",
    hasMedia: !!el.querySelector(
      ".update-components-image, .update-components-video, .update-components-linkedin-video, .update-components-article, .update-components-document, .update-components-poll, video, .feed-shared-image, .feed-shared-article",
    ),
    hasLink: !!el.querySelector('a[href^="https://lnkd.in/"], .update-components-article'),
    isRepost:
      /reposted|shared this/.test(header) || !!el.querySelector(".update-components-mini-update-v2"),
    isQuote: false,
    isReply: false,
    isPromoted: PROMOTED_LABEL.test(subDesc) || PROMOTED_LABEL.test(header),
    isSuggested: isSuggestedHeader(header.split("\n")),
  };
}

export const linkedinAdapter: PlatformAdapter = {
  id: "linkedin",

  findPosts() {
    const seen = new Set<HTMLElement>();
    const out: { container: HTMLElement; article: HTMLElement }[] = [];
    for (const sel of POST_SELECTORS) {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        // Nested matches (an aggregate wrapping an activity) → keep the outermost.
        const outer = outermostPost(el);
        if (!seen.has(outer)) {
          seen.add(outer);
          // LinkedIn has no inner "article": the card is both container and content.
          out.push({ container: outer, article: outer });
        }
      });
    }
    return out;
  },

  idOf(el) {
    const ck = el.getAttribute("componentkey");
    if (ck && ck.startsWith(SDUI_CARD_PREFIX)) {
      const id = ck.slice(SDUI_CARD_PREFIX.length);
      return id ? `sdui:${id}` : null;
    }
    const raw = el.getAttribute("data-urn") ?? el.getAttribute("data-id");
    if (raw && /^urn:li:/.test(raw)) return raw;
    const inner = el.querySelector<HTMLElement>('[data-urn^="urn:li:"],[data-id^="urn:li:"]');
    return inner?.getAttribute("data-urn") ?? inner?.getAttribute("data-id") ?? null;
  },

  isPromoted(el) {
    // Classic layout puts it in the actor sub-description. SDUI has no such node, so fall
    // back to the header text above the post body — where "Promoted" ends up glued to the
    // follower count, hence a substring test rather than a line match.
    if (
      PROMOTED_LABEL.test(
        firstText(el, [
          ".update-components-actor__sub-description",
          ".feed-shared-actor__sub-description",
          ".update-components-header",
        ]),
      )
    ) {
      return true;
    }
    const box = el.querySelector<HTMLElement>(SDUI_TEXT);
    const body = box ? (box.innerText.trim().split("\n")[0]?.trim() ?? "") : "";
    const lines = el.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const cut = body ? lines.indexOf(body) : -1;
    return PROMOTED_LABEL.test((cut >= 0 ? lines.slice(0, cut) : lines.slice(0, 8)).join(" "));
  },

  scrape(el, id) {
    return el.matches(SDUI_CARD) ? scrapeSdui(el, id) : scrapeClassic(el, id);
  },
};
