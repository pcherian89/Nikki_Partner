/**
 * Minimal model-provider interface. Only Anthropic is implemented; another
 * provider can be added by implementing this interface in a new file and
 * choosing it in provider/index.ts.
 */
export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  /** JSON Schema the reply must follow. */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  /** What the call is for, for AI usage tracking (defaults to "planner"). */
  workflow?: string;
}

export interface ProviderResult {
  /** Raw JSON text returned by the model. */
  text: string;
  model: string;
  /** Token counts reported by the API, when the provider gives them. */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

export interface PlannerProvider {
  readonly name: string;
  readonly model: string;
  generate(req: ProviderRequest): Promise<ProviderResult>;
}

/** A user-presentable failure from the provider. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public code: "auth" | "rate_limit" | "timeout" | "network" | "overloaded" | "bad_request" | "refusal" | "truncated" | "invalid_output" | "credit" | "budget" | "unknown",
    public status = 502,
  ) {
    super(message);
  }
}
