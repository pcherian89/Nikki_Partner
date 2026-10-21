import { useState } from "react";
import type { AppState, Reminder, Task } from "../../shared/types";
import { api, ApiError } from "../api";
import type { AppActions } from "../App";
import { fmtDate, fmtTime } from "../util";
import { ActionSheet } from "./MoveSheet";
import { FormSheet } from "./TaskList";

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const whenLabel = (r: Reminder, state: AppState) =>
  `${r.localDate === state.today ? "Today" : r.localDate === state.tomorrow.date ? "Tomorrow" : fmtDate(r.localDate, false)}, ${fmtTime(r.localTime)}`;

/** Add or edit a reminder. A reminder is separate from a task: it only reminds. */
export function ReminderSheet({ state, actions, reminder, task, onClose }: { state: AppState; actions: AppActions; reminder?: Reminder; task?: Task | null; onClose: () => void }) {
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [date, setDate] = useState(reminder?.localDate ?? state.tomorrow.date);
  const [time, setTime] = useState(reminder?.localTime ?? "09:00");
  const [mode, setMode] = useState<"date" | "deadline">("date");
  const [days, setDays] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const linked = task ?? (reminder?.taskId ? state.tasks.find((t) => t.id === reminder.taskId) : null) ?? null;
  const canDeadline = !reminder && !!task?.deadline;

  const save = async () => {
    setError(null);
    try {
      let r;
      if (reminder) r = await api("PATCH", `/api/reminders/${reminder.id}`, { title: title.trim(), date, time });
      else if (mode === "deadline") r = await api("POST", "/api/reminders", { title: title.trim(), taskId: task!.id, fromDeadline: { offsetDays: Math.max(0, Math.round(Number(days) || 0)), atTime: time } });
      else r = await api("POST", "/api/reminders", { title: title.trim(), taskId: task?.id ?? null, date, time });
      actions.setState(r.state);
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  return (
    <FormSheet title={reminder ? "Edit reminder" : "New reminder"} onClose={onClose}>
      <div className="sheet-form">
        {linked && <p className="muted small sheet-note">About: {linked.title}</p>}
        <label className="field">
          <span>Remind me to…</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Follow up on the proposal" maxLength={300} autoFocus />
        </label>
        {canDeadline && (
          <div className="segmented" role="tablist" aria-label="When">
            <button role="tab" aria-selected={mode === "date"} className={mode === "date" ? "active" : ""} onClick={() => setMode("date")}>
              On a day
            </button>
            <button role="tab" aria-selected={mode === "deadline"} className={mode === "deadline" ? "active" : ""} onClick={() => setMode("deadline")}>
              Before the deadline
            </button>
          </div>
        )}
        {mode === "deadline" ? (
          <div className="row gap">
            <label className="field grow">
              <span>Days before</span>
              <input type="number" min={0} max={365} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <label className="field grow">
              <span>At</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
        ) : (
          <div className="row gap">
            <label className="field grow">
              <span>Day</span>
              <input type="date" min={state.today} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field grow">
              <span>At</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="row gap wrap">
          <button className="btn primary" disabled={!title.trim() || (mode === "date" && !date)} onClick={save}>
            {reminder ? "Save" : "Set reminder"}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </FormSheet>
  );
}

/** A one-line strip: only when there are reminders for this day (or any that are due). Everything else is a tap away. */
export function ReminderStrip({ state, actions, date }: { state: AppState; actions: AppActions; date: string }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [menu, setMenu] = useState<Reminder | null>(null);
  const isToday = date === state.today;
  const mine = state.reminders.filter((r) => (isToday ? r.status === "due" || r.localDate === date || r.localDate < date : r.localDate === date));
  if (!mine.length) return null;
  const due = mine.filter((r) => r.status === "due");
  const call = (url: string, body?: unknown) => actions.mutate("POST", url, body);
  return (
    <div className={`reminder-strip ${due.length ? "due" : ""}`}>
      <button className="reminder-line" aria-expanded={open || due.length > 0} onClick={() => setOpen(!open)}>
        <span aria-hidden>🔔</span>{" "}
        {due.length ? `${due.length} reminder${due.length > 1 ? "s" : ""} due` : `${mine.length} reminder${mine.length > 1 ? "s" : ""} ${isToday ? "today" : "tomorrow"}`} {open || due.length ? "⌄" : "›"}
      </button>
      {(open || due.length > 0) && (
        <ul className="plain-list reminder-list">
          {mine.map((r) => (
            <li key={r.id} className={`reminder-row ${r.status}`}>
              <span className="reminder-text">
                <strong>{r.title}</strong>
                <span className="muted small">
                  {" "}
                  · {r.status === "due" ? `was ${fmtTime(r.localTime)}` : whenLabel(r, state)}
                  {r.taskId ? ` · ${state.tasks.find((t) => t.id === r.taskId)?.title ?? ""}` : ""}
                </span>
              </span>
              <span className="row gap center-y">
                {r.status === "due" ? (
                  <>
                    <button className="btn small primary" onClick={() => call(`/api/reminders/${r.id}/done`)}>
                      Done
                    </button>
                    <button className="btn small ghost" onClick={() => call(`/api/reminders/${r.id}/snooze`, { minutes: 60 })}>
                      +1 hour
                    </button>
                  </>
                ) : null}
                <button className="icon-btn" aria-label={`More for reminder ${r.title}`} onClick={() => setMenu(r)}>
                  ⋯
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {menu && (
        <ActionSheet
          title={menu.title}
          onClose={() => setMenu(null)}
          items={[
            { label: "Edit…", run: () => setEditing(menu) },
            ...(menu.status === "pending" ? [{ label: "Mark done", run: () => call(`/api/reminders/${menu.id}/done`) }] : []),
            { label: "Snooze until tomorrow", run: () => call(`/api/reminders/${menu.id}/snooze`, { minutes: Math.max(5, Math.round((new Date(`${addDays(state.today, 1)}T09:00:00`).getTime() - Date.now()) / 60000)) }) },
            { label: "Cancel reminder", danger: true, run: () => call(`/api/reminders/${menu.id}/cancel`) },
          ]}
        />
      )}
      {editing && <ReminderSheet state={state} actions={actions} reminder={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Closed-app notifications: only "verified" after this device actually received a test. */
export function NotificationsCard({ state, actions }: { state: AppState; actions: AppActions }) {
  const n = state.notifications;
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const perm = typeof Notification !== "undefined" ? Notification.permission : "denied";
  const live = state.workspace === "personal";

  const enable = async () => {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      if (p !== "granted") return actions.toast({ text: "Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.", tone: "error" });
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>("GET", "/api/push/key");
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const j = sub.toJSON();
      const r = await api("POST", "/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys });
      actions.setState(r.state);
      actions.toast({ text: "Notifications turned on. Send a test to check they arrive." });
    } catch (e) {
      actions.toast({ text: `Couldn't turn notifications on: ${(e as Error).message}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }).then((r: any) => actions.setState(r.state));
        await sub.unsubscribe();
      }
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await api("POST", "/api/push/test");
      actions.setState(r.state);
      actions.toast({ text: "Test sent. If a notification appears on your device, it works." });
    } catch (e) {
      actions.toast({ text: (e as ApiError).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="h3">Reminders &amp; notifications</h2>
      <p className="small">
        <strong>In Nikki:</strong> reminders always appear on Today when they’re due. This works whenever you open the app.
      </p>
      <p className="small">
        <strong>When Nikki is closed:</strong>{" "}
        {!live ? (
          "Switch to your real workspace to set this up."
        ) : !supported ? (
          "Not supported in this browser. On iPhone, add Nikki to your Home Screen first (Share → Add to Home Screen), then open it from there."
        ) : n.verified && n.thisDevice ? (
          <span className="tag">Verified on this device</span>
        ) : n.thisDevice ? (
          <span className="tag subtle">On, not verified yet — send a test</span>
        ) : (
          <span className="tag subtle">Off</span>
        )}
      </p>
      {n.lastTestAt && !n.verified && <p className="muted small">A test was sent but this device hasn’t confirmed receiving it. Closed-app reminders are not confirmed to work.</p>}
      {live && supported && (
        <div className="row gap wrap">
          {!n.thisDevice ? (
            <button className="btn primary" onClick={enable} disabled={busy || perm === "denied"}>
              Turn on notifications
            </button>
          ) : (
            <>
              <button className="btn" onClick={test} disabled={busy}>
                Send a test
              </button>
              <button className="btn ghost" onClick={disable} disabled={busy}>
                Turn off
              </button>
            </>
          )}
        </div>
      )}
      {perm === "denied" && live && supported && <p className="muted small">Notifications are blocked in your browser settings for this site.</p>}
    </section>
  );
}
