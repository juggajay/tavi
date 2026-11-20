// A key for an iPhone Shortcut (Stage 14.3), made on THIS PC:
//
//   npm run shortcut:pair -- <name>      Makes a key for that phone (a new one replaces its old one) and shows it ONCE.
//                                        Type it into the Shortcut (docs/v2/SIRI.md). Only its hash is kept here.
//   npm run shortcut:unpair -- <name>    Takes it away: that Shortcut stops working at once.
//   npm run shortcut:pair -- --list      The phones that have one.
//
// It uses the data folder the assistant uses (LH_DATA_DIR in dev). The same can be done in Settings on the PC.
import { listShortcuts, pairShortcut, unpairShortcut } from "./shortcut.js";

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (rest.includes("--list")) {
    const all = listShortcuts();
    console.log(all.length ? all.map((s) => `${s.name}: made ${s.made_at.slice(0, 10)}${s.last_used ? `, last used ${s.last_used.slice(0, 16).replace("T", " ")}` : ", not used yet"}`).join("\n") : "No Shortcut keys yet.");
    process.exit(0);
  }
  const name = rest[0];
  if (!name || (cmd !== "pair" && cmd !== "unpair")) {
    console.log("Use: npm run shortcut:pair -- <name>\n     npm run shortcut:unpair -- <name>\n     npm run shortcut:pair -- --list");
    process.exit(1);
  }
  if (cmd === "pair") {
    const r = pairShortcut(name);
    console.log(`Key for "${r.name}" (shown once, so put it in the Shortcut now):\n\n    ${r.key}\n`);
    console.log("Type it into the Shortcut's Key box exactly as above (the dashes don't matter). docs/v2/SIRI.md has every step.");
    console.log("Lost it? Run this again for a new one; the old one stops working.");
  } else {
    console.log(unpairShortcut(name) ? `Took away "${name.toLowerCase()}"'s key. That Shortcut won't work any more.` : `"${name}" has no key.`);
  }
  process.exit(0);
} catch (e) {
  console.log(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
