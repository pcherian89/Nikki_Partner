import { getSetting, setSetting, type DB } from "../db.js";
import { logActivity } from "./activity.js";

/**
 * Emergency controls. Checked in code before every agent run, every AI call made for an agent and every action
 * execution. They take effect immediately (no restart) and survive restarts (stored in settings).
 *
 * - agents: stops every agent run and every scheduled agent job.
 * - actions: stops every action from executing (approvals stay recorded; nothing runs until resumed).
 * - ai: set automatically when the API reports the credit balance is too low; stops agent AI calls until cleared.
 */
export type Control = "agents" | "actions" | "ai";

export interface Controls {
  agentsPaused: boolean;
  actionsPaused: boolean;
  aiPaused: boolean;
  aiPausedReason: string | null;
}

const key = (c: Control) => `control_paused:${c}`;

export function controls(db: DB): Controls {
  return {
    agentsPaused: getSetting(db, key("agents")) === "1",
    actionsPaused: getSetting(db, key("actions")) === "1",
    aiPaused: getSetting(db, key("ai")) === "1",
    aiPausedReason: getSetting(db, "control_ai_reason"),
  };
}

export function setControl(db: DB, c: Control, paused: boolean, actor: "user" | "system" = "user", reason: string | null = null) {
  setSetting(db, key(c), paused ? "1" : "0");
  if (c === "ai") setSetting(db, "control_ai_reason", paused ? reason ?? "" : "");
  logActivity(db, actor, paused ? "control.paused" : "control.resumed", c, { reason: reason ?? undefined });
}

/** The big red button: pause agents and actions together. */
export function stopEverything(db: DB) {
  setControl(db, "agents", true);
  setControl(db, "actions", true);
}
