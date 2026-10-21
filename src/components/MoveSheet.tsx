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
  someday: "No date",
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
              <DayPicker key={c} minDate={minDate} onPick={(d) => onPick("pick", d)} />
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

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const chipLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

/**
 * The next two weeks as tap-once day chips, plus any other date. Nothing happens until a day is tapped
 * (the iPhone date wheel fills in a default as soon as it opens, so it gets its own Set button).
 */
function DayPicker({ minDate, onPick }: { minDate: string; onPick: (date: string) => void }) {
  const [other, setOther] = useState("");
  const days = Array.from({ length: 14 }, (_, i) => addDays(minDate, i + 2));
  return (
    <div className="day-picker">
      <div className="day-chips" role="group" aria-label="Pick a day">
        {days.map((d) => (
          <button key={d} type="button" className="day-chip" onClick={() => onPick(d)}>
            {chipLabel(d)}
          </button>
        ))}
      </div>
      <div className="day-other">
        <input type="date" min={minDate} value={other} onChange={(e) => setOther(e.target.value)} aria-label="Another date" />
        <button type="button" className="btn small primary" disabled={!other || other < minDate} onClick={() => onPick(other)}>
          Set
        </button>
      </div>
    </div>
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
  date,
  onChange,
}: {
  title: string;
  note?: string;
  value: A;
  labels: Record<A, string>;
  choices: A[];
  toMove: Record<A, MoveChoice>;
  minDate: string;
  /** The chosen day, when the choice is "Pick a day". */
  date?: string;
  onChange: (a: A, date?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="decision-row">
      <span className="decision-title">
        {title}
        {note && <span className="muted small"> · {note}</span>}
      </span>
      <button type="button" className="decision-change" onClick={() => setOpen(true)}>
        <span className={`decision-value v-${value}`}>{date && toMove[value] === "pick" ? chipLabel(date) : labels[value]}</span>
        <span className="muted small">Change</span>
      </button>
      {open && (
        <MoveSheet
          title={title}
          choices={choices.map((c) => toMove[c])}
          current={toMove[value]}
          minDate={minDate}
          onClose={() => setOpen(false)}
          onPick={(c, d) => {
            const a = choices.find((x) => toMove[x] === c);
            if (a) onChange(a, d);
            setOpen(false);
          }}
        />
      )}
    </li>
  );
}

export type SheetAction = { label: string; run: () => void; danger?: boolean };

/** A plain list of actions in the same bottom sheet style as Move…. */
export function ActionSheet({ title, items, onClose }: { title: string; items: SheetAction[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" aria-hidden />
        <div className="sheet-title">{title}</div>
        <div className="sheet-options">
          {items.map((i) => (
            <button
              key={i.label}
              className={`sheet-option ${i.danger ? "danger" : ""}`}
              onClick={() => {
                onClose();
                i.run();
              }}
            >
              <span>{i.label}</span>
            </button>
          ))}
        </div>
        <button className="btn ghost sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}
