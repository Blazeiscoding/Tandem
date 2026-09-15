import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { escapeMrkdwn, type Channel, type ID, type User } from "@slackoss/protocol";
import { Mrkdwn } from "../src/components/Mrkdwn.js";

const users: Record<ID, User> = {
  U1: {
    id: "U1",
    handle: "alice",
    displayName: "Alice",
    role: "member",
    statusText: "",
    statusEmoji: "",
    isBot: false,
    deactivated: false,
    dndUntil: null,
    createdAt: 0,
  },
};
const channels: Record<ID, Channel> = {
  C1: {
    id: "C1",
    type: "public",
    name: "general",
    topic: "",
    description: "",
    creatorId: "U1",
    archived: false,
    createdAt: 0,
  },
};

const render = (text: string) =>
  renderToStaticMarkup(<Mrkdwn text={text} users={users} channels={channels} />);

describe("Mrkdwn", () => {
  it("formats bold, italic, strike and code", () => {
    const html = render("*bold* _italic_ ~gone~ `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain(">code<");
  });

  it("renders escaped text back exactly as it was written", () => {
    // The other half of what the server's /shrug does. Unescaped, the
    // underscores pair up and the arms vanish into an <em>.
    const art = "¯\\_(ツ)_/¯";
    const html = render(`guess so ${escapeMrkdwn(art)}`);
    expect(html).not.toContain("<em>");
    expect(html).toContain(`guess so ${art}`);
  });

  it("never treats an escaped character as a delimiter", () => {
    // Both ends escaped, so there is no italic run at all — the rest of the
    // line is untouched either way.
    const html = render("\\_not italic\\_ and *bold*");
    expect(html).not.toContain("<em>");
    expect(html).toContain("_not italic_");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders mentions and channel links by name", () => {
    const html = render("hi <@U1> see <#C1>");
    expect(html).toContain("@Alice");
    expect(html).toContain("#general");
  });

  it("does not draw blank lines for the line breaks typed around a code block", () => {
    // How nearly everyone writes one: the fences on lines of their own.
    const html = render("Deploy notes:\n```\npnpm build\npnpm test\n```\nStaging is up.");
    expect(html).toMatch(/Deploy notes:<code[^>]*>pnpm build\npnpm test<\/code>Staging is up\./);
  });

  it("keeps the line breaks inside a code block, and text around one written inline", () => {
    const html = render("before ```\n\nfirst\n\nlast\n\n``` after");
    expect(html).toMatch(/before <code[^>]*>\nfirst\n\nlast\n<\/code> after/);
  });
});
