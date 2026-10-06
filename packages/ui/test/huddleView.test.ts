import { describe, expect, it } from "vitest";
import type { User } from "@slackoss/protocol";
import { huddleNames } from "../src/lib/huddleView.js";

const person = (id: string, displayName: string) => ({ id, displayName }) as User;

describe("naming who is in a huddle", () => {
  it("puts you first, and names someone it does not know yet", () => {
    const users = {
      U_SAM: person("U_SAM", "Sam Rivera"),
      U_PRIYA: person("U_PRIYA", "Priya Shah"),
    };
    expect(huddleNames(["U_PRIYA", "U_SAM", "U_NEW"], users, "U_SAM")).toEqual([
      "you",
      "Priya Shah",
      "someone",
    ]);
    expect(huddleNames(["U_PRIYA"], users, "U_SAM")).toEqual(["Priya Shah"]);
  });
});
