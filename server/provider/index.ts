import { config } from "../config.js";
import { getDb } from "../db.js";
import { checkPlannerAllowed, onCreditExhausted, recordUsage } from "../system/budget.js";
import { AnthropicProvider } from "./anthropic.js";
import { ProviderError, type PlannerProvider, type ProviderRequest, type ProviderResult } from "./types.js";

let provider: PlannerProvider | null = null;
let metered: { inner: PlannerProvider; outer: PlannerProvider } | null = null;

/**
 * Wraps the planner so every call is counted against the AI budget. The model is NOT changed: the wrapper passes the
 * request through untouched and only records what the API reports (Opus 5.5 unless ANTHROPIC_MODEL says otherwise).
 */
function meter(inner: PlannerProvider): PlannerProvider {
  return {
    name: inner.name,
    model: inner.model,
    async generate(req: ProviderRequest): Promise<ProviderResult> {
      const db = getDb("personal");
      const workflow = req.workflow ?? "planner";
      checkPlannerAllowed(db);
      try {
        const r = await inner.generate(req);
        await recordUsage(db, { workflow, model: r.model || inner.model, usage: r.usage ?? null, status: "ok" });
        return r;
      } catch (e) {
        // A failed call may still have been billed in part; it is recorded at zero and marked as an error.
        await recordUsage(db, { workflow, model: inner.model, usage: null, status: "error" }).catch(() => {});
        if (e instanceof ProviderError && e.code === "credit") await onCreditExhausted(db).catch(() => {});
        throw e;
      }
    },
  };
}

/** Returns the live provider (metered), or null when no API key is configured. */
export function getProvider(): PlannerProvider | null {
  if (!provider && config.apiKey) provider = new AnthropicProvider(config.apiKey, config.model);
  if (!provider) return null;
  if (metered?.inner !== provider) metered = { inner: provider, outer: meter(provider) };
  return metered.outer;
}

/** Test hook: lets tests inject a fake provider. */
export function setProvider(p: PlannerProvider | null) {
  provider = p;
}
