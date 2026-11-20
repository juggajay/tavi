// Pairing another computer with the assistant (Stage 11.3), run on THIS PC:
//
//   npm run helper:pair -- <name> [--out <folder>] [--gateway <address>] [--again]
//       Makes a secret for that computer (only its hash is kept here) and a folder to copy to it: the helper, its
//       double-click files and helper.json. The secret is never shown.
//   npm run helper:unpair -- <name>
//       Forgets it. If it's connected, the gateway drops its line within a few seconds.
//
// It uses the data folder the assistant uses (LH_DATA_DIR in dev). On the live PC the address is this PC's Tailscale
// https name (read with `tailscale status`, which changes nothing), the same one the phone uses.
import { pairHelper, unpairHelper } from "./pairing.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
};
const again = rest.includes("--again");
if (again) rest.splice(rest.indexOf("--again"), 1);
const out = flag("out");
const gateway = flag("gateway");
const name = rest[0];

try {
  if (!name || (cmd !== "pair" && cmd !== "unpair")) {
    console.log("Use: npm run helper:pair -- <name> [--out <folder>] [--gateway <address>] [--again]\n     npm run helper:unpair -- <name>");
    process.exit(1);
  }
  if (cmd === "pair") {
    const r = await pairHelper({ name, out, gateway, again });
    console.log(`Paired "${r.name}".`);
    console.log(`Its helper is ready in: ${r.folder}`);
    console.log(`  (${r.files.join(", ")})`);
    console.log(`It will call in at: ${r.gateway}`);
    console.log("Copy that whole folder to the other computer, then follow docs/v2/SECOND-PC.md.");
    console.log("helper.json holds its secret: keep it private, and don't put it anywhere else.");
  } else {
    console.log(unpairHelper(name) ? `Unpaired "${name.toLowerCase()}". If it's connected, its line is dropped within a few seconds.` : `"${name}" isn't paired.`);
  }
  process.exit(0);
} catch (e) {
  console.log(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
