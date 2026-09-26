import type { ButtonHTMLAttributes, Ref } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

const VARIANTS: Record<ButtonVariant, string> = {
  // The one thing a dialog or form is for.
  primary:
    "rounded-lg bg-copper px-4 py-2.5 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40",
  // Everything else a dialog offers beside it.
  secondary:
    "rounded-lg border border-edge px-3 py-2 text-sm text-ink-dim transition-colors hover:bg-lifted hover:text-ink disabled:opacity-40",
  // Removing, revoking and signing out, when that is what is being confirmed.
  danger:
    "rounded-lg bg-alert px-4 py-2.5 text-sm font-semibold text-ground transition-colors hover:opacity-90 disabled:opacity-40",
  // Cancel, and actions that should not draw the eye.
  quiet:
    "rounded-lg px-3 py-2 text-sm text-ink-dim transition-colors hover:bg-lifted hover:text-ink disabled:opacity-40",
};

/** The classes for a button of this kind, with any the caller adds for layout. */
export function buttonClass(variant: ButtonVariant = "secondary", extra?: string): string {
  return extra ? `${VARIANTS[variant]} ${extra}` : VARIANTS[variant];
}

/**
 * Gatherline's button. It keeps a native button's default type, so one in a
 * form still submits it unless told `type="button"`.
 */
export function Button({
  variant = "secondary",
  className,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button ref={ref} className={buttonClass(variant, className)} {...props} />;
}
