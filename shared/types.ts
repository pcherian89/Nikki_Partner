// Types shared by the server and the browser app.

export type Workspace = "personal" | "demo";

export type TaskType = "action" | "idea" | "reference";
export type TaskStatus = "open" | "waiting" | "blocked" | "done";
/** How important a task is. Affects ordering only — never whether it can be ignored or deferred. */
export type TaskPriority = "high" | "normal" | "low";

export interface Task {
  id: string;
  title: string;
  notes: string;
  type: TaskType;
  status: TaskStatus;
  estimateMinutes: number | null;
  /** Only set when the user stated a real deadline. Never invented. */
  deadline: string | null;
  /** Optional time of day (HH:MM, local) for the deadline. Never a calendar event and never a work block. */
  deadlineTime: string | null;
  priority: TaskPriority;
  /** "If time allows": set only by the user, independent of priority. */
  optional: boolean;
  /** The day the user intends to work on it (rough weekly planning). */
  plannedDate: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  source: "user" | "nikki" | "demo";
  /** Minutes the task really took (from the timer or entered by the user). */
  actualMinutes: number | null;
  /** Minutes tracked by the focus timer so far. */
  spentMinutes: number;
  /** Set while the focus timer is running. */
  timerStartedAt: string | null;
  /** How many times this was planned for a day and not finished (moved on instead). */
  rolloverCount: number;
  steps: TaskStep[];
}

export interface TaskStep {
  id: string;
  title: string;
  minutes: number | null;
  done: boolean;
}

export interface TaskDraft {
  id: string;
  taskId: string;
  format: string;
  title: string;
  content: string;
  nextStep: string;
  createdAt: string;
  demo: boolean;
}

export interface WrapUp {
  id: string;
  date: string;
  createdAt: string;
  doneTaskIds: string[];
  doneTitles: string[];
  tomorrowTaskIds: string[];
  note: string;
}

export interface EstimationInsight {
  /** Number of completed tasks with both an estimate and a real duration. */
  samples: number;
  /** Typical actual ÷ estimate (median). 1.0 = estimates are accurate. */
  factor: number | null;
  byProject: { project: string; factor: number; samples: number }[];
  recent: { title: string; estimate: number; actual: number }[];
}

export interface Profile {
  name: string;
  projects: string;
  goals: string;
  mainOutcome: string;
  commitments: string;
  workStart: string;
  workEnd: string;
  timezone: string;
  preferences: string;
  updatedAt: string | null;
}

export const CONTEXT_FIELDS = [
  "name",
  "projects",
  "goals",
  "mainOutcome",
  "commitments",
  "workStart",
  "workEnd",
  "timezone",
  "preferences",
] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

export interface Meeting {
  id: string;
  date: string;
  title: string;
  start: string;
  end: string;
  /** "calendar" = synced read-only from a linked calendar. */
  source?: "manual" | "calendar";
  feedId?: string | null;
}

export interface CalendarFeedInfo {
  id: string;
  name: string;
  /** The private link is never sent back to the browser in full. */
  urlHint: string;
  lastSyncAt: string | null;
  lastError: string | null;
  eventCount: number;
}

export type BlockKind = "focus" | "task" | "break" | "buffer" | "meeting";

export interface PlanBlock {
  id: string;
  start: string;
  end: string;
  kind: BlockKind;
  taskId: string | null;
  meetingId: string | null;
  title: string;
  /** The user asked for exactly this time (or set it by hand): it never moves automatically. */
  pinned?: boolean;
  /** The duration is a stand-in because the task has no estimate. Shown as "provisional". */
  provisional?: boolean;
}

export interface PlanDraft {
  date: string;
  mainOutcome: string;
  focusTaskId: string | null;
  focusWhy: string;
  supporting: { taskId: string; why: string }[];
  deferred: { taskId: string; why: string }[];
  reasons: string[];
  assumptions: string[];
  window: { start: string; end: string };
  workBudgetMinutes: number;
  blocks: PlanBlock[];
}

