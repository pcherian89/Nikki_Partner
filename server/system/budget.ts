import { clockIso, getSetting, newId, setSetting, type DB } from "../db.js";
import { UserFacingError } from "../errors.js";
import { currentInstant, localNow } from "../time.js";
import { logActivity } from "./activity.js";
import { controls, setControl } from "./controls.js";
import { notify, notifyTz } from "./notifications.js";

/**
 * AI spend tracking and budget controls.
 *
 * - Every model call is recorded with its real token counts (from the API's `usage`) and priced from the table
 *   below. Nikki cannot read the Anthropic account's credit balance without an admin key (deliberately not used),
 *   so the numbers here are Nikki's own measurement, not the invoice.
 * - Months and days are counted in the user's time zone (India by default).
 * - Agents must reserve an estimated cost before calling the model; the reservation fails if it would cross the
 *   daily, monthly or per-agent limit. At 100% agents stop. Interactive planning keeps working with a warning unless
 *   the user turns on "Block planning too".
 * - Nothing here buys credit or enables auto top-up.
 */

/**
 * US dollars per million tokens, Anthropic first-party API rates (re-checked 28 Nov 2026): Opus 5.5 $4/$20 with cache
 * reads $0.20; Sonnet 5.5 $2/$10 with cache reads $0.10; Haiku 5.5 $0.10/$0.50 for prompts up to 100K tokens and
 * $0.50/$2.50 beyond. Cache writes use the 5-minute rate (1.25× input). Haiku 5.5's cache-read rate isn't published in
 * the reference used, so it assumes the usual 0.1× input. The API's `input_tokens` counts only uncached input; cached
 * reads and cache writes arrive as separate counts and are priced separately here.
 */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
/** An unknown model is priced like the most expensive one, so the budget errs on the safe side. */
const UNKNOWN_PRICE = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export function priceFor(model: string) {
  const id = model.replace(/-\d{8}$/, "");
  return PRICES[id] ?? UNKNOWN_PRICE;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Haiku 5.5 charges a higher rate for the whole call when the prompt is over 100K tokens. */
const HAIKU_LONG = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 };

export function costOf(model: string, u: Usage) {
  const promptTokens = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  const p = model.replace(/-\d{8}$/, "") === "claude-haiku-5-5" && promptTokens > 100_000 ? HAIKU_LONG : priceFor(model);
  return (u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.cacheWriteTokens ?? 0) * p.cacheWrite) / 1_000_000;
}

export interface BudgetSettings {
  monthlyUsd: number;
  dailyUsd: number;
  /** Optional monthly cap per agent id. */
  perAgentMonthlyUsd: Record<string, number>;
  /** When true, interactive planning is also refused once the monthly budget is used up. */
  blockPlannerAtLimit: boolean;
}

/**
 * $5 a month for everything (owner's choice). The daily limit applies to background agents only: $0.25 a day lets a
 * normal day of agent work through (a Sonnet briefing is about $0.05, sorting 40 emails on Haiku about $0.01) while a
 * runaway agent can use at most 5% of the month in one day.
 */
export const DEFAULT_BUDGET: BudgetSettings = { monthlyUsd: 5, dailyUsd: 0.25, perAgentMonthlyUsd: {}, blockPlannerAtLimit: false };

/** The moment Nikki started counting its own AI use. Spend before it exists only in the Claude Console. */
export function meteringSince(db: DB): string {
  let v = getSetting(db, "ai_metering_since");
  if (!v) {
    v = clockIso();
    setSetting(db, "ai_metering_since", v);
  }
  return v;
}
export const THRESHOLDS = [50, 75, 90, 100] as const;

export function getBudget(db: DB): BudgetSettings {
  try {
    return { ...DEFAULT_BUDGET, ...JSON.parse(getSetting(db, "ai_budget") ?? "{}") };
  } catch {
    return DEFAULT_BUDGET;
  }
}

export function saveBudget(db: DB, b: BudgetSettings) {
  if (!(b.monthlyUsd >= 0 && b.monthlyUsd <= 500) || !(b.dailyUsd >= 0 && b.dailyUsd <= 500)) throw new UserFacingError("Budgets must be between $0 and $500.");
  setSetting(db, "ai_budget", JSON.stringify(b));
  logActivity(db, "user", "budget.changed", null, { amount: b.monthlyUsd });
}

const periods = (db: DB) => {
  const d = localNow(notifyTz(db)).date;
  return { day: d, month: d.slice(0, 7) };
};

