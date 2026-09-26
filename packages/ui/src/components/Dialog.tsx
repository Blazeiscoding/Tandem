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
      backdropClassName="flex items-start justify-center bg-black/60 px-3 pt-[10vh]"
      className="max-h-[80vh] max-w-full overflow-y-auto rounded-2xl border border-edge bg-raised p-5 shadow-2xl outline-none"
      style={{ width }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">{title}</h2>
        <button
          type="button"
          onClick={() => {
            if (dismissible) onClose();
          }}
          disabled={!dismissible}
          aria-label="Close"
          className="rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {children}
    </Modal>
  );
}

export const inputCls =
  "w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm outline-none placeholder:text-ink-faint focus:border-copper";
