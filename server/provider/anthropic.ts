import Anthropic from "@anthropic-ai/sdk";
import { PlannerProvider, ProviderError, ProviderRequest, ProviderResult } from "./types.js";

const REQUEST_TIMEOUT_MS = 90_000;

export class AnthropicProvider implements PlannerProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    // maxRetries: the SDK retries 408/409/429/5xx and connection errors once, with backoff.
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  }

  async generate(req: ProviderRequest): Promise<ProviderResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: req.messages,
          output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
          // If a safety classifier declines, the API retries on a suitable fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw mapError(err);
    }

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
    return new ProviderError(`Claude rejected the request: ${err.message}`, "bad_request", 502);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ProviderError("Claude is temporarily overloaded or unavailable. Try again shortly.", "overloaded", 503);
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`Claude API error (${err.status ?? "unknown"}): ${err.message}`, "unknown", 502);
  }
  return new ProviderError(`Unexpected error calling Claude: ${(err as Error)?.message ?? err}`, "unknown", 500);
}
