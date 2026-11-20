// Encrypted secret storage. A random master key is protected with Windows DPAPI (only this Windows
// user can unwrap it); secrets are AES-256-GCM encrypted with it and kept in SQLite. Nothing the
// brain can read: there is no tool that exposes these.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, db, nowIso } from "./db.js";

const KEY_FILE = path.join(DATA_DIR, "secrets", "master.key.dpapi");

function dpapi(mode: "protect" | "unprotect", b64: string): string {
  const fn = mode === "protect" ? "Protect" : "Unprotect";
  const script =
    "Add-Type -AssemblyName System.Security; " +
    `$b=[Convert]::FromBase64String('${b64}'); ` +
    `$o=[Security.Cryptography.ProtectedData]::${fn}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    "[Convert]::ToBase64String($o)";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
}

let masterKey: Buffer | undefined;
function key(): Buffer {
  if (masterKey) return masterKey;
  if (existsSync(KEY_FILE)) {
    masterKey = Buffer.from(dpapi("unprotect", readFileSync(KEY_FILE, "utf8").trim()), "base64");
  } else {
    mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    masterKey = randomBytes(32);
    writeFileSync(KEY_FILE, dpapi("protect", masterKey.toString("base64")), { encoding: "utf8" });
  }
  return masterKey;
}

export function putSecret(name: string, value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  db.prepare(
    "INSERT INTO secrets (name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at",
  ).run(name, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64"), nowIso());
}

export function getSecret<T>(name: string): T | undefined {
  const row = db.prepare("SELECT iv, tag, data FROM secrets WHERE name = ?").get(name) as { iv: string; tag: string; data: string } | undefined;
  if (!row) return undefined;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(row.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(text) as T;
}

export function deleteSecret(name: string) {
  db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
}
