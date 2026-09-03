import { describe, expect, it } from "vitest";
import { escapeMrkdwn } from "../src/format.js";

describe("escapeMrkdwn", () => {
  it("prefixes every delimiter, backslash included", () => {
    expect(escapeMrkdwn("a_b*c~d`e")).toBe("a\\_b\\*c\\~d\\`e");
    expect(escapeMrkdwn("c:\\temp")).toBe("c:\\\\temp");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeMrkdwn("just a sentence, with punctuation!")).toBe(
      "just a sentence, with punctuation!",
    );
  });

  it("escapes the backslash before the character it protects", () => {
    // Order matters: escaping "_" first and "\" second would double back over
    // the backslashes just added and produce \\_ instead of \_.
    expect(escapeMrkdwn("¯\\_(ツ)_/¯")).toBe("¯\\\\\\_(ツ)\\_/¯");
  });
});
