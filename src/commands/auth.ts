/** login / logout / whoami. */
import { api, ApiError } from "../api.js";
import { clearToken, loadConfig, saveToken } from "../config.js";

interface LoginResponse {
  access_token: string;
  refresh_token?: string;
  user?: { email?: string; username?: string };
}

interface Me {
  id: string;
  email?: string;
  username?: string;
  role?: string;
}

/**
 * login. Two paths:
 *   --token <PAT>       store a personal access token (the CLI/CI path)
 *   --email --password  password login → stores the returned access token
 *
 * A browser device flow (RFC 8628) is the intended default once the platform ships
 * PAT issuance; --token accepts whatever bearer the platform issues today.
 */
interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function login(opts: { token?: string; email?: string; password?: string; apiUrl?: string }): Promise<void> {
  if (opts.token) {
    // Verify the token works before persisting.
    await api<Me>("/api/v1/auth/me", { token: opts.token });
    saveToken(opts.token, opts.apiUrl);
    console.log("Logged in (token stored).");
    return;
  }
  if (opts.email && opts.password) {
    const res = await api<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      body: { email: opts.email, password: opts.password },
    });
    saveToken(res.access_token, opts.apiUrl);
    console.log(`Logged in as ${res.user?.email ?? opts.email}.`);
    return;
  }
  // Default: browser device flow (RFC 8628). No password touches the terminal.
  await deviceLogin(opts.apiUrl);
}

async function deviceLogin(apiUrl?: string): Promise<void> {
  const dc = await api<DeviceCode>("/api/v1/auth/device/code", { method: "POST", body: {} });
  console.log(`\nTo authorize this CLI, open:\n  ${dc.verification_uri}\nand enter the code:  ${dc.user_code}\n`);
  console.log(`Waiting for approval (expires in ${Math.round(dc.expires_in / 60)} min)…`);

  const deadline = Date.now() + dc.expires_in * 1000;
  const intervalMs = Math.max(2, dc.interval ?? 3) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await api<{ token: string }>("/api/v1/auth/device/token", {
        method: "POST",
        body: { device_code: dc.device_code },
      });
      saveToken(res.token, apiUrl);
      console.log("Approved — logged in.");
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) continue; // authorization_pending
      throw e;
    }
  }
  throw new ApiError(408, "Device authorization timed out. Run `vecteur login` again.");
}

export function logout(): void {
  clearToken();
  console.log("Logged out (local token cleared).");
}

export async function whoami(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.log("Not logged in. Run `vecteur login`.");
    process.exitCode = 1;
    return;
  }
  const me = await api<Me>("/api/v1/auth/me");
  console.log(`user:    ${me.email ?? me.username ?? me.id}`);
  if (me.role) console.log(`role:    ${me.role}`);
  console.log(`token:   ${cfg.tokenPrefix ?? "(hidden)"}…`);
  console.log(`api:     ${cfg.apiUrl}`);
  // Quota is shown here once the platform exposes a per-credential quota endpoint (M-U3).
}