export interface Plan extends PlanDraft {
  id: string;
  version: number;
  status: "confirmed" | "superseded";
  createdAt: string;
  proposalId: string | null;
  source: "nikki" | "user-edit" | "demo";
}

/** What the user said happened in a planned block. Separate from the task's own status. */
export type BlockOutcome = "done" | "partial" | "skipped" | "rescheduled";

/**
 * Where a planned block stands in the day's history:
 * the four recorded outcomes, plus "unconfirmed" (its time came and nobody said what happened),
 * "replaced" (the task was finished, so a later block wasn't needed), "removed" (the task was deleted)
 * and "planned" (still ahead).
 */
export type HistoryStatus = BlockOutcome | "unconfirmed" | "replaced" | "removed" | "planned";

export interface HistoryItem {
  /** `${taskId}|${start}`: stable across plan versions, so edits to a block's end don't create duplicates. */
  key: string;
  date: string;
  taskId: string;
  title: string;
  start: string;
  end: string;
  /** The end it had when first planned (differs if it was extended or trimmed). */
  originalEnd: string;
  kind: "focus" | "task";
  status: HistoryStatus;
  /** True when the status comes from the user's own answer rather than being worked out. */
  recorded: boolean;
  note: string | null;
  plannedMinutes: number;
  /** Minutes of actual work recorded against this block (timer or confirmed), not its planned length. */
  workedMinutes: number;
  /** Still in the current plan for that day. */
  inCurrentPlan: boolean;
}

export interface WorkSession {
  id: string;
  taskId: string;
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number;
  /** timer = measured; reported = typed or said by the user; confirmed = "did it" for a planned block. */
  source: "timer" | "reported" | "confirmed";
  blockStart: string | null;
  note: string | null;
  /** False for uncertain timer time (left running, other device…) until the user confirms or corrects it. */
  verified: boolean;
}

/** A timer that is running right now, as the server sees it. */
export interface RunningTimer {
  taskId: string;
  title: string;
  startedAt: string;
  /** Elapsed minutes by the server's clock. */
  minutes: number;
  /** Why this elapsed time can't be trusted as real work (null = nothing doubtful). */
  doubt: "other_device" | "long_absence" | "too_long" | "crossed_day" | "past_day_end" | null;
}

/** What the app works out about each open task (so every screen and Nikki agree). */
export interface TaskMeta {
  /** Estimate minus verified recorded time. Null when there is no estimate (unknown stays unknown). */
  remainingMinutes: number | null;
  /** Verified minutes recorded against the task. */
  workedMinutes: number;
  sessionCount: number;
  /** overdue: deadline passed. at_risk: remaining effort doesn't fit before it. no_estimate: can't tell. */
  deadlineStatus: "overdue" | "at_risk" | "no_estimate" | "ok" | null;
  /** For at_risk: how many minutes short. */
  shortByMinutes: number | null;
}

export interface DaySummary {
  date: string;
  /** Open tasks on that day's list (assigned to it, or in its plan). */
  openIds: string[];
  doneCount: number;
  /** Work still to do on the list, from the known estimates. */
  remainingMinutes: number;
  /** Open tasks on the list with no estimate. */
  unknownEstimates: number;
  /** Work time already placed in blocks (for today, only what is still ahead). */
  scheduledMinutes: number;
  /** Free working time (for today, from now), after meetings. */
  availableMinutes: number;
  /** Time taken by meetings inside the working window. */
  fixedMinutes: number;
}

export interface NextSuggestion {
  taskId: string;
  reason: string;
}

export interface TaskChange {
  id: string;
  taskId: string;
  change: "update" | "complete" | "waiting" | "blocked" | "reopen" | "delete" | "unschedule";
  title: string | null;
  estimateMinutes: number | null;
  deadline: string | null;
  plannedDate?: string | null;
  notes: string | null;
  reason: string;
}

