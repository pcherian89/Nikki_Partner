import { localNow, toMinutes } from "./time.js";

/**
 * Why a running timer's elapsed time can't be trusted as real work. Uncertain time is never counted as verified:
 * it is shown to the user, who confirms or corrects it.
 */
export type TimerDoubt = "other_device" | "long_absence" | "too_long" | "crossed_day" | "past_day_end";

export const ABSENCE_MINUTES = 3 * 60;
export const SNOOZE_MINUTES = 2 * 60;

/** Minutes a timer may run before it is questioned: twice the estimate (at least 90), or 2 hours with no estimate. */
export const longRunMinutes = (estimateMinutes: number | null) => (estimateMinutes ? Math.max(2 * estimateMinutes, 90) : 120);

export interface TimerFacts {
  startedAt: string;
  now: Date;
  estimateMinutes: number | null;
  tz: string;
  /** The device that started it, and the one asking now. */
  startedBy?: string | null;
  thisClient?: string | null;
  /** When this device last asked the server anything before now. */
  thisClientPrevSeen?: string | null;
  snoozeUntil?: string | null;
  /** HH:MM end of today's working window, if known. */
  windowEnd?: string | null;
}

export function assessTimer(f: TimerFacts): TimerDoubt | null {
  const started = new Date(f.startedAt);
  const elapsed = (f.now.getTime() - started.getTime()) / 60000;
  if (f.snoozeUntil && new Date(f.snoozeUntil).getTime() > f.now.getTime()) return null; // "still working" said recently
  if (f.startedBy && f.thisClient && f.startedBy !== f.thisClient) return "other_device";
  if (f.thisClientPrevSeen && started.getTime() <= new Date(f.thisClientPrevSeen).getTime() && (f.now.getTime() - new Date(f.thisClientPrevSeen).getTime()) / 60000 >= ABSENCE_MINUTES) {
    return "long_absence";
  }
  const then = localNow(f.tz, started);
  const now = localNow(f.tz, f.now);
  if (then.date !== now.date) return "crossed_day";
  if (f.windowEnd && then.minutes < toMinutes(f.windowEnd) && now.minutes > toMinutes(f.windowEnd) + 30) return "past_day_end";
  if (elapsed >= longRunMinutes(f.estimateMinutes)) return "too_long";
  return null;
}
