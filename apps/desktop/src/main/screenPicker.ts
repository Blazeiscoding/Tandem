/** What the picker needs from Electron, so it can be exercised without it. */
export interface ScreenPickerParts<Screen extends { name: string }> {
  /** The screens this computer offers to share. */
  screens(): Promise<Screen[]>;
  /** A message box over the app's window: the index of the button pressed. */
  ask(options: {
    type: "question" | "info" | "warning";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }): Promise<{ response: number }>;
}

/**
 * Which screen a huddle shares, or null for none.
 *
 * Null is all the renderer hears, whether someone pressed Cancel or there
 * was nothing to choose, and it says nothing either way, as it must for
 * Cancel. So when there is no screen, or listing them failed, this says so
 * here, in the same kind of box the choice would have come in (CALL-01).
 */
export async function pickScreen<Screen extends { name: string }>(
  parts: ScreenPickerParts<Screen>,
): Promise<Screen | null> {
  let screens: Screen[];
  try {
    screens = await parts.screens();
  } catch {
    await parts.ask({
      type: "warning",
      title: "Share your screen",
      message: "Screen sharing could not start",
      detail: "The screens on this computer could not be listed. Try again in a moment.",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
    return null;
  }
  if (screens.length === 0) {
    await parts.ask({
      type: "info",
      title: "Share your screen",
      message: "There is no screen to share",
      detail:
        "This computer offered no screen to this app. If your system asks whether the app may record the screen, allow it, then try again.",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
    return null;
  }
  const choice = await parts.ask({
    type: "question",
    title: "Share your screen",
    message: "Choose a screen to share with this huddle",
    detail: "Everyone in the huddle will see everything on the selected screen.",
    buttons: ["Cancel", ...screens.map((screen) => screen.name)],
    defaultId: 0,
    cancelId: 0,
  });
  return screens[choice.response - 1] ?? null;
}
