import { detectPlatform } from "../platforms/index.ts";
import type { Evaluation, LogEntry, Platform, Preset, SessionStats, Settings } from "../shared/types.ts";
import { PLATFORM_LABEL, PROVIDER_INFO, totalStats } from "../shared/types.ts";

const PRESETS: Preset[] = ["relaxed", "balanced", "strict"];
// jev-1.13 input price; output is free. Only used for responses that report no cost —
// OpenRouter returns the exact `usage.cost`, TypeSafe does not.
const PRICE_PER_MTOK = 0.042;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Which feed is the active tab on? Drives the per-platform controls. */
let current: Platform | null = null;

/**
 * The session log, refreshed by the poll below.
 *
 * Held in memory on purpose. A clipboard write must happen inside the user-activation
 * window that the click created, and awaiting the log fetch first spends that window —
 * `navigator.clipboard.writeText` then rejects and the copy silently does nothing.
 */
let cachedLog: LogEntry[] = [];
let cachedStats: SessionStats | null = null;

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (reply: T & { ok: boolean; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok) return reject(new Error(reply?.error ?? "Unknown error"));
      resolve(reply);
    });
  });
}

async function detectCurrentTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    current = tab?.url ? detectPlatform(new URL(tab.url).hostname) : null;
  } catch {
    current = null;
  }
}

function renderSettings(s: Settings, hasKey: boolean): void {
  $<HTMLInputElement>("enabled").checked = s.enabled;
  $<HTMLInputElement>("highlightInterests").checked = s.highlightInterests;

  $("platformBlock").hidden = !current;
  $("notOnFeed").hidden = !!current;
  if (current) {
    const ps = s.platforms[current];
    $("platformName").textContent = PLATFORM_LABEL[current];
    $<HTMLInputElement>("platformEnabled").checked = ps.enabled;
    const idx = Math.max(0, PRESETS.indexOf(ps.preset));
    $<HTMLInputElement>("preset").value = String(idx);
    $("presetLabel").textContent = ps.preset[0].toUpperCase() + ps.preset.slice(1);
  }

  const warn = $("warning");
  if (!hasKey) {
    warn.hidden = false;
    // Labels come from the fixed PROVIDER_INFO table, never from storage.
    warn.innerHTML = `No ${PROVIDER_INFO[s.provider].label} API key yet. <a href="#" id="warnOptions">Add it in settings</a>.`;
    warn.querySelector("#warnOptions")?.addEventListener("click", openOptions);
  } else if (s.highlightInterests && s.interests.length === 0) {
    warn.hidden = false;
    warn.innerHTML = `Highlighting is on but you have no interests listed. <a href="#" id="warnOptions">Add some</a>.`;
    warn.querySelector("#warnOptions")?.addEventListener("click", openOptions);
  } else {
    warn.hidden = true;
  }
}

function renderStats(st: SessionStats): void {
  const t = totalStats(st);
  $("statHidden").textContent = String(t.hidden);
  $("statHighlighted").textContent = String(t.highlighted);

  const cells: [Platform, string][] = [
    ["x", "x"],
    ["linkedin", "li"],
  ];
  for (const [p, prefix] of cells) {
    const s = st.byPlatform[p];
    $(`${prefix}Eval`).textContent = String(s.evaluated);
    $(`${prefix}Hidden`).textContent = String(s.hidden);
    $(`${prefix}Coll`).textContent = String(s.collapsed);
    $(`${prefix}Skip`).textContent = String(s.skipped);
    $(`${prefix}Cache`).textContent = String(s.cacheHits);
    $(`${prefix}Tok`).textContent = s.inputTokens.toLocaleString();
  }

  const cost = t.costUsd + (t.unpricedTokens / 1e6) * PRICE_PER_MTOK;
  $("dCost").textContent = `$${cost.toFixed(4)}`;
  $("dCost").title = t.unpricedTokens ? "Partly estimated from token counts" : "As reported by the provider";
  $("dModel").textContent = st.lastModel ?? "–";
  $("dErrors").textContent = String(st.errors);
  const le = $("lastError");
  le.hidden = !st.lastError;
  le.textContent = st.lastError ?? "";
}

function renderRecent(list: Evaluation[]): void {
  const box = $("recent");
  box.textContent = "";
  for (const e of list.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "r";
    const p = document.createElement("span");
    p.className = "plat";
    p.textContent = e.platform === "x" ? "X" : "in";
    const v = document.createElement("span");
    v.className = `v v-${e.verdict}`;
    v.textContent = `${e.verdict} ${Math.round(e.slopScore * 100)}%`;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = e.reason;
    why.title = e.reason;
    row.append(p, v, why);
    box.appendChild(row);
  }
}

