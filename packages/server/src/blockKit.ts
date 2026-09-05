import type { MessageAction } from "@slackoss/protocol";

/**
 * Slack Block Kit is what most existing integrations send. Rather than
 * implement the whole renderer, flatten the blocks that actually carry text
 * into our mrkdwn, so a payload written for Slack reads sensibly here.
 *
 * Unknown block types are skipped rather than rejected — an integration
 * sending something exotic should still get its message through.
 */

interface TextObject {
  type?: string;
  text?: string;
}

interface Block {
  type?: string;
  block_id?: string;
  text?: TextObject | string;
  fields?: TextObject[];
  elements?: (TextObject | { type?: string; text?: TextObject | string })[];
}

interface ButtonElement {
  type?: string;
  action_id?: string;
  text?: TextObject | string;
  value?: string;
  style?: string;
  url?: string;
}

function textOf(value: TextObject | string | undefined): string {
  if (typeof value === "string") return value;
  return value?.text ?? "";
}

export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];

  for (const raw of blocks as Block[]) {
    if (!raw || typeof raw !== "object") continue;
    switch (raw.type) {
      case "header": {
        const t = textOf(raw.text).trim();
        // Headers have no mrkdwn equivalent; bold is the closest thing.
        if (t) parts.push(`*${t}*`);
        break;
      }
      case "section": {
        const t = textOf(raw.text).trim();
        if (t) parts.push(t);
        for (const field of raw.fields ?? []) {
          const f = textOf(field).trim();
          if (f) parts.push(f);
        }
        break;
      }
      case "context": {
        // Context elements are either text objects themselves or wrappers
        // around one; images carry no text and fall out as empty.
        const bits = (raw.elements ?? [])
          .map((el) => {
            if (typeof el === "string") return el;
            const inner = (el as { text?: TextObject | string }).text;
            return textOf(inner ?? (el as TextObject));
          })
          .map((t) => t.trim())
          .filter(Boolean);
        if (bits.length > 0) parts.push(bits.join(" "));
        break;
      }
      case "divider":
        parts.push("———");
        break;
      default:
        // Buttons, images, inputs and the rest carry no plain text worth showing.
        break;
    }
  }

  return parts.join("\n\n").trim();
}

/** Slack's own ceilings, so a payload that works there works here. */
const MAX_ACTIONS = 25;
const MAX_BUTTON_TEXT = 75;
const MAX_ACTION_VALUE = 2000;

/**
 * The buttons in a payload's `actions` blocks. Everything else an actions
 * block can hold — selects, date pickers, overflow menus — is dropped, since
 * drawing a button is the whole of what this can honour so far. Dropping is
 * deliberate: half a form is worse than a message with no form.
 */
export function blocksToActions(blocks: unknown): MessageAction[] {
  if (!Array.isArray(blocks)) return [];
  const actions: MessageAction[] = [];

  for (const [index, raw] of (blocks as Block[]).entries()) {
    if (!raw || typeof raw !== "object" || raw.type !== "actions") continue;
    const blockId = typeof raw.block_id === "string" ? raw.block_id.slice(0, 255) : `b${index}`;
    for (const [n, el] of ((raw.elements ?? []) as ButtonElement[]).entries()) {
      if (!el || typeof el !== "object" || el.type !== "button") continue;
      const text = textOf(el.text).trim().slice(0, MAX_BUTTON_TEXT);
      if (!text) continue;
      const style = el.style === "primary" || el.style === "danger" ? el.style : "default";
      actions.push({
        actionId: typeof el.action_id === "string" && el.action_id ? el.action_id.slice(0, 255) : `a${index}_${n}`,
        blockId,
        text,
        value: typeof el.value === "string" ? el.value.slice(0, MAX_ACTION_VALUE) : "",
        style,
        // Only http(s) links; a button is not a way to hand someone a
        // javascript: or file: URL to click.
        url: typeof el.url === "string" && /^https?:\/\//i.test(el.url) ? el.url.slice(0, 2000) : null,
      });
      if (actions.length >= MAX_ACTIONS) return actions;
    }
  }
  return actions;
}

/**
 * The text a Slack-shaped payload should become: `text` wins, blocks fill in
 * when it is absent, which is how Slack itself treats the pair.
 */
export function payloadToText(payload: { text?: unknown; blocks?: unknown }): string {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (text) return text;
  return blocksToText(payload.blocks);
}
