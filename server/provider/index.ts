import { config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import type { PlannerProvider } from "./types.js";

let provider: PlannerProvider | null = null;

/** Returns the live provider, or null when no API key is configured. */
export function getProvider(): PlannerProvider | null {
  if (provider) return provider;
  if (!config.apiKey) return null;
  provider = new AnthropicProvider(config.apiKey, config.model);
  return provider;
}

/** Test hook: lets tests inject a fake provider. */
export function setProvider(p: PlannerProvider | null) {
  provider = p;
}
