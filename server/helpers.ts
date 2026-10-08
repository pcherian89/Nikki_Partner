import { z } from "zod";
import type { Profile, Task, TaskDraft, Workspace } from "../shared/types.js";
import { UserFacingError } from "./assistant.js";
import { addDraft, DB, getProfile, getTask, listTasks } from "./db.js";
import { adjustEstimate, estimationInsight } from "./learning.js";
import { getProvider } from "./provider/index.js";
import { ProviderError, ProviderMessage } from "./provider/types.js";

/**
 * Task helpers: "Break it down" (small concrete steps) and "Help me start"
 * (a useful first draft). Each is one small, separate model call with its own
 * schema. Demo mode uses clearly labelled templates instead of AI.
 */

const STEPS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps", "note"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "minutes"],
        properties: { title: { type: "string" }, minutes: { type: "integer" } },
      },
    },
    note: { type: "string" },
  },
} as const;

const StepsResponse = z.object({
  steps: z
    .array(z.object({ title: z.string().trim().min(2).max(200), minutes: z.number().int().min(1).max(480) }))
    .min(2)
    .max(10),
  note: z.string().max(600),
});

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "title", "content", "next_step"],
  properties: {
    format: { type: "string", enum: ["email", "message", "outline", "checklist", "social_post", "plan", "notes"] },
    title: { type: "string" },
    content: { type: "string" },
    next_step: { type: "string" },
  },
} as const;

const DraftResponse = z.object({
  format: z.enum(["email", "message", "outline", "checklist", "social_post", "plan", "notes"]),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(8000),
  next_step: z.string().max(400),
});

const BREAKDOWN_PROMPT = `You are Nikki, a practical planning partner. Break ONE task into 3–8 small, concrete steps the user can tick off.
- Each step starts with a verb and is specific to this task (not generic advice).
- The first step should take 15 minutes or less, so it's easy to start.
- Give a realistic minutes estimate per step. If the app says the user's tasks usually take longer than estimated, account for that.
- Use the user's context (projects, goals, preferences) when relevant. Never invent facts, names, prices or deadlines.
- If the task is vague, the first step is to decide what "done" means.
- note: one short sentence (optional tip), or "".
Respond only with JSON matching the schema.`;

const ASSIST_PROMPT = `You are Nikki, a practical planning partner. Help the user get started on ONE task by producing a genuinely useful first draft they can edit.
- Pick the most helpful format: an email or message to send, an outline, a checklist, a social post, a short plan, or working notes.
- Be concise and ready to use. Write in a warm, professional voice.
- Never invent specifics you weren't given (names, numbers, prices, dates, URLs, results). Use clear placeholders like [client name] instead.
- Use the user's context (businesses, goals, preferences) when relevant.
- content is plain text (simple markdown lists are fine). title is a short label. next_step is one sentence: the very next physical action.
Respond only with JSON matching the schema.`;

function taskContext(task: Task, profile: Profile, all: Task[]) {
  const learning = estimationInsight(all);
  const ctx = {
    task: {
      title: task.title,
      notes: task.notes || undefined,
      project: task.project || undefined,
      estimate_minutes: task.estimateMinutes || undefined,
      deadline: task.deadline || undefined,
      existing_steps: task.steps.length ? task.steps.map((s) => s.title) : undefined,
    },
    user_context: Object.fromEntries(
      Object.entries({
        name: profile.name,
        businesses_and_projects: profile.projects,
        goals: profile.goals,
        main_outcome: profile.mainOutcome,
        planning_preferences: profile.preferences,
      }).filter(([, v]) => v),
    ),
    ...(learning.factor ? { estimation_history: `The user's tasks usually take about ${learning.factor}× their estimate.` } : {}),
  };
  return JSON.stringify(ctx, null, 1);
}

async function callJson<T>(system: string, user: string, schema: Record<string, unknown>, parser: z.ZodType<T>): Promise<T> {
  const provider = getProvider();
  if (!provider) {
    throw new UserFacingError("Live AI isn't set up: no ANTHROPIC_API_KEY on the server.", 503, "no_api_key");
  }
  const messages: ProviderMessage[] = [{ role: "user", content: user }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await provider.generate({ system, messages, schema });
    const first = raw.text.indexOf("{");
    const last = raw.text.lastIndexOf("}");
    try {
      const parsed = parser.safeParse(JSON.parse(raw.text.slice(first, last + 1)));
      if (parsed.success) return parsed.data;
      messages.push({ role: "assistant", content: raw.text }, { role: "user", content: `That didn't match the schema (${parsed.error.issues[0]?.message}). Return the full JSON again.` });
    } catch {
      messages.push({ role: "assistant", content: raw.text }, { role: "user", content: "That wasn't valid JSON. Return the full JSON again." });
    }
  }
  throw new ProviderError("Claude returned a response the app couldn't understand. Please try again.", "invalid_output");
}

