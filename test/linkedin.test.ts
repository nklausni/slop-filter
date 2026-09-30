// Unit tests for LinkedIn's label detection. No DOM: the matchers work on header text.
//
//   npm test
//
// The label rules hide a post without asking the API, so a false match is a silent false
// hide. Most cases here are headlines that contain a label word and must NOT match.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { PROMOTED_LABEL, isSuggestedHeader } from "../src/platforms/linkedin.ts";

describe("isSuggestedHeader", () => {
  test("matches the label line in English and German", () => {
    assert.ok(isSuggestedHeader(["Suggested", "Feed post", "Jane Doe", "Head of Data"]));
    assert.ok(isSuggestedHeader(["Vorgeschlagen", "Beitrag im Feed", "Max Muster"]));
  });

  test("matches a label glued to the next node", () => {
    assert.ok(isSuggestedHeader(["VorgeschlagenBeitrag im Feed", "Max Muster"]));
  });

  test("a headline that merely contains the word does not count", () => {
    assert.ok(!isSuggestedHeader(["Jane Doe", "Builds AI-suggested workflows for finance"]));
    assert.ok(!isSuggestedHeader(["Max Muster", "Hat vorgeschlagen, wie wir Onboarding verkürzen"]));
  });

  test("an ordinary header does not count", () => {
    assert.ok(!isSuggestedHeader(["Feed post", "Jane Doe", "• 2nd", "Head of Data", "3d"]));
  });
});

describe("PROMOTED_LABEL", () => {
  test("matches the ad label in English and German", () => {
    for (const h of ["Acme Corp | 16,631 followers | Promoted", "Acme GmbH | Anzeige", "Acme GmbH | Gesponsert"]) {
      assert.ok(PROMOTED_LABEL.test(h), h);
    }
  });

  test("marketing words in a headline do not count", () => {
    for (const h of ["Max Muster | Head of Werbung & Marketing", "Anzeigenleitung bei Verlag XY", "Anzeigenverkauf"]) {
      assert.ok(!PROMOTED_LABEL.test(h), h);
    }
  });
});
