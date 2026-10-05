import Anthropic from "@anthropic-ai/sdk";
import { PlannerProvider, ProviderError, ProviderRequest, ProviderResult } from "./types.js";

const REQUEST_TIMEOUT_MS = 90_000;

export class AnthropicProvider implements PlannerProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string, clientOptions: Partial<ConstructorParameters<typeof Anthropic>[0]> = {}) {
    // maxRetries: the SDK retries 408/409/429/5xx and connection errors once, with backoff.
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1, ...clientOptions });
  }

  /**
   * Structured outputs are used when the API accepts our schema. If it rejects the
   * schema itself (e.g. "compiled grammar is too large"), we switch — once, for the
   * life of the server — to asking for JSON in the instructions. Every reply is
   * still validated on the server either way.
   */
  private structured = true;

  async generate(req: ProviderRequest): Promise<ProviderResult> {
    try {
      return await this.call(req, this.structured);
    } catch (err) {
      if (this.structured && isSchemaRejection(err)) {
        console.warn("[claude] structured-output schema rejected by the API; falling back to JSON instructions:", (err as Error).message);
        this.structured = false;
        try {
          return await this.call(req, false);
        } catch (err2) {
          throw err2 instanceof ProviderError ? err2 : mapError(err2);
        }
      }
      throw err instanceof ProviderError ? err : mapError(err);
    }
  }

  private async call(req: ProviderRequest, structured: boolean): Promise<ProviderResult> {
    const system = structured
      ? req.system
      : `${req.system}\n\nRespond with ONLY a single JSON object — no code fences, no text before or after it — that matches this JSON Schema:\n${JSON.stringify(req.schema)}`;
    const response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: req.messages,
          output_config: structured ? { effort: "medium", format: { type: "json_schema", schema: req.schema } } : { effort: "medium" },
          // If a safety classifier declines, the API retries on a suitable fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: req.signal },
      );

    if (response.stop_reason === "refusal") {
      throw new ProviderError("Claude declined this request. Try rephrasing it.", "refusal");
    }
    if (response.stop_reason === "max_tokens") {
      throw new ProviderError("Claude's reply was cut off before it finished. Please try again.", "truncated");
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) throw new ProviderError("Claude returned an empty reply.", "invalid_output");
    return { text, model: response.model };
  }
}

function isSchemaRejection(err: unknown) {
  return err instanceof Anthropic.BadRequestError && /grammar|schema|output_config|output format|json_schema/i.test(err.message);
}

function mapError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY in your .env file.", "auth", 502);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("Claude's rate limit was reached. Wait a minute and try again.", "rate_limit", 429);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("Claude took too long to respond. Please try again.", "timeout", 504);
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ProviderError("The request was cancelled.", "timeout", 499);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("Couldn't reach the Claude API. Check your internet connection.", "network", 502);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError("The configured model was not found. Check ANTHROPIC_MODEL in your .env file.", "bad_request", 502);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`Claude rejected the request: ${apiMessage(err)}`, "bad_request", 502);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ProviderError("Claude is temporarily overloaded or unavailable. Try again shortly.", "overloaded", 503);
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`Claude API error (${err.status ?? "unknown"}): ${apiMessage(err)}`, "unknown", 502);
  }
  return new ProviderError(`Unexpected error calling Claude: ${(err as Error)?.message ?? err}`, "unknown", 500);
}

/** The human-readable part of an API error (not the raw JSON body). */
function apiMessage(err: InstanceType<typeof Anthropic.APIError>) {
  const body = err.error as { error?: { message?: string } } | undefined;
  return body?.error?.message ?? err.message;
}
