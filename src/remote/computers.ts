// Computers paired with the assistant (Stage 11): each runs the helper (src/helper/) and connects in with its secret.
// Only a hash of the secret is stored here. The secret itself goes into that computer's helper.json once, when it's
// paired, and is never printed, logged or put in the conversation.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db, nowIso } from "../store/db.js";

export type Computer = { name: string; called: string | null; secret_hash: string; paired_at: string; last_seen: string | null };

/** A computer's name as paired: letters, digits and dashes (its Windows name is fine: desktop-example). */
export const validName = (n: string) => /^[a-z0-9][a-z0-9-]{0,39}$/i.test(n);
export const hashSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

export const getComputer = (name: string) => db.prepare("SELECT * FROM computers WHERE name = ?").get(name.toLowerCase()) as Computer | undefined;
export const listPaired = () => db.prepare("SELECT * FROM computers ORDER BY paired_at").all() as Computer[];

/** Pairs a computer: a new long random secret (only its hash is kept). again: re-pair one already paired. */
export function pairComputer(name: string, o: { again?: boolean } = {}): { name: string; secret: string } {
  const n = name.trim().toLowerCase();
  if (!validName(n)) throw new Error("A computer's name is letters, numbers and dashes, like office-pc.");
  const known = getComputer(n);
  if (known && !o.again) throw new Error(`${n} is already paired. Pair it again (--again) to give it a new secret; the old one stops working.`);
  const secret = randomBytes(32).toString("base64url");
  if (known) db.prepare("UPDATE computers SET secret_hash = ?, paired_at = ?, last_seen = NULL WHERE name = ?").run(hashSecret(secret), nowIso(), n);
  else db.prepare("INSERT INTO computers (name, called, secret_hash, paired_at) VALUES (?, NULL, ?, ?)").run(n, hashSecret(secret), nowIso());
  return { name: n, secret };
}

/** Forgets a computer. Its line, if open, is dropped by the gateway within seconds (hub.ts watches for this). */
export function unpairComputer(name: string) {
  return db.prepare("DELETE FROM computers WHERE name = ?").run(name.trim().toLowerCase()).changes > 0;
}

const DUMMY = hashSecret("no such computer");

/** The computer, if this is its secret. Compared in constant time, and as long for an unknown name as a known one. */
export function checkSecret(name: unknown, secret: unknown): Computer | null {
  const c = typeof name === "string" && validName(name.trim()) ? getComputer(name.trim()) : undefined;
  const given = Buffer.from(hashSecret(typeof secret === "string" ? secret : ""), "hex");
  const want = Buffer.from(c?.secret_hash ?? DUMMY, "hex");
  const same = given.length === want.length && timingSafeEqual(given, want);
  return c && same && typeof secret === "string" && secret.length >= 20 ? c : null;
}

export const touchSeen = (name: string) => db.prepare("UPDATE computers SET last_seen = ? WHERE name = ?").run(nowIso(), name);

/** What the owner calls it ("the office PC"); empty clears it. */
export function setCalled(name: string, called: string) {
  const v = called.trim().replace(/\s+/g, " ").slice(0, 60);
  return db.prepare("UPDATE computers SET called = ? WHERE name = ?").run(v || null, name.toLowerCase()).changes > 0;
}

/** How to speak of it: what he calls it, or "the other computer" when there's only one, or its name. */
export function spokenName(c: Pick<Computer, "name" | "called">) {
  if (c.called) return c.called;
  return listPaired().length <= 1 ? "the other computer" : c.name;
}

/** The plain line for when it's away (11.4): once, no guessing at what's on it. */
export function awayLine(c: Pick<Computer, "name" | "called">) {
  const n = spokenName(c);
  return `${n.charAt(0).toUpperCase()}${n.slice(1)} isn't switched on, or it's off the network.`;
}
