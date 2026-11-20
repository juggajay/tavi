import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GuardError } from "./runner.js";

export function scrub(text: string): string {
  return text.replace(/(?:[A-Z0-9_]*(?:KEY|TOKEN)=|Bearer\s+|sk-)[^\r\n]*/gi, "[hidden]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[hidden]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function same(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function pinHash(pin: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => derive(pin, salt, 64, (error, hash) => error ? reject(error) : resolve(hash)));
}
export class Store {
  readonly dir: string;
  readonly local: string;
  readonly relay: string;
  private hidden = new Set<string>();
  pin?: { salt: string; hash: string };
  pinBroken = false;
  failures = 0;
  lockedUntil = 0;
  constructor(data = process.env.LH_V3_DATA ?? fileURLToPath(new URL("../../data-v3", import.meta.url))) {
    this.dir = path.join(data, "guard");
    mkdirSync(path.join(this.dir, "logs"), { recursive: true, mode: 0o700 });
    const secret = (name: string) => {
      const file = path.join(this.dir, name);
      if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
      const value = readFileSync(file, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("A guard secret is damaged. Restore it before starting the guard.");
      this.hide(value);
      return value;
    };
    this.local = secret("secret-local"); this.relay = secret("secret-relay");
    try {
      const value = this.read("pin.json") as { salt: string; hash: string; failures?: number; lockedUntil?: number };
      if (value !== undefined) {
        if (!value || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.hash) ||
          (value.failures !== undefined && (!Number.isInteger(value.failures) || value.failures < 0 || value.failures > 5)) ||
          (value.lockedUntil !== undefined && (!Number.isFinite(value.lockedUntil) || value.lockedUntil < 0))) throw new Error();
        this.pin = { salt: value.salt, hash: value.hash };
        this.failures = Number.isInteger(value.failures) ? Math.max(0, value.failures!) : 0;
        this.lockedUntil = typeof value.lockedUntil === "number" ? value.lockedUntil : 0;
      }
    } catch { this.pinBroken = true; }
  }
  hide(text: string) {
    if (!text) return;
    this.hidden.add(text);
    for (const line of text.split(/\r?\n/)) if (line.length >= 4) this.hidden.add(line);
  }
  clean(text: string) {
    let result = text;
    for (const value of this.hidden) result = result.split(value).join("[hidden]");
    return scrub(result);
  }
  read(name: string): unknown {
    const file = path.join(this.dir, name);
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  save(name: string, value: unknown) {
    const file = path.join(this.dir, name);
    writeFileSync(file + ".new", JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(file + ".new", file);
  }
  audit(event: string, by: string, detail: string) {
    appendFileSync(path.join(this.dir, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event, by: this.clean(by), detail: this.clean(detail) }) + "\n", { mode: 0o600 });
  }
  tail(name: string, lines: number) {
    const file = path.join(this.dir, name);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).map((line) => this.clean(line));
  }
  private savePin() { this.save("pin.json", { ...this.pin, failures: this.failures, lockedUntil: this.lockedUntil }); }
  async checkPin(input: unknown, now: number) {
    if (typeof input === "string") this.hide(input);
    if (this.pinBroken) throw new GuardError(403, "The saved PIN cannot be read. Restore its file before lowering the safety level.");
    if (!this.pin) return;
    if (now < this.lockedUntil) throw new GuardError(429, "PIN entry is locked for ten minutes. Raising the safety level still works.");
    if (this.lockedUntil) { this.lockedUntil = 0; this.failures = 0; }
    const value = typeof input === "string" && /^\d{4,12}$/.test(input) ? input : "";
    const hash = await pinHash(value, this.pin.salt);
    if (!timingSafeEqual(hash, Buffer.from(this.pin.hash, "hex"))) {
      this.failures++;
      if (this.failures >= 5) this.lockedUntil = now + 600_000;
      this.savePin(); this.audit("pin-failure", "owner", "The PIN was refused.");
      throw new GuardError(this.lockedUntil ? 429 : 403, "The PIN was refused.");
    }
    this.failures = 0; this.savePin();
  }
  async setPin(pin: unknown, old: unknown, now: number) {
    if (typeof pin === "string") this.hide(pin);
    if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) throw new GuardError(400, "Use four to twelve digits for the PIN.");
    await this.checkPin(old, now);
    const salt = randomBytes(16).toString("hex");
    this.pin = { salt, hash: (await pinHash(pin, salt)).toString("hex") };
    this.failures = 0; this.lockedUntil = 0; this.savePin();
    this.audit("pin-set", "local", "The owner set a PIN.");
  }
}
