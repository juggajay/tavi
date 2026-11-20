import { TEST_DIR } from "../isolate.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ScreenSecrets } from "../../src/guard/screenSecrets.js";

const folder = path.join(TEST_DIR, "screen-secrets"); mkdirSync(folder);
// A real Windows owner account is unavailable in the sandbox. Replace only that outer wrapping.
const key = randomBytes(32);
function wrap(mode: "Protect" | "Unprotect", bytes: Buffer): Buffer {
  if (mode === "Protect") {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
const store = new ScreenSecrets(folder, wrap);
assert.equal(store.get("bot:a:vnc"), undefined);
store.put("bot:a:vnc", "a1b2c3d4"); store.put("bot:b:vnc", "d4c3b2a1");
const reopened = new ScreenSecrets(folder, wrap);
assert.equal(reopened.get("bot:a:vnc"), "a1b2c3d4"); assert.equal(reopened.get("bot:b:vnc"), "d4c3b2a1");
const encrypted = readFileSync(path.join(folder, "screen-secrets.dpapi"));
assert(!encrypted.includes(Buffer.from("a1b2c3d4"))); assert(!encrypted.includes(Buffer.from("bot:a:vnc")));
assert.throws(() => store.put("../elsewhere", "a1b2c3d4")); assert.throws(() => store.put("bot:a:vnc", "short"));
writeFileSync(path.join(folder, "screen-secrets.dpapi"), "damaged");
assert.throws(() => reopened.get("bot:a:vnc")); assert.throws(() => reopened.put("bot:c:vnc", "a1b2c3d4"));
assert.equal(readFileSync(path.join(folder, "screen-secrets.dpapi"), "utf8"), "damaged");
console.log("private screen access keys: ok");
