/**
 * What the main window does when its page dies or fails to load (REV-09).
 * The window is only a view: hosting, backups and the tray live in the main
 * process and carry on. So the page is loaded again, a few times, and if it
 * keeps failing the person is asked rather than left with a blank window or
 * a window that reloads forever.
 */
export const RENDERER_RECOVERY = {
  /** How many failures within `windowMs` are reloaded before asking. */
  maxReloads: 3,
  windowMs: 60_000,
  /** A pause before reloading, so a page that dies at once does not spin. */
  reloadDelayMs: 500,
} as const;

export type RecoveryStep = "reload" | "ask";

export class RendererRecovery {
  private failures: number[] = [];

  constructor(
    private readonly policy: { maxReloads: number; windowMs: number } = RENDERER_RECOVERY,
    private readonly now: () => number = Date.now,
  ) {}

  /** The page died or did not load: whether to load it again, or to ask. */
  failed(): RecoveryStep {
    const at = this.now();
    this.failures = this.failures.filter((time) => at - time < this.policy.windowMs);
    this.failures.push(at);
    return this.failures.length <= this.policy.maxReloads ? "reload" : "ask";
  }

  /** Someone asked to try again: their try starts a fresh count. */
  reset(): void {
    this.failures = [];
  }
}

/**
 * Whether a failed load is one to recover from: the window's own page, not
 * a frame inside it, and not a navigation that something newer replaced.
 */
export function isRendererLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  // -3 is ERR_ABORTED: another navigation took over, which is not a failure.
  return isMainFrame && errorCode !== -3;
}
