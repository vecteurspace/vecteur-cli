/**
 * Thin HTTP client for the Vecteur backend. Bearer auth (PAT or JWT — the CLI is
 * auth-method-agnostic so it works with whatever credential the platform issues).
 * Structured errors so commands can print actionable messages and set exit codes.
 */
import { loadConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** A human, actionable line for the terminal. */
  hint(): string {
    switch (this.status) {
      case 401:
        return "Not authenticated. Run `vecteur login` (or set VECTEUR_TOKEN).";
      case 403:
        return "Forbidden — your token lacks the required scope for this action.";
      case 429:
        return `Rate limit / quota exceeded${this.retryAfter ? ` — retry in ${this.retryAfter}s` : ""}.`;
      case 426:
        return "This CLI is out of date. Run `vecteur update`.";
      default:
        return this.message;
    }
  }
}

export interface RequestOpts {
  method?: string;
  body?: unknown;
  token?: string; // override the stored token (e.g. during login verification)
  query?: Record<string, string | number | undefined>;
}

export function apiBase(): string {
  return loadConfig().apiUrl.replace(/\/+$/, "");
}

export async function api<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const cfg = loadConfig();
  const token = opts.token ?? cfg.token;
  const url = new URL(apiBase() + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `Network error reaching ${apiBase()} — is the API URL correct and are you online? (${(e as Error).message})`);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    const detail =
      (parsed && typeof parsed === "object" && "detail" in parsed
        ? String((parsed as Record<string, unknown>).detail)
        : undefined) ?? res.statusText;
    throw new ApiError(res.status, detail, parsed, retryAfter);
  }

  return parsed as T;
}
