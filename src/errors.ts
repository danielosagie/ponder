/**
 * Typed error envelope shared across the MCP server, HTTP bridge, and
 * CLI. Stripe-style: every failure surfaces a code, a one-line human
 * message, a concrete hint (action the caller can take), and a docs
 * URL that pins the explanation in the user's hand.
 *
 * Usage pattern:
 *
 *   throw new PonderError("BROWSER_NOT_ATTACHED", {
 *     message: "Chrome tab not attached.",
 *     hint: "Run `ponder_browser_ensure` to attach a tab automatically.",
 *   });
 *
 * Catch sites then know they can render the same envelope regardless
 * of where the failure originated:
 *
 *   try { ... } catch (e) {
 *     const env = PonderError.envelope(e);
 *     return fail(env.message + "\n\nHint: " + env.hint);
 *   }
 *
 * Non-Ponder errors get a generic envelope so consumers still see a
 * consistent shape.
 */

const DOCS_BASE_URL =
  process.env.PONDER_DOCS_BASE_URL ?? "https://ponder.dev/docs";

/** Stable error codes consumers (anorha, etc.) can switch on. */
export type PonderErrorCode =
  | "BROWSER_NOT_ATTACHED"
  | "BROWSER_TAB_MISMATCH"
  | "BROWSER_EXTENSION_MISSING"
  | "CHROME_NOT_RUNNING"
  | "REF_NOT_FOUND"
  | "GROUNDING_FAILED"
  | "RECIPE_NOT_FOUND"
  | "RECIPE_SAVE_FAILED"
  | "RECIPE_EMPTY"
  | "PROVIDER_NOT_CONFIGURED"
  | "PERMISSION_DENIED"
  | "BRIDGE_UNREACHABLE"
  | "INVALID_KEY"
  | "MISSING_AUTH"
  | "FORBIDDEN_SCOPE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface PonderErrorOptions {
  /** Short human-readable message. ≤ 1 sentence. */
  message: string;
  /** Concrete next action — a fix, not a description. */
  hint?: string;
  /** Override docs URL. Defaults to ${DOCS_BASE_URL}/errors/<code-lower>. */
  docsUrl?: string;
  /** Cause to retain for stack-trace inspection. */
  cause?: unknown;
}

export interface PonderErrorEnvelope {
  code: PonderErrorCode | "UNKNOWN";
  message: string;
  hint: string;
  docs_url: string;
}

export class PonderError extends Error {
  readonly code: PonderErrorCode;
  readonly hint: string;
  readonly docsUrl: string;

  constructor(code: PonderErrorCode, opts: PonderErrorOptions) {
    super(opts.message);
    this.name = "PonderError";
    this.code = code;
    this.hint = opts.hint ?? "";
    this.docsUrl =
      opts.docsUrl ?? `${DOCS_BASE_URL}/errors/${code.toLowerCase()}`;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
    Object.setPrototypeOf(this, PonderError.prototype);
  }

  /** Render the envelope shape for HTTP / MCP replies. */
  toEnvelope(): PonderErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      docs_url: this.docsUrl,
    };
  }

  /** Coerce any value into a PonderErrorEnvelope. Non-PonderErrors
   *  become INTERNAL_ERROR / UNKNOWN; their message stays intact. */
  static envelope(err: unknown): PonderErrorEnvelope {
    if (err instanceof PonderError) return err.toEnvelope();
    if (err instanceof Error) {
      return {
        code: "INTERNAL_ERROR",
        message: err.message,
        hint:
          "Unexpected internal error — file a bug at https://github.com/anthropics/ponder/issues with the message above.",
        docs_url: `${DOCS_BASE_URL}/errors/internal_error`,
      };
    }
    return {
      code: "UNKNOWN",
      message: String(err),
      hint: "",
      docs_url: `${DOCS_BASE_URL}/errors/unknown`,
    };
  }

  /** Format the envelope as a multi-line string for CLI / MCP tool
   *  replies. The Stripe-style "code | message | hint | docs" layout
   *  reads cleanly in a terminal and in chat. */
  static format(env: PonderErrorEnvelope): string {
    const lines: string[] = [`[${env.code}] ${env.message}`];
    if (env.hint) lines.push(`Hint: ${env.hint}`);
    if (env.docs_url) lines.push(`Docs: ${env.docs_url}`);
    return lines.join("\n");
  }
}

/** Convenience: throw if a condition holds. */
export function ponderAssert(
  cond: unknown,
  code: PonderErrorCode,
  opts: PonderErrorOptions,
): asserts cond {
  if (!cond) throw new PonderError(code, opts);
}
