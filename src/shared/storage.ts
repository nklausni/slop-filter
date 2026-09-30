import {
  DEFAULT_PLATFORM_SETTINGS,
  DEFAULT_SETTINGS,
  EMPTY_KEYS,
  PLATFORMS,
  PROVIDERS,
  isProvider,
  type ApiKeys,
  type Platform,
  type PlatformSettings,
  type Provider,
  type Settings,
} from "./types.ts";

const SETTINGS_KEY = "settings";
export const KEYS_KEY = "apiKeys";

/** Fields that versions up to 0.2.0 kept inside `settings`. */
interface LegacySettings {
  apiKey?: unknown;
  model?: unknown;
}

/**
 * Split a stored settings object from ≤0.2.0 into the current layout.
 *
 * Pure so it can be unit-tested: the old single `apiKey` was always a TypeSafe key and
 * the old `model` a TypeSafe model id, so both land on the `typesafe` slot. A key already
 * present in the key store wins over the legacy copy.
 */
export function migrateLegacy(
  stored: Partial<Settings> & LegacySettings,
  keys: Partial<ApiKeys>,
): { settings: Partial<Settings>; keys: ApiKeys; migrated: boolean } {
  const { apiKey, model, ...rest } = stored;
  const outKeys: ApiKeys = { ...EMPTY_KEYS, ...pickStrings(keys) };
  const migrated = apiKey !== undefined || model !== undefined;
  if (typeof apiKey === "string" && apiKey.trim() && !outKeys.typesafe) outKeys.typesafe = apiKey.trim();
  const settings: Partial<Settings> = { ...rest };
  if (typeof model === "string" && model.trim()) {
    settings.models = { ...DEFAULT_SETTINGS.models, ...(rest.models ?? {}), typesafe: model.trim() };
  }
  // An install that had a key but no provider choice was a TypeSafe install.
  if (!rest.provider && typeof apiKey === "string" && apiKey.trim()) settings.provider = "typesafe";
  return { settings, keys: outKeys, migrated };
}

function pickStrings(keys: Partial<ApiKeys>): Partial<ApiKeys> {
  const out: Partial<ApiKeys> = {};
  for (const p of PROVIDERS) if (typeof keys?.[p] === "string") out[p] = keys[p]!.trim();
  return out;
}

async function readRaw(): Promise<{ settings: Partial<Settings>; keys: ApiKeys }> {
  const got = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
  const m = migrateLegacy((got[SETTINGS_KEY] ?? {}) as Partial<Settings> & LegacySettings, got[KEYS_KEY] ?? {});
  if (m.migrated) {
    // Rewrite once so the key disappears from `settings`, which the content script sees.
    await chrome.storage.local.set({ [SETTINGS_KEY]: m.settings, [KEYS_KEY]: m.keys });
  }
  return m;
}

export async function loadSettings(): Promise<Settings> {
  const { settings: stored } = await readRaw();

  // Merge per-platform settings one level deeper than a spread would.
  const platforms = {} as Record<Platform, PlatformSettings>;
  for (const p of PLATFORMS) {
    platforms[p] = { ...DEFAULT_PLATFORM_SETTINGS[p], ...(stored.platforms?.[p] ?? {}) };
  }
  const models = { ...DEFAULT_SETTINGS.models };
  for (const p of PROVIDERS) {
    const m = stored.models?.[p];
    if (typeof m === "string" && m.trim()) models[p] = m.trim();
  }

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // An unknown value must never reach the base-URL lookup.
    provider: isProvider(stored.provider) ? stored.provider : DEFAULT_SETTINGS.provider,
    aiStyleMode: (["off", "badge", "collapse"] as const).includes(stored.aiStyleMode as never)
      ? (stored.aiStyleMode as Settings["aiStyleMode"])
      : DEFAULT_SETTINGS.aiStyleMode,
    models,
    interests: cleanList(stored.interests),
    excludedTopics: cleanList(stored.excludedTopics),
    allowHandles: cleanList(stored.allowHandles).map((h) => h.replace(/^@/, "").toLowerCase()),
    platforms,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = {
    ...current,
    ...patch,
    models: { ...current.models, ...(patch.models ?? {}) },
    platforms: { ...current.platforms, ...(patch.platforms ?? {}) },
  };
  if (!isProvider(next.provider)) next.provider = current.provider;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function loadKeys(): Promise<ApiKeys> {
  return (await readRaw()).keys;
}

export async function saveKeys(patch: Partial<ApiKeys>): Promise<ApiKeys> {
  const next: ApiKeys = { ...(await loadKeys()), ...pickStrings(patch) };
  await chrome.storage.local.set({ [KEYS_KEY]: next });
  return next;
}

export async function activeKey(provider: Provider): Promise<string> {
  return (await loadKeys())[provider] ?? "";
}

export function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 20); // keep the request small; 20 topics is plenty
}
