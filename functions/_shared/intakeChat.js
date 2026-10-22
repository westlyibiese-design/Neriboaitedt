// Non-streaming chat call for server-side features that need a complete JSON
// answer rather than an SSE stream to the browser.
//
// Created for functions/api/orders/intake-chat.js (the AI-driven custom-URL
// order intake). It is deliberately narrow and internal-only — it has no
// public model ID and is never selectable in the app:
//
//   - There is no provider switch and no caller-supplied model. The upstream
//     endpoint, credential and model id come ONLY from the server's own
//     environment: NERIBO_INTAKE_URL, NERIBO_INTAKE_KEY and
//     NERIBO_INTAKE_MODEL. Nothing in this file knows or reveals which
//     company sits behind them; that mapping lives only in the Cloudflare
//     dashboard.
//   - Every failure is normalized into an IntakeCallError with a `kind`, and
//     the REAL detail (status, upstream body, request id) goes only to the
//     server log and to Operations -> Events via reportOperationsEvent.
//     Nothing in an IntakeCallError's message is ever meant for the client.
//   - A missing NERIBO_INTAKE_KEY / NERIBO_INTAKE_URL is logged clearly
//     server-side, reported to Operations as a "high" event, never crashes,
//     and never names the variable to the client.
//
// Reuses the already-shared helpers for the rest (failureKindForStatus from
// aiConfig.js, reportOperationsEvent from operationsEvents.js).

import { reportOperationsEvent } from "./operationsEvents.js";
import { failureKindForStatus } from "./aiConfig.js";

// Fallback used only if NERIBO_INTAKE_MODEL is unset. Deliberately a generic
// placeholder, not a real upstream model id: an operator who forgets to set
// the variable gets a clear upstream rejection instead of this file ever
// hardcoding which real model/provider serves intake.
export const DEFAULT_INTAKE_MODEL = "neribo-intake-default";

/**
 * kind:
 *   "config"    NERIBO_INTAKE_KEY or NERIBO_INTAKE_URL missing
 *   "network"   could not reach the upstream
 *   "timeout"   the upstream did not answer within the allowed time
 *   "upstream"  the upstream answered with a non-2xx status (see `status`)
 *   "malformed" the upstream answered 2xx but with no usable message content
 * failureKind: which Supervisor-editable failure message applies (see
 *   aiConfig.js FAILURE_MESSAGE_KEYS).
 */
export class IntakeCallError extends Error {
  constructor(kind, { status, failureKind } = {}) {
    super(`Intake call failed: ${kind}${status ? ` (${status})` : ""}`);
    this.name = "IntakeCallError";
    this.kind = kind;
    this.status = status;
    this.failureKind = failureKind || "providerUnavailable";
  }
}

/**
 * One non-streaming chat completion that must come back as a JSON object
 * (the caller parses/validates it — see orderIntake.js). Resolves with
 * `{ content, model, finishReason }`; throws IntakeCallError otherwise.
 *
 * `diag` is `{ requestId, uid, waitUntil, context }` — only used for the
 * Operations event / log lines, never for the request itself.
 */
export async function callIntakeJson(
  env,
  { messages, temperature = 0.3, maxCompletionTokens = 1500, timeoutMs = 20000 },
  diag = {}
) {
  const ctx = diag.context || "intake";
  const key = (env.NERIBO_INTAKE_KEY || "").trim();
  const url = (env.NERIBO_INTAKE_URL || "").trim();
  if (!key || !url) {
    const missing = [!key && "NERIBO_INTAKE_KEY", !url && "NERIBO_INTAKE_URL"].filter(Boolean).join(", ");
    console.error(`[Neribo:${ctx}] ${missing} is not configured.`);
    reportOperationsEvent(
      env,
      {
        category: "ai",
        context: `${ctx}-intake-config`,
        message: "Neribo couldn't complete that response. Please try again.",
        severity: "high",
        requestId: diag.requestId,
        uid: diag.uid,
        technical: {
          provider: "NERIBO_INTAKE",
          reason: `${missing} environment variable is not configured`,
        },
      },
      diag.waitUntil
    );
    throw new IntakeCallError("config", { failureKind: "generic" });
  }

  const model = (env.NERIBO_INTAKE_MODEL || DEFAULT_INTAKE_MODEL).trim();
  const body = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxCompletionTokens,
    stream: false,
    response_format: { type: "json_object" },
    // Low effort keeps a one-question-at-a-time chat snappy. Not every
    // model accepts it — if the upstream rejects it, the retry loop below
    // drops it and tries again.
    reasoning_effort: "low",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    let res;
    // At most two extra attempts, ONLY to drop an optional request parameter
    // that this account/model rejects (a 400 that names it). Anything else
    // falls straight through to the normal failure handling below.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = controller.signal.aborted;
        console.error(`[Neribo:${ctx}] Could not reach the intake upstream${timedOut ? " (timed out)" : ""}:`, err);
        reportOperationsEvent(
          env,
          {
            category: "ai",
            context: `${ctx}-intake-${timedOut ? "timeout" : "network"}`,
            message: "Neribo couldn't complete that response. Please try again.",
            severity: "medium",
            requestId: diag.requestId,
            uid: diag.uid,
            technical: {
              provider: "NERIBO_INTAKE",
              model,
              errorName: err && err.name,
              errorMessage: err && err.message,
            },
          },
          diag.waitUntil
        );
        throw new IntakeCallError(timedOut ? "timeout" : "network", {
          failureKind: "providerUnavailable",
        });
      }

      if (res.ok) break;

      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // nothing more to log
      }
      console.error(`[Neribo:${ctx}] Intake upstream returned ${res.status}:`, detail);

      if (res.status === 400 && attempt < 2) {
        if (body.reasoning_effort && detail.includes("reasoning_effort")) {
          delete body.reasoning_effort;
          continue;
        }
        if (body.response_format && detail.includes("response_format")) {
          delete body.response_format;
          continue;
        }
      }

      reportOperationsEvent(
        env,
        {
          category: "ai",
          context: `${ctx}-intake-upstream`,
          message: "Neribo couldn't complete that response. Please try again.",
          status: res.status,
          severity: "medium",
          requestId: diag.requestId,
          uid: diag.uid,
          technical: {
            provider: "NERIBO_INTAKE",
            model,
            httpStatus: res.status,
            providerResponseBody: detail,
            providerRequestId: res.headers.get("x-request-id") || undefined,
          },
        },
        diag.waitUntil
      );
      throw new IntakeCallError("upstream", {
        status: res.status,
        failureKind: failureKindForStatus(res.status),
      });
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      const timedOut = controller.signal.aborted;
      console.error(`[Neribo:${ctx}] Intake response body was unreadable:`, err);
      throw new IntakeCallError(timedOut ? "timeout" : "malformed", {
        failureKind: "providerUnavailable",
      });
    }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : null;
    if (typeof content !== "string" || !content.trim()) {
      console.error(`[Neribo:${ctx}] Intake upstream returned no message content.`);
      throw new IntakeCallError("malformed", { failureKind: "providerUnavailable" });
    }
    return { content, model, finishReason: (choice && choice.finish_reason) || null };
  } finally {
    clearTimeout(timer);
  }
}
