/**
 * The emoji the composer's chooser and the reaction picker offer, each with
 * the words someone might search for it by, which also name its button.
 */
export const EMOJI = [
  ["😀", "Smile happy"],
  ["😂", "Laugh tears joy"],
  ["❤️", "Heart love"],
  ["👍", "Thumbs up yes"],
  ["✅", "Done check complete"],
  ["👀", "Eyes looking"],
  ["🎉", "Celebrate party"],
  ["🙏", "Thanks please"],
  ["🚀", "Rocket launch"],
  ["💡", "Idea light bulb"],
  ["🤔", "Thinking question"],
  ["🙌", "Raised hands hooray"],
  ["😊", "Smile blush"],
  ["😅", "Sweat relieved"],
  ["😎", "Cool sunglasses"],
  ["🤩", "Star struck excited"],
  ["😢", "Sad cry"],
  ["😭", "Sobbing crying"],
  ["😴", "Sleep tired"],
  ["🤯", "Mind blown amazed"],
  ["🤝", "Handshake agreement"],
  ["👏", "Clap applause"],
  ["👋", "Wave hello goodbye"],
  ["💪", "Strong muscle"],
  ["🔥", "Fire hot"],
  ["⭐", "Star favorite"],
  ["💯", "Hundred perfect"],
  ["⚠️", "Warning attention"],
  ["❌", "No cross cancel"],
  ["❓", "Question help"],
  ["📌", "Pin reminder"],
  ["📝", "Notes writing"],
  ["📅", "Calendar date"],
  ["⏰", "Alarm clock time"],
  ["☕", "Coffee break"],
  ["🍕", "Pizza food"],
  ["🎂", "Cake birthday"],
  ["🎁", "Gift present"],
  ["🌱", "Seedling growth"],
  ["🌈", "Rainbow"],
  ["🐛", "Bug insect"],
  ["🛠️", "Tools fix repair"],
  ["🔒", "Lock private secure"],
  ["🔗", "Link connection"],
  ["📊", "Chart data"],
  ["💻", "Computer laptop code"],
  ["🏠", "Home house"],
  ["🌍", "Earth world"],
] as const;

/** Emoji whose words contain the query, or the emoji itself when it is pasted in. */
export function findEmoji(query: string): (typeof EMOJI)[number][] {
  const q = query.toLowerCase().trim();
  return EMOJI.filter(([emoji, label]) => label.toLowerCase().includes(q) || emoji === q);
}

/**
 * Emoji for a word typed after a colon, as ":rock" offers 🚀: those with a
 * word that starts so, in the chooser's order. A word's start, so ":ar" does
 * not offer a heart.
 */
export function emojiStartingWith(word: string, limit = 6): (typeof EMOJI)[number][] {
  const q = word.toLowerCase();
  return EMOJI.filter(([, label]) =>
    label
      .toLowerCase()
      .split(" ")
      .some((w) => w.startsWith(q)),
  ).slice(0, limit);
}
