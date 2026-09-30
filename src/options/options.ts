import {
  EMPTY_KEYS,
  PLATFORMS,
  PROVIDER_INFO,
  isProvider,
  type ApiKeys,
  type Platform,
  type PlatformSettings,
  type Preset,
  type Provider,
  type Settings,
} from "../shared/types.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (reply: T & { ok: boolean; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok) return reject(new Error(reply?.error ?? "Unknown error"));
      resolve(reply);
    });
  });
}

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function setStatus(el: HTMLElement, text: string, kind: "ok" | "err" | ""): void {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// The key and model inputs show whichever provider is selected; edits to the other one
// are kept here until Save so switching back and forth loses nothing.
let provider: Provider = "openrouter";
/** As loaded, so settings without a control on this page (X has no label rules) survive a save. */
let loadedPlatforms: Settings["platforms"] | null = null;
const keyDrafts: ApiKeys = { ...EMPTY_KEYS };
/** What is actually stored, so "Test key" can say when a working key is not saved yet. */
const savedKeys: ApiKeys = { ...EMPTY_KEYS };
const modelDrafts = {} as Record<Provider, string>;

function stashProviderInputs(): void {
  keyDrafts[provider] = $<HTMLInputElement>("apiKey").value.trim();
  modelDrafts[provider] = $<HTMLInputElement>("model").value.trim();
}

function showProvider(p: Provider): void {
  provider = p;
  const info = PROVIDER_INFO[p];
  $<HTMLSelectElement>("provider").value = p;
  const link = $<HTMLAnchorElement>("keyLink");
  link.href = info.keyUrl;
  link.textContent = info.keyUrl.replace(/^https:\/\//, "");
  $("keyHost").textContent = new URL(info.baseUrl).host;
  $("pinnedModel").textContent = p === "openrouter" ? "typesafe/jev-1.13" : "jev-1.13.0";
  const key = $<HTMLInputElement>("apiKey");
  key.placeholder = info.keyPlaceholder;
  key.value = keyDrafts[p];
  const model = $<HTMLInputElement>("model");
  model.placeholder = info.defaultModel;
  model.value = modelDrafts[p] ?? info.defaultModel;
  setStatus($("keyStatus"), "", "");
}

async function load(): Promise<void> {
  const [{ settings }, { keys }] = await Promise.all([
    send<{ settings: Settings }>({ kind: "get-settings" }),
    send<{ keys: ApiKeys }>({ kind: "get-keys" }),
  ]);
  Object.assign(keyDrafts, keys);
  Object.assign(savedKeys, keys);
  Object.assign(modelDrafts, settings.models);
  showProvider(settings.provider);
  $<HTMLTextAreaElement>("interests").value = settings.interests.join("\n");
  $<HTMLTextAreaElement>("excludedTopics").value = settings.excludedTopics.join("\n");
  $<HTMLTextAreaElement>("allowHandles").value = settings.allowHandles.map((h) => `@${h}`).join("\n");
  $<HTMLSelectElement>("hideMode").value = settings.hideMode;
  $<HTMLInputElement>("showBadges").checked = settings.showBadges;
  $<HTMLSelectElement>("aiStyleMode").value = settings.aiStyleMode;
  $<HTMLInputElement>("maxPostChars").value = String(settings.maxPostChars);

  loadedPlatforms = settings.platforms;
  for (const p of PLATFORMS) {
    const ps = settings.platforms[p];
    for (const k of ["hidePromoted", "hideSuggested"] as const) {
      const box = document.getElementById(`${p}-${k}`) as HTMLInputElement | null;
      if (box) box.checked = ps[k];
    }
    $<HTMLInputElement>(`${p}-enabled`).checked = ps.enabled;
    $<HTMLSelectElement>(`${p}-preset`).value = ps.preset;
    $<HTMLInputElement>(`${p}-minPostChars`).value = String(ps.minPostChars);
    $<HTMLInputElement>(`${p}-skipReplies`).checked = ps.skipReplies;
  }
}

/** A checkbox's state, or the loaded value when this platform has no such control. */
function checkedOr(id: string, fallback: boolean): boolean {
  const box = document.getElementById(id) as HTMLInputElement | null;
  return box ? box.checked : fallback;
}

function readPlatform(p: Platform): PlatformSettings {
  const loaded = loadedPlatforms?.[p];
  return {
    hidePromoted: checkedOr(`${p}-hidePromoted`, loaded?.hidePromoted ?? false),
    hideSuggested: checkedOr(`${p}-hideSuggested`, loaded?.hideSuggested ?? false),
    enabled: $<HTMLInputElement>(`${p}-enabled`).checked,
    preset: $<HTMLSelectElement>(`${p}-preset`).value as Preset,
    minPostChars: Math.max(0, Math.min(500, Number($<HTMLInputElement>(`${p}-minPostChars`).value) || 0)),
    skipReplies: $<HTMLInputElement>(`${p}-skipReplies`).checked,
  };
}

async function save(): Promise<void> {
  const platforms = {} as Record<Platform, PlatformSettings>;
  for (const p of PLATFORMS) platforms[p] = readPlatform(p);

  stashProviderInputs();
  const models = {} as Record<Provider, string>;
  for (const p of Object.keys(PROVIDER_INFO) as Provider[]) models[p] = modelDrafts[p] || PROVIDER_INFO[p].defaultModel;

  const patch: Partial<Settings> = {
    provider,
    models,
    interests: linesOf($<HTMLTextAreaElement>("interests").value),
    excludedTopics: linesOf($<HTMLTextAreaElement>("excludedTopics").value),
    allowHandles: linesOf($<HTMLTextAreaElement>("allowHandles").value).map((h) => h.replace(/^@/, "").toLowerCase()),
    hideMode: $<HTMLSelectElement>("hideMode").value as Settings["hideMode"],
    showBadges: $<HTMLInputElement>("showBadges").checked,
    aiStyleMode: $<HTMLSelectElement>("aiStyleMode").value as Settings["aiStyleMode"],
    maxPostChars: Math.max(500, Math.min(12000, Number($<HTMLInputElement>("maxPostChars").value) || 4000)),
    platforms,
  };
  try {
    // Keys first: the settings save broadcasts to open feeds, which should then find a key.
    await send({ kind: "set-keys", keys: keyDrafts });
    Object.assign(savedKeys, keyDrafts);
    await send({ kind: "set-settings", patch });
    setStatus($("saveStatus"), "Saved. Open X or LinkedIn and the feed will re-evaluate.", "ok");
  } catch (e) {
    setStatus($("saveStatus"), (e as Error).message, "err");
  }
}

$("save").addEventListener("click", () => void save());
$("provider").addEventListener("change", (e) => {
  const next = (e.target as HTMLSelectElement).value;
  if (!isProvider(next)) return;
  stashProviderInputs();
  showProvider(next);
});
$("toggleKey").addEventListener("click", () => {
  const input = $<HTMLInputElement>("apiKey");
  input.type = input.type === "password" ? "text" : "password";
  $("toggleKey").textContent = input.type === "password" ? "Show" : "Hide";
});
$("testKey").addEventListener("click", async () => {
  const status = $("keyStatus");
  setStatus(status, "Testing…", "");
  try {
    const apiKey = $<HTMLInputElement>("apiKey").value.trim();
    const { message } = await send<{ message: string }>({
      kind: "test-key",
      provider,
      apiKey,
      model: $<HTMLInputElement>("model").value.trim(),
    });
    // Testing does not store anything; say so, or the feed keeps failing without a key.
    const unsaved = apiKey !== savedKeys[provider] ? " Not saved yet: click Save to use it." : "";
    setStatus(status, message + unsaved, "ok");
  } catch (e) {
    setStatus(status, (e as Error).message, "err");
  }
});

void load();
