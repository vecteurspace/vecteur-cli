import { spawn } from "node:child_process";

/** Only an explicit user action calls this; the visible URL always remains usable. */
export async function openBrowser(url) {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return false;
    const command = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", parsed.href] : [parsed.href];
    return await new Promise(resolve => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      const timer = setTimeout(() => { child.unref(); resolve(true); }, 1_500);
      child.once("error", () => { clearTimeout(timer); resolve(false); });
      child.once("exit", code => { clearTimeout(timer); resolve(code === 0); });
    });
  } catch { return false; }
}
