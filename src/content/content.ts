// One content script for both feeds. It owns discovery, the scan loop, verdict
// application, and messaging; everything platform-specific lives behind a PlatformAdapter.
//
// The recycling-safe identity handling (re-read the id every pass, discard a verdict if
// the node changed underneath an in-flight request) is applied on both platforms. X needs
// it because its timeline is virtualized; LinkedIn does not, but running one code path
// costs nothing and removes a whole class of "works on one, subtly broken on the other".

import { ADAPTERS, detectPlatform, type PlatformAdapter } from "../platforms/index.ts";
import type { Evaluation, Message, Platform, PlatformSettings, SessionStats, Settings, Verdict } from "../shared/types.ts";
import { DEFAULT_PLATFORM_SETTINGS, DEFAULT_SETTINGS } from "../shared/types.ts";

/** Injected by scripts/build.mjs so two builds of the same version are distinguishable. */
declare const __BUILD_STAMP__: string;
const VERSION = `${chrome.runtime.getManifest?.().version ?? "?"}+${typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : "dev"}`;

const ATTR_STATE = "data-slopf"; // pending | evaluated | skipped | error
const ATTR_ID = "data-slopf-id"; // post id this node was last decorated for

const CLS = {
  hidden: "slopf-hidden",
  removed: "slopf-removed",
  collapsed: "slopf-collapsed",
  highlight: "slopf-highlight",
  badge: "slopf-badge",
  placeholder: "slopf-placeholder",
  overlay: "slopf-overlay",
  revealed: "slopf-revealed",
};

const platform: Platform | null = detectPlatform();
let adapter: PlatformAdapter;
let settings: Settings = { ...DEFAULT_SETTINGS };
/** Whether the active provider has a key. The key itself never reaches this script. */
let hasKey = false;
const revealedIds = new Set<string>();
const reported = new Set<string>();
let scanTimer: number | undefined;

function platformSettings(): PlatformSettings {
  return settings.platforms?.[platform!] ?? DEFAULT_PLATFORM_SETTINGS[platform!];
}

function active(): boolean {
  return !!platform && settings.enabled && platformSettings().enabled;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Mirror the service worker's running totals onto <html data-slopf-stats>.
 *
 * Both feeds virtualize, so counting badges in the DOM only ever sees the handful of posts
 * currently mounted — that undercounts a long scroll badly. These are the real cumulative
 * numbers, readable without an extension context.
 */
function mirrorStats(stats: SessionStats | undefined): void {
  if (!stats || !platform) return;
  const p = stats.byPlatform[platform];
  if (!p) return;
  const suppressed = p.hidden + p.collapsed;
  document.documentElement.setAttribute(
    "data-slopf-stats",
    JSON.stringify({
      evaluated: p.evaluated,
      cacheHits: p.cacheHits,
      hidden: p.hidden,
      collapsed: p.collapsed,
      highlighted: p.highlighted,
      skipped: p.skipped,
      seen: p.evaluated + p.cacheHits + p.skipped,
      suppressionRate: p.evaluated + p.cacheHits > 0
        ? Number((suppressed / (p.evaluated + p.cacheHits)).toFixed(3))
        : null,
      inputTokens: p.inputTokens,
      errors: stats.errors,
    }),
  );
}

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (reply: T & { ok: boolean; error?: string }) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!reply) return reject(new Error("No reply from service worker"));
        if (!reply.ok) return reject(new Error(reply.error ?? "Unknown error"));
        resolve(reply);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Applying verdicts
// ---------------------------------------------------------------------------

function clearDecorations(container: HTMLElement, article: HTMLElement): void {
  article.classList.remove(CLS.collapsed, CLS.highlight, CLS.revealed);
  container.classList.remove(CLS.removed, CLS.hidden);
  container.querySelectorAll(`.${CLS.badge}, .${CLS.overlay}, .${CLS.placeholder}`).forEach((n) => n.remove());
}

