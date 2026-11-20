import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GuardError } from "./runner.js";

// Windows protects this file for the same Windows owner who runs the guard.
// The guard never opens the HQ database or the live assistant's data folder.
export class ScreenSecrets {
  private readonly file: string;
  constructor(dir: string, private wrapping?: (mode: "Protect" | "Unprotect", bytes: Buffer) => Buffer) { this.file = path.join(dir, "screen-secrets.dpapi"); }
  private protect(mode: "Protect" | "Unprotect", bytes: Buffer): Buffer {
    if (this.wrapping) return this.wrapping(mode, bytes);
    try {
      const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
        `$o=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
        "[Console]::Write([Convert]::ToBase64String($o))";
      const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        input: bytes.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error();
      return Buffer.from(text, "base64");
    } catch { throw new GuardError(503, "Windows could not open or save the screen's private access key."); }
  }
  private values(): Record<string, string> {
    let bytes: Buffer;
    try { bytes = readFileSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new GuardError(503, "The screen's private access keys could not be read."); }
    try {
      const value = JSON.parse(this.protect("Unprotect", bytes).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([k, v]) =>
        !/^bot:[a-z0-9][a-z0-9-]{0,24}:vnc$/.test(k) || typeof v !== "string" || !/^[A-Za-z0-9+/]{8}$/.test(v))) throw new Error();
      return value;
    } catch { throw new GuardError(503, "The screen's private access keys could not be read."); }
  }
  get(name: string): string | undefined { return this.values()[name]; }
  put(name: string, value: string) {
    if (!/^bot:[a-z0-9][a-z0-9-]{0,24}:vnc$/.test(name) || !/^[A-Za-z0-9+/]{8}$/.test(value)) throw new GuardError(400, "The screen's access key is not valid.");
    const values = this.values(); values[name] = value;
    const encrypted = this.protect("Protect", Buffer.from(JSON.stringify(values)));
    writeFileSync(this.file + ".new", encrypted, { mode: 0o600 }); renameSync(this.file + ".new", this.file);
  }
}
