import { Modal } from "./Modal.js";
import { Icon } from "./Icon.js";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  dismissible?: boolean;
  /** Id of the text a reader needs along with the title, such as a question's consequence. */
  describedBy?: string;
}

export function Dialog({
  title,
  onClose,
  children,
  width = 440,
  dismissible = true,
  describedBy,
}: Props) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      dismissible={dismissible}
      describedBy={describedBy}
      backdropClassName="flex items-start justify-center bg-black/50 px-3 pt-[12vh] backdrop-blur-[2px] animate-fade-in"
      className="max-h-[78vh] max-w-full animate-pop-in overflow-y-auto rounded-2xl border border-edge bg-raised p-6 shadow-[var(--shadow-dialog)] outline-none"
      style={{ width }}
    >
      <div className="-mr-2 -mt-1.5 mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        <button
          type="button"
          onClick={() => {
            if (dismissible) onClose();
          }}
          disabled={!dismissible}
          aria-label="Close"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {children}
    </Modal>
  );
}

export const inputCls =
  "w-full rounded-lg border border-edge bg-ground px-3 py-2 text-sm outline-none transition-colors placeholder:text-ink-faint hover:border-ink-faint/40 focus:border-copper";