function apply(container: HTMLElement, article: HTMLElement, ev: Evaluation): void {
  clearDecorations(container, article);
  container.setAttribute(ATTR_STATE, "evaluated");
  container.setAttribute(ATTR_ID, ev.id);
  if (!active()) return;

  const wasRevealed = revealedIds.has(ev.id);
  if (settings.showBadges) article.appendChild(makeBadge(ev));

  switch (ev.verdict) {
    case "hide":
      if (wasRevealed) break;
      if (settings.hideMode === "remove") {
        container.classList.add(CLS.removed);
      } else {
        // The class goes on the CONTAINER and the CSS hides its children except the
        // placeholder, which is itself a child. Putting it on the article breaks LinkedIn,
        // where container === article. The placeholder stays inside the container so a
        // virtualizer still measures a sane height.
        container.classList.add(CLS.hidden);
        container.insertBefore(makePlaceholder(container, ev), container.firstChild);
      }
      break;
    case "collapse":
      if (wasRevealed) break;
      article.classList.add(CLS.collapsed);
      article.appendChild(makeOverlay(article, ev));
      break;
    case "highlight":
      article.classList.add(CLS.highlight);
      break;
    case "show":
      break;
  }

  if (!reported.has(ev.id)) {
    reported.add(ev.id);
    send<{ stats?: SessionStats }>({
      kind: "outcome",
      platform: ev.platform,
      verdict: ev.verdict as Verdict,
      excluded: ev.reason.startsWith("excluded topic"),
    })
      .then((r) => mirrorStats(r.stats))
      .catch(() => {});
  }
}

function makeBadge(ev: Evaluation): HTMLElement {
  const b = document.createElement("div");
  b.className = `${CLS.badge} slopf-badge--${ev.verdict}`;
  b.textContent = `slop ${Math.round(ev.slopScore * 100)}%`;
  const structural = Object.entries(ev.structural)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ${v.toFixed(2)}`);
  b.title = [
    ev.reason,
    "",
    ev.holistic !== null ? `holistic P(slop): ${ev.holistic.toFixed(2)}` : "",
    "",
    ...Object.entries(ev.signals)
      .sort((a, b2) => b2[1] - a[1])
      .map(([k, v]) => `${k}: ${v.toFixed(2)}`),
    ev.substance !== null ? `substance: ${ev.substance.toFixed(2)}` : "",
    ...(structural.length ? ["", "structural (code-side):", ...structural] : []),
    ev.fromCache ? "\n(cached)" : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return b;
}

function makePlaceholder(container: HTMLElement, ev: Evaluation): HTMLElement {
  const p = document.createElement("div");
  p.className = CLS.placeholder;
  const label = document.createElement("span");
  label.textContent = `Hidden · ${shortReason(ev)}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Show";
  btn.addEventListener("click", () => {
    revealedIds.add(ev.id);
    p.remove();
    container.classList.remove(CLS.hidden);
    container.classList.add(CLS.revealed);
  });
  p.append(label, btn);
  return p;
}