const sum = (db: DB, sql: string, ...args: unknown[]) => ((db.prepare(sql).get(...args) as { v: number | null }).v ?? 0);

function releaseExpired(db: DB) {
  db.prepare("UPDATE budget_reservations SET status = 'released' WHERE status = 'held' AND expires_at < ?").run(clockIso());
}

export interface Spend {
  month: string;
  day: string;
  monthUsd: number;
  dayUsd: number;
  heldUsd: number;
  monthlyUsd: number;
  dailyUsd: number;
  percent: number;
  byWorkflow: { workflow: string; usd: number; calls: number }[];
  byModel: { model: string; usd: number; inputTokens: number; outputTokens: number }[];
  state: "ok" | "warning" | "limit";
  /** Money left this month under the configured budget (never below 0). */
  remainingUsd: number;
  /** Calls whose cost could not be measured (no token counts came back); counted as $0. */
  unmeasuredCalls: number;
  /** When Nikki started measuring. */
  since: string;
  /** True when the user chose to pause planning at the limit and the limit is reached. */
  plannerBlocked: boolean;
  blockPlannerAtLimit: boolean;
  aiPaused: boolean;
  aiPausedReason: string | null;
}

export function spend(db: DB): Spend {
  releaseExpired(db);
  const { day, month } = periods(db);
  const b = getBudget(db);
  const monthUsd = sum(db, "SELECT SUM(cost_usd) AS v FROM ai_usage WHERE month = ?", month);
  const dayUsd = sum(db, "SELECT SUM(cost_usd) AS v FROM ai_usage WHERE day = ?", day);
  const heldUsd = sum(db, "SELECT SUM(amount_usd) AS v FROM budget_reservations WHERE status = 'held' AND month = ?", month);
  const percent = b.monthlyUsd > 0 ? Math.round((monthUsd / b.monthlyUsd) * 1000) / 10 : monthUsd > 0 ? 100 : 0;
  const c = controls(db);
  return {
    month,
    day,
    monthUsd,
    dayUsd,
    heldUsd,
    monthlyUsd: b.monthlyUsd,
    dailyUsd: b.dailyUsd,
    percent,
    byWorkflow: db.prepare("SELECT workflow, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM ai_usage WHERE month = ? GROUP BY workflow ORDER BY usd DESC").all(month) as Spend["byWorkflow"],
    byModel: (
      db.prepare("SELECT model, SUM(cost_usd) AS usd, SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens FROM ai_usage WHERE month = ? GROUP BY model ORDER BY usd DESC").all(month) as Spend["byModel"]
    ),
    state: percent >= 100 ? "limit" : percent >= 75 ? "warning" : "ok",
    remainingUsd: Math.max(0, b.monthlyUsd - monthUsd),
    unmeasuredCalls: sum(db, "SELECT COUNT(*) AS v FROM ai_usage WHERE month = ? AND estimated = 1", month),
    since: meteringSince(db),
    plannerBlocked: b.blockPlannerAtLimit && monthUsd >= b.monthlyUsd,
    blockPlannerAtLimit: b.blockPlannerAtLimit,
    aiPaused: c.aiPaused,
    aiPausedReason: c.aiPausedReason,
  };
}

export class BudgetError extends UserFacingError {}

/**
 * Agents call this before a model call. Atomic (one SQLite transaction), so two agents can't both squeeze under the
 * limit. Returns a reservation id to settle after the call.
 */
