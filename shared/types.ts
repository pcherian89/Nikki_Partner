// Types shared by the server and the browser app.

export type Workspace = "personal" | "demo";

export type TaskType = "action" | "idea" | "reference";
export type TaskStatus = "open" | "waiting" | "blocked" | "done";

export interface Task {
  id: string;
  title: string;
  notes: string;
  type: TaskType;
  status: TaskStatus;
  estimateMinutes: number | null;
  /** Only set when the user stated a real deadline. Never invented. */
  deadline: string | null;
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
