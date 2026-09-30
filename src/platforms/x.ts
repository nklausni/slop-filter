// X / Twitter DOM adapter.
//
// THE THING THAT MAKES X HARDER THAN LINKEDIN: the timeline is virtualized. X recycles
// `div[data-testid="cellInnerDiv"]` nodes as you scroll — the same element holds post A,
// then post F, then post Q. So identity is the status id from the permalink, never the
// DOM node, and the scan loop re-reads it every pass.

import type { PostState } from "../shared/types.ts";
import { cleanText, type PlatformAdapter } from "./types.ts";

const CELL = 'div[data-testid="cellInnerDiv"]';
const ARTICLE = 'article[data-testid="tweet"], article[role="article"]';
const TWEET_TEXT = 'div[data-testid="tweetText"]';

/** The quote-tweeted post, if any. Its subtree belongs to the quote, not to this post. */
function quoteContainer(article: HTMLElement): HTMLElement | null {
  for (const c of article.querySelectorAll<HTMLElement>('div[role="link"][tabindex="0"]')) {
    if (c.querySelector(TWEET_TEXT)) return c;
  }
  return null;
}

export const xAdapter: PlatformAdapter = {
  id: "x",

  findPosts() {
    const out: { container: HTMLElement; article: HTMLElement }[] = [];
    document.querySelectorAll<HTMLElement>(CELL).forEach((container) => {
      const article = container.querySelector<HTMLElement>(ARTICLE);
      if (article) out.push({ container, article });
    });
    // Fallback for layouts without cellInnerDiv.
    if (!out.length) {
      document.querySelectorAll<HTMLElement>(ARTICLE).forEach((article) => {
        const container =
          article.closest<HTMLElement>('div[role="listitem"]') ?? article.parentElement ?? article;
        out.push({ container, article });
      });
    }
    return out;
  },

  idOf(article) {
    // The timestamp link is the post's own permalink; other /status/ links may be quotes.
    const timeLink = article.querySelector<HTMLAnchorElement>('a[href*="/status/"] time')?.closest("a");
    const href =
      timeLink?.getAttribute("href") ??
      article.querySelector<HTMLAnchorElement>('a[href*="/status/"]')?.getAttribute("href");
    const m = href?.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  },

  /**
   * Detection is the leaf span whose text is exactly "Ad" or "Promoted".
   *
   * Do NOT use `[data-testid="placementTracking"]` for this. It looks like an ad marker
   * and is not: measured on a live timeline it wraps `videoPlayer`, matched 10 of 10
   * cells, and every video post in the feed got skipped as an ad. A plain check on
   * innerText does not work either, because X collapses a promoted article into a single
   * text node — hence textContent on leaf spans.
   */
  isPromoted(article) {
    const social = article.querySelector<HTMLElement>('[data-testid="socialContext"]')?.textContent ?? "";
    if (/^\s*(Ad|Promoted)\s*$/.test(social)) return true;
    return [...article.querySelectorAll("span")].some(
      (sp) => sp.children.length === 0 && /^(Ad|Promoted)$/.test(sp.textContent?.trim() ?? ""),
    );
  },

  scrape(article, id): PostState {
    const quote = quoteContainer(article);

    // Main text = the first tweetText NOT inside the quote subtree.
    let text = "";
    for (const node of article.querySelectorAll<HTMLElement>(TWEET_TEXT)) {
      if (quote && quote.contains(node)) continue;
      text = cleanText(node.innerText);
      break;
    }
    const quotedText = quote
      ? cleanText(quote.querySelector<HTMLElement>(TWEET_TEXT)?.innerText ?? "")
      : "";

    // Author identity from the profile link href, NOT from innerText: on promoted posts X
    // renders the whole article as one text node ("FOX One@foxoneAdBig matchups...") and
    // any line-splitting approach returns nothing. The href was correct on 7/7 posts.
    let author = "";
    let handle = "";
    const nameBlock = [...article.querySelectorAll<HTMLElement>('div[data-testid="User-Name"]')].find(
      (n) => !quote || !quote.contains(n),
    );
    if (nameBlock) {
      const href = [...nameBlock.querySelectorAll<HTMLAnchorElement>('a[role="link"][href^="/"]')]
        .map((l) => l.getAttribute("href") ?? "")
        .find((h) => /^\/[A-Za-z0-9_]{1,15}$/.test(h));
      if (href) handle = href.slice(1).toLowerCase();
      author = nameBlock.querySelector<HTMLElement>('a[role="link"] span')?.textContent?.trim() ?? "";
    }

    const socialContext = article.querySelector<HTMLElement>('[data-testid="socialContext"]')?.innerText ?? "";

    return {
      platform: "x",
      id,
      author,
      handle,
      authorHeadline: "",
      text,
      quotedText,
      hasMedia: !!article.querySelector(
        '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="tweetGif"], [data-testid="card.wrapper"], [data-testid="videoComponent"]',
      ),
      hasLink: !!article.querySelector('a[href^="https://t.co/"], [data-testid="card.wrapper"]'),
      isRepost: /repost/i.test(socialContext),
      isQuote: !!quote,
      isReply: /Replying to\s*@/.test(article.innerText),
      isPromoted: xAdapter.isPromoted(article),
      isSuggested: false,
    };
  },
};
