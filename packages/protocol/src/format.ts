/**
 * Escapes text that must appear literally in a message rather than be read as
 * mrkdwn. Clients treat a backslash as "the next character is not a
 * delimiter", so anything that would otherwise open bold, italic, strike or
 * code has to be prefixed — the backslash itself included.
 *
 * The case that forced this into existence is /shrug: ¯\_(ツ)_/¯ contains a
 * backslash and two underscores, and unescaped it renders as an italic ¯(ツ)/¯
 * with the arms missing.
 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll(/[\\*_~`]/g, (c) => `\\${c}`);
}
