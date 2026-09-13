import axe from "axe-core";

/**
 * What an automated accessibility check finds wrong inside `root`, one line per
 * rule, so a failing test says which rule and which elements.
 *
 * Colour contrast is left out: it needs real rendering, which jsdom does not do.
 * An empty result means no rule that can be judged here was broken, not that
 * the component is accessible; keyboard and screen-reader behaviour still need
 * their own tests.
 */
export async function accessibilityProblems(root: Element = document.body): Promise<string[]> {
  const results = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}
