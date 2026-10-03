import type { Meeting } from "../shared/types.js";
import { fromMinutes, toMinutes } from "./time.js";

/**
 * Deterministic time-block scheduler. Used by Demo mode (instead of a model)
 * to lay out focus/supporting work around fixed meetings with breaks and a
 * buffer, always staying inside the window and the work budget.
 */

export interface ScheduleItem {
  ref: string;
  title: string;
  minutes: number;
  kind: "focus" | "task";
}

export interface ScheduledBlock {
  start: string;
  end: string;
  kind: "focus" | "task" | "break" | "buffer" | "meeting";
  task_ref: string | null;
  title: string;
}

const MAX_CHUNK = 90;
const MIN_CHUNK = 20;
const BREAK = 15;

export function freeSegments(start: number, end: number, meetings: Meeting[]) {
  const segs: [number, number][] = [];
  let cursor = start;
  const sorted = [...meetings].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (const m of sorted) {
    const ms = toMinutes(m.start);
    const me = toMinutes(m.end);
    if (me <= cursor) continue;
    if (ms >= end) break;
    if (ms > cursor) segs.push([cursor, Math.min(ms, end)]);
    cursor = Math.max(cursor, me);
  }
  if (cursor < end) segs.push([cursor, end]);
  return segs;
}

export function scheduleBlocks(opts: {
  window: { start: string; end: string };
  startAt?: string;
  meetings: Meeting[];
  budgetMinutes: number;
  items: ScheduleItem[];
}) {
  const ws = Math.max(toMinutes(opts.window.start), opts.startAt ? toMinutes(opts.startAt) : 0);
  const we = toMinutes(opts.window.end);
  const segs = freeSegments(ws, we, opts.meetings);
  const blocks: ScheduledBlock[] = [];
  const placed: { ref: string; minutes: number }[] = [];
  const unscheduled: string[] = [];
  let workLeft = opts.budgetMinutes;
  let segIdx = 0;
  let cursor = segs[0]?.[0] ?? we;
  let sinceBreak = 0;

  for (const item of opts.items) {
    let need = item.minutes;
    const itemBlocks: ScheduledBlock[] = [];
    let placedMinutes = 0;
    const save = { segIdx, cursor, sinceBreak, workLeft, len: blocks.length };
    while (need > 0 && workLeft >= MIN_CHUNK && segIdx < segs.length) {
      const segEnd = segs[segIdx][1];
      if (segEnd - cursor < MIN_CHUNK) {
        segIdx++;
        if (segIdx < segs.length) cursor = segs[segIdx][0];
        sinceBreak = 0;
        continue;
      }
      const chunk = Math.min(need, MAX_CHUNK, segEnd - cursor, workLeft);
      const b: ScheduledBlock = {
        start: fromMinutes(cursor),
        end: fromMinutes(cursor + chunk),
        kind: item.kind,
        task_ref: item.ref,
        title: item.title,
      };
      blocks.push(b);
      itemBlocks.push(b);
      cursor += chunk;
      need -= chunk;
      workLeft -= chunk;
      placedMinutes += chunk;
      sinceBreak += chunk;
      if (sinceBreak >= 75 && segEnd - cursor >= BREAK + MIN_CHUNK) {
        blocks.push({ start: fromMinutes(cursor), end: fromMinutes(cursor + BREAK), kind: "break", task_ref: null, title: "Break" });
        cursor += BREAK;
        sinceBreak = 0;
      }
    }
    if (placedMinutes < Math.min(30, item.minutes)) {
      // Not enough room for meaningful progress: undo and leave it for later.
      blocks.length = save.len;
      ({ segIdx, cursor, sinceBreak, workLeft } = save);
      unscheduled.push(item.ref);
    } else {
      placed.push({ ref: item.ref, minutes: placedMinutes });
    }
  }

  // Trailing break directly before a meeting/end is pointless — turn it into buffer.
  const last = blocks[blocks.length - 1];
  if (last?.kind === "break") {
    last.kind = "buffer";
    last.title = "Buffer";
  } else if (segIdx < segs.length) {
    const room = segs[segIdx][1] - cursor;
    if (room >= 10) {
      const len = Math.min(room, 15);
      blocks.push({ start: fromMinutes(cursor), end: fromMinutes(cursor + len), kind: "buffer", task_ref: null, title: "Buffer" });
    }
  }

  for (const m of opts.meetings) {
    blocks.push({ start: m.start, end: m.end, kind: "meeting", task_ref: null, title: m.title });
  }
  blocks.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  return { blocks, placed, unscheduled };
}