export function reserve(db: DB, workflow: string, agentId: string | null, estimateUsd: number): string {
  return db.transaction(() => {
    releaseExpired(db);
    const c = controls(db);
    if (c.aiPaused) throw new BudgetError(c.aiPausedReason || "AI calls for agents are paused.", 402, "ai_paused");
    const { day, month } = periods(db);
    const b = getBudget(db);
    const held = sum(db, "SELECT SUM(amount_usd) AS v FROM budget_reservations WHERE status = 'held' AND month = ?", month);
    const heldDay = sum(db, "SELECT SUM(amount_usd) AS v FROM budget_reservations WHERE status = 'held' AND day = ?", day);
    const m = sum(db, "SELECT SUM(cost_usd) AS v FROM ai_usage WHERE month = ?", month);
    const d = sum(db, "SELECT SUM(cost_usd) AS v FROM ai_usage WHERE day = ?", day);
    if (m + held + estimateUsd > b.monthlyUsd) throw new BudgetError(`This month's AI budget ($${b.monthlyUsd.toFixed(2)}) would be exceeded, so the agent stopped.`, 402, "budget_month");
    if (d + heldDay + estimateUsd > b.dailyUsd) throw new BudgetError(`Today's AI limit ($${b.dailyUsd.toFixed(2)}) would be exceeded, so the agent stopped.`, 402, "budget_day");
    if (agentId && b.perAgentMonthlyUsd[agentId] !== undefined) {
      const a = sum(db, "SELECT SUM(cost_usd) AS v FROM ai_usage WHERE month = ? AND agent_id = ?", month, agentId);
      const ah = sum(db, "SELECT SUM(amount_usd) AS v FROM budget_reservations WHERE status = 'held' AND month = ? AND agent_id = ?", month, agentId);
      if (a + ah + estimateUsd > b.perAgentMonthlyUsd[agentId]) throw new BudgetError("This agent's monthly AI limit would be exceeded, so it stopped.", 402, "budget_agent");
    }
    const id = newId("rsv");
    const expires = new Date(currentInstant().getTime() + 15 * 60_000).toISOString();
    db.prepare("INSERT INTO budget_reservations (id, at, month, day, workflow, agent_id, amount_usd, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)").run(
      id,
      clockIso(),
      month,
      day,
      workflow,
      agentId,
      estimateUsd,
      expires,
    );
    return id;
  })();
}

export function releaseReservation(db: DB, id: string | null) {
  if (id) db.prepare("UPDATE budget_reservations SET status = 'settled' WHERE id = ? AND status = 'held'").run(id);
}

/** Interactive planning: refused only when the user chose "Block planning too" and the month is used up. */
export function checkPlannerAllowed(db: DB) {
  const b = getBudget(db);
  if (!b.blockPlannerAtLimit) return;
  const s = spend(db);
  if (s.monthUsd >= b.monthlyUsd) throw new BudgetError(`This month's AI budget ($${b.monthlyUsd.toFixed(2)}) is used up. You can raise it in Context → AI usage.`, 402, "budget_month");
}

/** Records one model call and sends the 50/75/90/100% alerts once per month each. */
export async function recordUsage(
  db: DB,
  r: { workflow: string; agentId?: string | null; model: string; usage: Usage | null; status: "ok" | "error" },
): Promise<number> {
  const { day, month } = periods(db);
  const u = r.usage ?? { inputTokens: 0, outputTokens: 0 };
  const cost = costOf(r.model, u);
  db.prepare(
    "INSERT INTO ai_usage (id, at, month, day, workflow, agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, estimated, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(newId("use"), clockIso(), month, day, r.workflow, r.agentId ?? null, r.model, u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0, cost, r.usage ? 0 : 1, r.status);
  await checkThresholds(db);
  return cost;
}

export async function checkThresholds(db: DB) {
  const s = spend(db);
  for (const t of THRESHOLDS) {
    if (s.percent < t) continue;
    const { created } = await notify(db, {
      category: "budget",
      priority: t >= 90 ? "high" : "normal",
      title: t >= 100 ? "AI budget used up" : `AI budget ${t}% used`,
      body:
        t >= 100
          ? `Nikki has used $${s.monthUsd.toFixed(2)} of this month's $${s.monthlyUsd.toFixed(2)}. Agents have stopped; planning still works${getBudget(db).blockPlannerAtLimit ? " only after you raise the budget" : " and is still counted"}.`
          : `Nikki has used $${s.monthUsd.toFixed(2)} of this month's $${s.monthlyUsd.toFixed(2)} AI budget.`,
      link: "/?view=context#ai-usage",
      dedupeKey: `budget:${s.month}:${t}`,
    });
    if (created) logActivity(db, "system", "budget.threshold", s.month, { percent: t });
  }
}

/** Called when the API says the credit balance is too low: agents' AI stops and the user is told once. */
export async function onCreditExhausted(db: DB) {
  if (!controls(db).aiPaused) {
    setControl(db, "ai", true, "system", "Your Anthropic API credit has run out. Nikki never buys credit or turns on auto top-up; add credit in the Claude Console, then resume here.");
  }
  await notify(db, {
    category: "budget",
    priority: "urgent",
    title: "Anthropic API credit has run out",
    body: "AI features are paused. Add credit in the Claude Console (Billing), then tap Resume AI in Nikki.",
    link: "/?view=context#ai-usage",
    dedupeKey: `credit:${periods(db).day}`,
  });
}