function makeOverlay(article: HTMLElement, ev: Evaluation): HTMLElement {
  const o = document.createElement("div");
  o.className = CLS.overlay;
  const label = document.createElement("span");
  label.textContent = `Probably slop · ${shortReason(ev)}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Show anyway";
  btn.addEventListener("click", () => {
    revealedIds.add(ev.id);
    o.remove();
    article.classList.remove(CLS.collapsed);
    article.classList.add(CLS.revealed);
  });
  o.append(label, btn);
  return o;
}

/**
 * The one-line "why".
 *
 * Ranks the code-side structural features alongside the model signals. Measured on a live
 * timeline: a post hidden because `hashtag_spam` hit 1.00 was labelled "ai prose, hype
 * shill" (0.53 / 0.19, neither decisive) because this only looked at the signals. An
 * explanation that names the wrong cause is worse than none.
 */
function shortReason(ev: Evaluation): string {
  if (ev.reason.startsWith("excluded topic")) return ev.reason.split(" (")[0];
  if (ev.reason.startsWith("interest")) return ev.reason.split(" (")[0];
  const top = [...Object.entries(ev.signals), ...Object.entries(ev.structural)]
    .filter(([, v]) => v > 0.15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k.replace(/_/g, " "));
  return `${Math.round(ev.slopScore * 100)}%${top.length ? " · " + top.join(", ") : ""}`;
}

// ---------------------------------------------------------------------------
// Scan loop
// ---------------------------------------------------------------------------

async function processPost(container: HTMLElement, article: HTMLElement): Promise<void> {
  const id = adapter.idOf(article);
  if (!id) return;

  // If this node was decorated for a different post, it was recycled. Start over.
  const decoratedFor = container.getAttribute(ATTR_ID);
  if (decoratedFor && decoratedFor !== id) {
    clearDecorations(container, article);
    container.removeAttribute(ATTR_STATE);
    container.removeAttribute(ATTR_ID);
  } else {
    const state = container.getAttribute(ATTR_STATE);
    if (state === "pending" || state === "evaluated" || state === "skipped") return;
  }

  const ps = platformSettings();
  const post = adapter.scrape(article, id);

  const skip =
    post.isPromoted || // the platform already labels these; ad blocking is not our job
    (ps.skipReplies && post.isReply) ||
    (post.handle && settings.allowHandles.includes(post.handle)) ||
    post.text.length < ps.minPostChars;

  if (skip) {
    container.setAttribute(ATTR_STATE, "skipped");
    container.setAttribute(ATTR_ID, id);
    send<{ stats?: SessionStats }>({ kind: "skipped", platform: post.platform })
      .then((r) => mirrorStats(r.stats))
      .catch(() => {});
    return;
  }

  container.setAttribute(ATTR_STATE, "pending");
  container.setAttribute(ATTR_ID, id);
  try {
    const reply = await send<{ evaluation: Evaluation }>({ kind: "evaluate", post });
    // The node may have been recycled while we awaited.
    if (adapter.idOf(article) !== id) return;
    apply(container, article, reply.evaluation);
  } catch (e) {
    container.setAttribute(ATTR_STATE, "error");
    article.title = `Slop Filter: ${(e as Error).message}`;
    console.warn("[Slop Filter]", (e as Error).message);
  }
}

function scan(): void {
  if (!active()) return;
  const posts = adapter.findPosts();
  document.documentElement.setAttribute("data-slopf-posts", String(posts.length));
  document.documentElement.setAttribute("data-slopf-platform", platform!);
  // Which build is actually loaded? Chrome keeps running the old content script until the
  // extension is reloaded, so "did my change take effect" is otherwise unanswerable from
  // the page.
  document.documentElement.setAttribute("data-slopf-version", VERSION);
  for (const { container, article } of posts) void processPost(container, article);
}

function scheduleScan(): void {
  if (scanTimer) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, 250);
}

/** Drop all decorations so posts get re-evaluated. The cache makes this nearly free. */
function resetAll(): void {
  document.querySelectorAll<HTMLElement>(`[${ATTR_STATE}]`).forEach((container) => {
    const found = adapter.findPosts().find((p) => p.container === container);
    clearDecorations(container, found?.article ?? container);
    container.removeAttribute(ATTR_STATE);
    container.removeAttribute(ATTR_ID);
  });
  reported.clear();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (!platform) return; // not a feed we handle
  adapter = ADAPTERS[platform];

  try {
    const reply = await send<{ settings: Settings; hasKey: boolean }>({ kind: "get-settings" });
    settings = reply.settings;
    hasKey = reply.hasKey;
  } catch {
    /* keep defaults */
  }

  // Settings changes are pushed by the service worker rather than read from
  // chrome.storage.onChanged: that event carries every changed value in the area, so a
  // listener here would receive the API key whenever it is saved. This script never
  // touches chrome.storage at all, which lets the worker lock storage to trusted contexts.
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg?.kind !== "settings-changed") return;
    const prev = settings;
    const prevHasKey = hasKey;
    settings = { ...DEFAULT_SETTINGS, ...msg.settings };
    hasKey = msg.hasKey;
    // Anything that changes verdicts or presentation → re-evaluate everything. A key that
    // just appeared (or a provider switch) retries posts that failed without one.
    const changed =
      hasKey !== prevHasKey ||
      (["enabled", "highlightInterests", "interests", "excludedTopics", "hideMode", "showBadges", "provider", "models", "maxPostChars", "allowHandles"] as const).some(
        (k) => JSON.stringify(prev[k]) !== JSON.stringify(settings[k]),
      ) || JSON.stringify(prev.platforms?.[platform]) !== JSON.stringify(settings.platforms?.[platform]);
    if (changed) {
      resetAll();
      if (active()) scheduleScan();
    }
  });

  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
  scan();
}

void init();
