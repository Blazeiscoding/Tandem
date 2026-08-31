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
  text?: TextObject | string;
  fields?: TextObject[];
  elements?: (TextObject | { type?: string; text?: TextObject | string })[];
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

/**
 * The text a Slack-shaped payload should become: `text` wins, blocks fill in
 * when it is absent, which is how Slack itself treats the pair.
 */
export function payloadToText(payload: { text?: unknown; blocks?: unknown }): string {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (text) return text;
  return blocksToText(payload.blocks);
}
