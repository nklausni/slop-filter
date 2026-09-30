// Unit tests for the OpenRouter key verdict. No key, no network: the verdict is pure.
//
//   npm test
//
// "Test key" is the only moment the user is looking at the options page. A key that is
// valid but cannot pay fails later, on the first post, where nobody sees it — so these
// cases pin down which states are reported as errors and which only as a warning.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { openRouterKeyVerdict, type OpenRouterKeyInfo } from "../src/shared/typesafe.ts";

const key = (o: Partial<OpenRouterKeyInfo> = {}): OpenRouterKeyInfo => ({
  label: "sk-or-v1-abc...xyz",
  limit: null,
  limit_remaining: null,
  usage: 0,
  is_free_tier: false,
  ...o,
});

describe("openRouterKeyVerdict", () => {
  test("an exhausted spending limit is an error", () => {
    const v = openRouterKeyVerdict(key({ limit: 5, limit_remaining: 0, usage: 5 }));
    assert.equal(v.ok, false);
    assert.match(v.message, /\$5\.00 of \$5\.00/);
  });

  test("a free-tier key is an error, because Jev is paid", () => {
    const v = openRouterKeyVerdict(key({ is_free_tier: true }));
    assert.equal(v.ok, false);
    assert.match(v.message, /402/);
  });

  test("an exhausted limit wins over free tier: it is the more specific cause", () => {
    const v = openRouterKeyVerdict(key({ is_free_tier: true, limit: 1, limit_remaining: 0 }));
    assert.match(v.message, /spending limit is used up/);
  });

  test("no limit works, but does not claim to know the account balance", () => {
    const v = openRouterKeyVerdict(key());
    assert.equal(v.ok, true);
    assert.match(v.message, /balance is not visible/);
  });

  test("plenty of limit left reports a post estimate without a warning", () => {
    const v = openRouterKeyVerdict(key({ limit: 10, limit_remaining: 9.5 }));
    assert.equal(v.ok, true);
    assert.match(v.message, /^Key works: \$9\.50 left/);
    assert.match(v.message, /63,333 posts/);
  });

  test("under 1,000 posts of limit left warns but still passes", () => {
    const v = openRouterKeyVerdict(key({ limit: 1, limit_remaining: 0.12 }));
    assert.equal(v.ok, true);
    assert.match(v.message, /^Key works, but only \$0\.12 left/);
    assert.match(v.message, /800 posts/);
  });

  test("sub-cent amounts keep enough digits to be readable", () => {
    const v = openRouterKeyVerdict(key({ limit: 1, limit_remaining: 0.0042 }));
    assert.match(v.message, /\$0\.0042 left/);
  });
});
