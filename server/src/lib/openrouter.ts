import { config } from "../config";
import { appendJsonl } from "./artifacts";
import { recordModelCall } from "./callContext";
import { HttpError, createRateLimiter, withRetry } from "./retry";

const { openrouter: or } = config;
const acquire = createRateLimiter(or.rpmPerModel);

async function post(endpoint: string, body: BodyInit, headers: Record<string, string> = {}) {
  if (!or.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch(`${or.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${or.apiKey}`, ...headers },
    body,
    signal: AbortSignal.timeout(or.requestTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError("OpenRouter", res.status, text);
  return JSON.parse(text);
}

export type ChatContent =
  | string
  | (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "input_audio"; input_audio: { data: string; format: string } }
    )[];

/** Chat completion with JSON-schema structured output. Returns the parsed JSON object (unvalidated). */
export async function chatJson(opts: {
  label: string;
  system: string;
  user: ChatContent;
  schemaName: string;
  schema: object;
  /** Defaults to the reasoning model. */
  model?: string;
  /** Appends one JSONL line per attempt (request + response, or request + error) to this file. */
  logFile?: string;
  /**
   * Groups calls that share a prompt prefix, so the provider can serve the fixed head of the
   * request from its cache at a tenth of the input rate instead of re-reading it every call. Only
   * the stable part benefits: the per-call tail is always read fresh, so the key must be the same
   * for every call built from the same fixed head and must change when that head changes.
   * Measured on placement: without it, consecutive calls sharing ~2.2k tokens of prefix cached
   * nothing at all; with it, a third of each call's input came from cache.
   */
  cacheKey?: string;
}): Promise<unknown> {
  const model = opts.model ?? or.reasonModel;
  return withRetry(
    opts.label,
    or.retries,
    async () => {
      await acquire(model);
      const started = new Date();
      const body = {
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
        },
        ...(opts.cacheKey ? { prompt_cache_key: opts.cacheKey } : {}),
        usage: { include: true },
      };
      let res: any;
      try {
        res = await post("/chat/completions", JSON.stringify(body), { "Content-Type": "application/json" });
      } catch (err) {
        recordModelCall({
          provider: "openrouter",
          model,
          label: opts.label,
          startedAt: started.toISOString(),
          latencyMs: Date.now() - started.getTime(),
          ok: false,
          httpStatus: err instanceof HttpError ? err.status : undefined,
          error: (err as Error).message,
        });
        if (opts.logFile) {
          await appendJsonl(opts.logFile, {
            at: started.toISOString(),
            label: opts.label,
            request: body,
            error: (err as Error).message,
          }).catch(() => {});
        }
        throw err;
      }
      recordModelCall({
        provider: "openrouter",
        model,
        label: opts.label,
        startedAt: started.toISOString(),
        latencyMs: Date.now() - started.getTime(),
        ok: true,
        httpStatus: 200,
        inputTokens: res?.usage?.prompt_tokens,
        outputTokens: res?.usage?.completion_tokens,
        costUsd: typeof res?.usage?.cost === "number" ? res.usage.cost : undefined,
      });
      if (opts.logFile) {
        await appendJsonl(opts.logFile, { at: started.toISOString(), label: opts.label, request: body, response: res }).catch(() => {});
      }
      const content = res?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error(`${opts.label}: no message content in response`);
      return JSON.parse(content);
    },
    or.rateLimitRetries,
  );
}
