import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type MoveChoice = "today" | "later_today" | "tomorrow" | "pick" | "someday" | "done" | "drop";

export const MOVE_LABELS: Record<MoveChoice, string> = {
  today: "Today",
  later_today: "Later today",
  tomorrow: "Tomorrow",
  pick: "Pick a day",
  someday: "Someday",
  done: "Mark done",
  drop: "Delete",
};

const HINTS: Partial<Record<MoveChoice, string>> = {
  later_today: "Fits it into the next free time today",
  someday: "Keeps it, off the calendar",
};

/**
 * One "Move…" sheet used everywhere, with the same words, so moving work always feels the same.
 * Slides up from the bottom on a phone.
 */
export function MoveSheet({
  title,
  choices,
  current,
  minDate,
  onPick,
  onClose,
}: {
  title: string;
  choices: MoveChoice[];
  current?: MoveChoice;
  minDate: string;
  onPick: (choice: MoveChoice, date?: string) => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered at the top level so it always sits above (and isn't faded by) the row that opened it.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Move ${title}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" aria-hidden />
        <div className="sheet-title">{title}</div>
        <div className="sheet-options">
          {choices.map((c) =>
            c === "pick" && picking ? (
              <label key={c} className="sheet-option picking">
                <span>Pick a day</span>
                <input
                  type="date"
                  min={minDate}
                  autoFocus
                  aria-label="Pick a day"
                  onChange={(e) => e.target.value && onPick("pick", e.target.value)}
                />
              </label>
            ) : (
              <button
                key={c}
                className={`sheet-option ${c === "drop" ? "danger" : ""} ${current === c ? "current" : ""}`}
                onClick={() => (c === "pick" ? setPicking(true) : onPick(c))}
              >
                <span>{MOVE_LABELS[c]}</span>
                {current === c ? <span className="muted small">Selected</span> : HINTS[c] ? <span className="muted small">{HINTS[c]}</span> : null}
              </button>
            ),
          )}
        </div>
        <button className="btn ghost sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** A task row with its chosen outcome and a quiet "Change" link that opens the shared Move… sheet. */
export function DecisionRow<A extends string>({
  title,
  note,
  value,
  labels,
  choices,
  toMove,
  minDate,
  onChange,
}: {
  title: string;
  note?: string;
  value: A;
  labels: Record<A, string>;
  choices: A[];
  toMove: Record<A, MoveChoice>;
  minDate: string;
  onChange: (a: A) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="decision-row">
      <span className="decision-title">
        {title}
        {note && <span className="muted small"> · {note}</span>}
      </span>
      <button type="button" className="decision-change" onClick={() => setOpen(true)}>
        <span className={`decision-value v-${value}`}>{labels[value]}</span>
        <span className="muted small">Change</span>
      </button>
      {open && (
        <MoveSheet
          title={title}
          choices={choices.map((c) => toMove[c])}
          current={toMove[value]}
          minDate={minDate}
          onClose={() => setOpen(false)}
          onPick={(c) => {
            const a = choices.find((x) => toMove[x] === c);
            if (a) onChange(a);
            setOpen(false);
          }}
        />
      )}
    </li>
  );
}