const inFlight = new Set<string>();

async function guarded<T>(key: string, fn: () => Promise<T>) {
  if (inFlight.has(key)) throw new UserFacingError("Nikki is already working on this.", 409, "busy");
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

// ---------- Break it down ----------

export async function breakDown(db: DB, ws: Workspace, taskId: string): Promise<{ steps: { title: string; minutes: number }[]; note: string; demo: boolean }> {
  const task = getTask(db, taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  return guarded(`${ws}:${taskId}:breakdown`, async () => {
    if (ws === "demo") return { ...demoSteps(task, estimationInsight(listTasks(db))), demo: true };
    const r = await callJson(BREAKDOWN_PROMPT, taskContext(task, getProfile(db), listTasks(db)), STEPS_SCHEMA, StepsResponse);
    return { ...r, demo: false };
  });
}

// ---------- Help me start ----------

export async function helpMeStart(db: DB, ws: Workspace, taskId: string, ask: string): Promise<TaskDraft> {
  const task = getTask(db, taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  return guarded(`${ws}:${taskId}:assist`, async () => {
    if (ws === "demo") {
      return addDraft(db, { taskId, ...demoDraft(task, ask), demo: true });
    }
    const user = `${taskContext(task, getProfile(db), listTasks(db))}${ask.trim() ? `\n\nWhat the user wants help with: ${ask.trim()}` : ""}`;
    const r = await callJson(ASSIST_PROMPT, user, DRAFT_SCHEMA, DraftResponse);
    return addDraft(db, { taskId, format: r.format, title: r.title, content: r.content, nextStep: r.next_step, demo: false });
  });
}

// ---------- Demo templates (not AI) ----------

export function demoSteps(task: Task, learning = estimationInsight([])) {
  const t = task.title.toLowerCase();
  let steps: [string, number][];
  if (/website|site|landing|page/.test(t)) {
    steps = [
      ["List what's left: pages, copy, images, fixes", 15],
      ["Write or finish the missing copy", 45],
      ["Add images and check every page on mobile", 30],
      ["Fix the issues you found", 30],
      ["Connect the domain and publish", 20],
      ["Share the link with one person for feedback", 10],
    ];
  } else if (/proposal|report|deck|document|write|draft/.test(t)) {
    steps = [
      ["Write one sentence on what this must achieve", 10],
      ["Outline the main sections", 15],
      ["Draft the first section, roughly", 40],
      ["Draft the remaining sections", 45],
      ["Edit, tighten and check the numbers", 25],
      ["Send it, or ask for a review", 10],
    ];
  } else if (/apply|application|job/.test(t)) {
    steps = [
      ["Pick 3 roles worth applying to", 15],
      ["Tailor your CV to the first role", 25],
      ["Write a short cover note", 20],
      ["Submit and log it", 10],
    ];
  } else if (/automat|post|social|promot/.test(t)) {
    steps = [
      ["Decide the channels and posting frequency", 10],
      ["Write the first 3 posts", 30],
      ["Pick and set up a scheduling tool", 25],
      ["Schedule the posts and check one goes out", 15],
    ];
  } else {
    steps = [
      ["Write down what “done” looks like", 10],
      ["Gather what you need", 15],
      ["Do a rough first pass", 30],
      ["Review and fix", 20],
      ["Finish and share or file it", 10],
    ];
  }
  return {
    steps: steps.map(([title, minutes]) => ({ title, minutes: adjustEstimate(minutes, learning, task.project) })),
    note: "",
  };
}

export function demoDraft(task: Task, ask: string) {
  const t = task.title.toLowerCase();
  if (/email|follow up|follow-up|reply|client|call/.test(`${t} ${ask.toLowerCase()}`)) {
    return {
      format: "email",
      title: `Email: ${task.title}`,
      content: `Subject: [short, specific subject]\n\nHi [name],\n\nI hope you're well. I'm following up on [topic]. [One sentence on why it matters to them.]\n\nCould you [the one thing you need] by [day]?\n\nThanks,\n[your name]`,
      nextStep: "Fill in the placeholders and send it.",
    };
  }
  return {
    format: "outline",
    title: `Outline: ${task.title}`,
    content: `Goal: [what “done” looks like]\n\n1. [First part]\n   - [key point]\n2. [Second part]\n   - [key point]\n3. [Wrap-up / next action]\n\nOpen questions:\n- [anything you need to find out]`,
    nextStep: "Fill in the goal line, then spend 10 minutes on part 1.",
  };
}