async function refresh(): Promise<void> {
  const [{ settings, hasKey }, { stats }, { recent }, { log }] = await Promise.all([
    send<{ settings: Settings; hasKey: boolean }>({ kind: "get-settings" }),
    send<{ stats: SessionStats }>({ kind: "get-stats" }),
    send<{ recent: Evaluation[] }>({ kind: "get-recent" }),
    send<{ log: LogEntry[] }>({ kind: "get-log" }),
  ]);
  cachedLog = log;
  cachedStats = stats;
  renderSettings(settings, hasKey);
  renderStats(stats);
  renderRecent(recent);
  $<HTMLButtonElement>("copyLog").textContent = `Copy log (${log.length})`;
}

function openOptions(e?: Event): void {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

async function patch(p: Partial<Settings>): Promise<void> {
  const { settings, hasKey } = await send<{ settings: Settings; hasKey: boolean }>({ kind: "set-settings", patch: p });
  renderSettings(settings, hasKey);
}

/** Patch only the active tab's platform, leaving the other untouched. */
async function patchPlatform(p: Partial<Settings["platforms"][Platform]>): Promise<void> {
  if (!current) return;
  const { settings } = await send<{ settings: Settings }>({ kind: "get-settings" });
  await patch({ platforms: { ...settings.platforms, [current]: { ...settings.platforms[current], ...p } } });
}

$("enabled").addEventListener("change", (e) => patch({ enabled: (e.target as HTMLInputElement).checked }));
$("highlightInterests").addEventListener("change", (e) =>
  patch({ highlightInterests: (e.target as HTMLInputElement).checked }),
);
$("platformEnabled").addEventListener("change", (e) =>
  patchPlatform({ enabled: (e.target as HTMLInputElement).checked }),
);
$("preset").addEventListener("input", (e) => {
  const preset = PRESETS[Number((e.target as HTMLInputElement).value)] ?? "balanced";
  $("presetLabel").textContent = preset[0].toUpperCase() + preset.slice(1);
});
$("preset").addEventListener("change", (e) => {
  const preset = PRESETS[Number((e.target as HTMLInputElement).value)] ?? "balanced";
  void patchPlatform({ preset });
});
/**
 * Copy the whole session's decisions as JSON.
 *
 * Counting badges in the feed undercounts badly — both platforms virtualize and only keep
 * about a dozen posts mounted — so this is the honest record of what the filter did.
 *
 * Built from the in-memory copy and written synchronously: an `await` before the clipboard
 * call spends the click's user activation and the write is rejected.
 */
function buildReport(): string {
  const log = cachedLog;
  const judged = log.filter((e) => e.v !== "skip");
  const suppressed = judged.filter((e) => e.v === "hide" || e.v === "collapse");
  const byDriver: Record<string, number> = {};
  for (const e of suppressed) byDriver[e.d] = (byDriver[e.d] ?? 0) + 1;
  const summary = {
    posts: log.length,
    judged: judged.length,
    skipped: log.length - judged.length,
    hidden: judged.filter((e) => e.v === "hide").length,
    collapsed: judged.filter((e) => e.v === "collapse").length,
    highlighted: judged.filter((e) => e.v === "highlight").length,
    suppressionRate: judged.length ? Number((suppressed.length / judged.length).toFixed(3)) : null,
    topDrivers: Object.entries(byDriver).sort((a, b) => b[1] - a[1]).slice(0, 8),
    holisticBands: {
      "0.8-1.0": judged.filter((e) => e.h !== null && e.h >= 0.8).length,
      "0.5-0.8": judged.filter((e) => e.h !== null && e.h >= 0.5 && e.h < 0.8).length,
      "0.2-0.5": judged.filter((e) => e.h !== null && e.h >= 0.2 && e.h < 0.5).length,
      "0.0-0.2": judged.filter((e) => e.h !== null && e.h < 0.2).length,
    },
  };
  return JSON.stringify({ summary, stats: cachedStats, log }, null, 1);
}

/** execCommand is deprecated but still the reliable path inside an extension popup. */
function copyFallback(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

$("copyLog").addEventListener("click", () => {
  const status = $("copyStatus");
  if (!cachedLog.length) {
    status.textContent = "Nothing logged yet — scroll a feed first.";
    status.className = "status err";
    return;
  }
  const text = buildReport();
  const done = (msg: string, kind: "ok" | "err") => {
    status.textContent = msg;
    status.className = `status ${kind}`;
  };
  // Synchronous fallback first so the activation window is never at risk.
  if (copyFallback(text)) {
    done(`Copied ${cachedLog.length} decisions.`, "ok");
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => done(`Copied ${cachedLog.length} decisions.`, "ok"))
    .catch((e: Error) => done(`Could not copy: ${e.message}`, "err"));
});

$("openOptions").addEventListener("click", openOptions);
$("resetStats").addEventListener("click", async () => {
  await send({ kind: "reset-stats" });
  await refresh();
});
$("clearCache").addEventListener("click", async () => {
  await send({ kind: "clear-cache" });
  await refresh();
});

void (async () => {
  await detectCurrentTab();
  await refresh();
})();
const timer = setInterval(() => void refresh().catch(() => {}), 1500);
window.addEventListener("unload", () => clearInterval(timer));
