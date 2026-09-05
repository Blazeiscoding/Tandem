import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../src/lib/deeplink.js";

describe("parseDeepLink", () => {
  it("reads a join link with an invite code", () => {
    expect(parseDeepLink("slackoss://join?host=192.168.1.5:8543&code=ABCD1234")).toEqual({
      kind: "join",
      serverUrl: "http://192.168.1.5:8543",
      code: "ABCD1234",
    });
  });

  it("reads a join link without a code", () => {
    const link = parseDeepLink("slackoss://join?host=chat.example.dev");
    expect(link).toEqual({
      kind: "join",
      serverUrl: "http://chat.example.dev:8543",
      code: null,
    });
  });

  it("reads a message permalink", () => {
    expect(parseDeepLink("slackoss://message?host=192.168.1.5:8543&channel=C123&id=M456")).toEqual({
      kind: "message",
      serverUrl: "http://192.168.1.5:8543",
      channelId: "C123",
      messageId: "M456",
    });
  });

  it("survives a url-encoded host", () => {
    const link = parseDeepLink("slackoss://join?host=192.168.1.5%3A8543");
    expect(link?.serverUrl).toBe("http://192.168.1.5:8543");
  });

  it("rejects anything malformed rather than throwing", () => {
    expect(parseDeepLink("not a url")).toBeNull();
    expect(parseDeepLink("https://example.com/join?host=x")).toBeNull();
    expect(parseDeepLink("slackoss://join")).toBeNull();
    expect(parseDeepLink("slackoss://message?host=h&channel=C1")).toBeNull();
    expect(parseDeepLink("slackoss://explode?host=h")).toBeNull();
  });
});