export interface ContextSuggestion {
  id: string;
  field: ContextField;
  /** add: append a line to a list field; remove: delete that line; set: replace a single value. */
  action?: "add" | "remove" | "set";
  value: string;
  reason: string;
  status: "pending" | "saved" | "dismissed";
  /** The field's saved value when the suggestion was made (for showing a before/after). */
  current?: string;
}

export interface Proposal {
  id: string;
  createdAt: string;
  status: "pending" | "confirmed" | "discarded" | "superseded" | "stale";
  date: string;
  kind: "plan" | "replan";
  basePlanVersion: number;
  plan: PlanDraft | null;
  taskChanges: TaskChange[];
  contextSuggestions: ContextSuggestion[];
  warnings: string[];
}

/** The app's own record of one chat action: what really happened, whatever the model said. */
export interface Receipt {
  ok: boolean;
  text: string;
  taskId?: string;
  undoId?: string;
  /** A refused action the user can still choose to run (e.g. record overlapping time anyway). */
  retry?: Record<string, unknown>;
  retryLabel?: string;
  needsPreview?: boolean;
  needsChoice?: "switch";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  meta: {
    questions?: string[];
    proposalId?: string;
    capturedTaskIds?: string[];
    addedMeetingIds?: string[];
    demo?: boolean;
    notes?: string[];
    exampleAnswer?: string;
    demoPhase?: string;
    demoInfo?: unknown;
    kind?: "chat" | "replan" | "review" | "wrapup";
    system?: boolean;
    quickReplies?: string[];
    receipts?: Receipt[];
  };
}

export interface AppState {
  workspace: Workspace;
  liveAvailable: boolean;
  model: string | null;
  authRequired: boolean;
  today: string;
  now: string;
  weekday: string;
  timezone: string;
  profile: Profile;
  tasks: Task[];
  meetings: Meeting[];
  plan: Plan | null;
  planVersions: { version: number; createdAt: string; source: string }[];
  proposal: Proposal | null;
  /** Set when the last plan is from an earlier day and has unfinished work. */
  newDay: { lastPlanDate: string; unfinishedTaskIds: string[] } | null;
  messages: ChatMessage[];
  hasAnyData: boolean;
  /** Set when the server's data isn't on permanent storage (it would be lost on the next update). */
  storageWarning: string | null;
  /** The frontend build the server is serving (see server/build.ts). */
  buildId: string | null;
  /** The server's clock, so a device with a wrong clock still shows the right elapsed time. */
  serverNow: string;
  running: RunningTimer | null;
  /** Uncertain timer time waiting for the user to confirm or correct. */
  checks: WorkSession[];
  taskMeta: Record<string, TaskMeta>;
  /** Today and the next six days, computed once for Today, Tomorrow and Week. */
  days: DaySummary[];
  /** Unfinished tasks from earlier days, visible until decided. Never assigned automatically. */
  carryovers: string[];
  suggestion: NextSuggestion | null;
  /** Today's planned blocks that already began or were rescheduled/removed — the day's record. */
  history: HistoryItem[];
  /** Actual work recorded today. */
  sessions: WorkSession[];
  drafts: TaskDraft[];
  /** Today's evening wrap-up, if done. */
  wrapUpToday: WrapUp | null;
  /** The most recent wrap-up from an earlier day (used for the morning check-in). */
  lastWrapUp: WrapUp | null;
  learning: EstimationInsight;
  tomorrow: { date: string; weekday: string; plan: Plan | null; meetings: Meeting[] };
  /** Commitments after today (next 30 days). */
  upcoming: Meeting[];
  calendars: CalendarFeedInfo[];
  /** Secret token for the "Nikki in your calendar" subscription link, or null if not created. */
  nikkiFeedToken: string | null;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: string[];
}

/** What keeping going past a planned block would do to the rest of today. */
export interface OverrunPreview {
  needed: boolean;
  taskId: string;
  blockEnd: string | null;
  newEnd: string | null;
  minutes: number;
  fixed: { title: string; start: string; pinned: boolean } | null;
  shifted: { taskId: string | null; title: string; from: string; to: string }[];
  dropped: { taskId: string | null; title: string }[];
  capped: boolean;
}
