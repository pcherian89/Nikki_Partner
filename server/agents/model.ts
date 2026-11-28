import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { ProviderError } from "../provider/types.js";
import { isCreditError } from "../provider/anthropic.js";

/**
 * The model interface used by agents (separate from the planner, whose behaviour and model are unchanged).
 * One request = one turn; the engine runs the loop so every tool call passes the permission gateway in code.
 */

export type ModelTier = "fast" | "balanced" | "advanced";
export const TIER_MODEL: Record<ModelTier, string> = { fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", advanced: "claude-opus-5-5" };

export interface AgentToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TurnRequest {
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: AgentToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface TurnResult {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export interface AgentModel {
  turn(req: TurnRequest): Promise<TurnResult>;
}

class AnthropicAgentModel implements AgentModel {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  }
  async turn(req: TurnRequest): Promise<TurnResult> {
    // Server-side refusal fallback where the model supports it (not Haiku).
    const fallback = req.model.includes("haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
    try {
      const r = await this.client.beta.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: req.messages,
          tools: req.tools.map((t) => ({ ...t, strict: true })) as Anthropic.Beta.BetaToolUnion[],
          tool_choice: { type: "auto" },
          output_config: { effort: "low" },
          ...fallback,
        },
        { signal: req.signal },
      );
      const u = r.usage;
      return {
        content: r.content,
        stopReason: r.stop_reason,
        model: r.model,
        usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 },
      };
    } catch (e) {
      if (e instanceof Anthropic.APIError && isCreditError(e)) throw new ProviderError("Anthropic API credit has run out.", "credit", 402);
      if (e instanceof Anthropic.APIError) throw new ProviderError(`Claude API error (${e.status ?? "?"}).`, "unknown", 502);
      throw e;
    }
  }
}

let override: AgentModel | null = null;
let live: AgentModel | null = null;
/** Test hook. */
export const setAgentModel = (m: AgentModel | null) => (override = m);
export function getAgentModel(): AgentModel | null {
  if (override) return override;
  if (!config.apiKey) return null;
  return (live ??= new AnthropicAgentModel(config.apiKey));
}
