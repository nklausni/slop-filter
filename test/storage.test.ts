// Unit tests for the settings migration. No browser: migrateLegacy is pure.
//
//   npm test
//
// Up to 0.2.0 the TypeSafe key lived inside `settings`, and `settings` is what the content
// script is sent. The migration moves it into its own storage key; these cases pin down
// that it moves, that it lands on the right provider, and that nothing is lost.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { migrateLegacy } from "../src/shared/storage.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types.ts";

describe("migrateLegacy", () => {
  test("moves a legacy TypeSafe key out of settings", () => {
    const m = migrateLegacy({ apiKey: " ts-abc ", model: "jev-1.13.0", enabled: true } as Partial<Settings>, {});
    assert.equal(m.migrated, true);
    assert.equal(m.keys.typesafe, "ts-abc");
    assert.equal(m.keys.openrouter, "");
    assert.equal("apiKey" in m.settings, false);
    assert.equal("model" in m.settings, false);
  });

  test("a legacy install keeps using TypeSafe, not the new OpenRouter default", () => {
    const m = migrateLegacy({ apiKey: "ts-abc", model: "jev-1.13.0" } as Partial<Settings>, {});
    assert.equal(m.settings.provider, "typesafe");
    assert.equal(m.settings.models?.typesafe, "jev-1.13.0");
    assert.equal(m.settings.models?.openrouter, DEFAULT_SETTINGS.models.openrouter);
  });

  test("a legacy install without a key does not pin the provider", () => {
    const m = migrateLegacy({ apiKey: "", model: "jev-1.13.0" } as Partial<Settings>, {});
    assert.equal(m.settings.provider, undefined);
  });

  test("a key already in the key store wins over the legacy copy", () => {
    const m = migrateLegacy({ apiKey: "ts-old" } as Partial<Settings>, { typesafe: "ts-new" });
    assert.equal(m.keys.typesafe, "ts-new");
  });

  test("current-layout settings pass through untouched", () => {
    const stored: Partial<Settings> = { provider: "openrouter", models: { ...DEFAULT_SETTINGS.models } };
    const m = migrateLegacy(stored, { openrouter: "sk-or-v1-x" });
    assert.equal(m.migrated, false);
    assert.deepEqual(m.settings, stored);
    assert.equal(m.keys.openrouter, "sk-or-v1-x");
  });

  test("non-string key values are dropped rather than stored", () => {
    const m = migrateLegacy({}, { openrouter: 42 as unknown as string });
    assert.equal(m.keys.openrouter, "");
  });
});
