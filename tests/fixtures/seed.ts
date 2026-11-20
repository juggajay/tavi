// Builds a made-up data folder for dev and tests: a fresh database, a profile for "Nemi", a few memories, commitments,
// routines, three days of conversation, a pending email approval, two waiting notifications, and the "Sample House"
// drawing set, indexed from its text (no model calls). Every value is invented.
//
//   tsx tests/fixtures/seed.ts <dir>      build a folder from the command line (it must not exist or be empty)
//   await seed(dir)                       from a test, after isolate.ts has pointed LH_DATA_DIR at <dir>
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cast } from "./cast.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const CONVERSATION: [number, number, number, "user" | "assistant", "voice" | "typed", string][] = [
  [2, 7, 5, "user", "voice", "Morning. What's on today?"],
  [2, 7, 5, "assistant", "voice", `Morning ${cast.owner.short}. The household inspection is at ten, and ${cast.friend.short} wants the window sizes by lunch.`],
  [2, 9, 40, "user", "voice", "Remind me to order the 90 by 45 for Friday."],
  [2, 9, 40, "assistant", "voice", "Will do. I'll remind you at three this afternoon."],
  [1, 6, 50, "user", "typed", "How wide is door D07 on the Sample House plans?"],
  [1, 6, 50, "assistant", "typed", "D07 is a 720 wide hollow door, type SD3, with a privacy set. It's on the ground floor plan, A-101."],
  [1, 12, 15, "user", "voice", `Did ${cast.friend.short} ever send the window sizes?`],
  [1, 12, 15, "assistant", "voice", "Not yet. Want me to chase them?"],
  [0, 7, 0, "user", "voice", "What's the weather doing tomorrow?"],
  [0, 7, 0, "assistant", "voice", "Fine and 24, with a southerly in the late afternoon."],
];

export async function seed(dir: string) {
  const target = path.resolve(dir);
  const { DATA_DIR, db } = await import("../../src/store/db.js");
  if (path.resolve(DATA_DIR) !== target) throw new Error(`seed(${target}) needs LH_DATA_DIR set to that folder first (it is ${DATA_DIR})`);
  process.env.LH_NO_VISION = "1";

  const { setAssistantName, editUser } = await import("../../src/profile/profile.js");
  const { remember, addCommitment, createRoutine, ensureBuiltinRoutines } = await import("../../src/store/proactive.js");
  const { saveDraft, requestEmailApproval } = await import("../../src/broker/broker.js");
  const { queueNotification } = await import("../../src/proactive/notify.js");

  // Profile
  setAssistantName(cast.assistant, "fixture");
  const you = { trust: "user" as const, source: "fixture" };
  editUser({ op: "add", section: "Basics", text: `Name: ${cast.owner.name}. Helps at a club and plans household projects.` }, you);
  editUser({ op: "add", section: "Work", text: "Current jobs: Sample House (new build) and the Lee renovation." }, you);
  editUser({ op: "add", section: "People", text: `${cast.friend.name}: window supplier, ${cast.friend.email}.` }, you);
  editUser({ op: "add", section: "How to talk to them", text: "Short and plain. No small talk before seven." }, you);
  // Nemi has had the getting-to-know-you sit-down already, so the fake brain doesn't offer it in every test (sitdown.test.mjs resets it).
  db.prepare("INSERT INTO settings (key, value) VALUES ('sitdown', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ status: "done", covered: ["what to call them", "work", "people"], started_at: null, ended_at: null, offered_at: null, offers: 1 }),
  );

  // Memories
  remember({ kind: "user", subject: cast.owner.short, fact: "Starts on site at 6:30 most days.", source: "fixture" });
  remember({ kind: "person", subject: cast.friend.name, fact: "Window supplier. Prefers email to phone calls.", source: "fixture" });
  remember({ kind: "project", subject: "Sample House", fact: "Two-storey new build. Frame stage. Inspector is booked through the council.", source: "fixture" });
  remember({ kind: "preference", subject: "Timber", fact: "Uses the saved shop unless it is out of stock.", source: "fixture" });
  remember({ kind: "project", subject: "Lee renovation", fact: "Kitchen and laundry. Cabinets arrive in two weeks.", source: "fixture" });

  // Commitments and routines
  addCommitment({ title: "Order 90x45 MGP10 for Friday", owner: "user", kind: "remind", due_at: new Date(Date.now() + 6 * 3600_000).toISOString(), source: "fixture" });
  addCommitment({ title: "Window sizes for Sample House", owner: cast.friend.name, counterpart: cast.friend.name, due_at: new Date(Date.now() + DAY).toISOString(), source: "fixture" });
  ensureBuiltinRoutines();
  createRoutine({ title: "Friday timber check", instructions: "Check what timber is still to order for next week.", schedule: { kind: "weekly", days: [5], time: "07:30" } });

  // Conversation, back-dated
  const insert = db.prepare("INSERT INTO conversation_log (ts, role, channel, text) VALUES (?, ?, ?, ?)");
  for (const [d, h, m, role, channel, text] of CONVERSATION) insert.run(ago(d, h, m), role, channel, text);

  // A pending email approval. Approvals normally expire in 15 minutes; a fixture one stays up for a week.
  const draft = saveDraft({ account: "Work email", to: [cast.friend.email], subject: "Window sizes for Sample House", body: `Hi ${cast.friend.short},\n\nCould you send the window sizes for Sample House by Thursday? The frame is going up next week.\n\nThanks,\n${cast.owner.short}` });
  const approval = requestEmailApproval(draft);
  db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() + 7 * DAY).toISOString(), approval.id);

  // Waiting notifications
  queueNotification({ title: "Framing inspection", spoken: "Your framing inspection at the Lee job is at ten.", priority: "low", source: "fixture" });
  queueNotification({ title: `${cast.friend.short} replied`, spoken: `${cast.friend.short} replied about the windows. Want me to read it?`, priority: "low", source: "fixture" });

  // Drawings: generate the sample set into the drawings folder, then index it the normal way.
  const drawings = path.join(DATA_DIR, "drawings");
  execFileSync(PY, ["-I", path.join(ROOT, "tests", "fixtures", "make_drawings.py"), drawings], { windowsHide: true });
  renameSync(path.join(drawings, "drawings.expected.json"), path.join(DATA_DIR, "drawings.expected.json"));
  const { scanForNew, processQueue } = await import("../../src/drawings/library.js");
  await scanForNew();
  await processQueue();
  const failed = db.prepare("SELECT name, error FROM drawing_files WHERE status != 'ready'").all();
  if (failed.length) throw new Error(`fixture drawings did not index: ${JSON.stringify(failed)}`);

  // Other files for the same jobs (Word, Excel, text, a photo, an email, and two it can't read), in the folder it manages.
  execFileSync(PY, ["-I", path.join(ROOT, "tests", "fixtures", "make_files.py"), drawings], { windowsHide: true });
  const { ensureManagedFolder, scanFolder } = await import("../../src/files/library.js");
  await scanFolder(ensureManagedFolder());

  // A made-up reference shelf (Stage 8): one small book with a table of contents, invented throughout, inside the data
  // folder. Never the owner's books.
  const shelf = path.join(DATA_DIR, "reference-shelf");
  execFileSync(PY, ["-I", path.join(ROOT, "tests", "fixtures", "make_reference.py"), shelf], { windowsHide: true });
  const { referenceDir } = await import("../../src/reference/dir.js");
  if (path.resolve(referenceDir()) === path.resolve(shelf)) {
    const { scanShelf, whenIdle } = await import("../../src/reference/library.js");
    await scanShelf();
    await whenIdle();
  }
  return { approvalId: approval.id };
}

// Command line: tsx tests/fixtures/seed.ts <dir>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: tsx tests/fixtures/seed.ts <dir>");
    process.exit(2);
  }
  const target = path.resolve(dir);
  if (existsSync(target) && readdirSync(target).length) {
    console.error(`${target} is not empty; refusing to seed over it.`);
    process.exit(2);
  }
  process.env.LH_DATA_DIR = target;
  process.env.LH_DEV = "1";
  process.env.LH_BRAIN_CWD ??= path.join(target, ".brain");
  process.env.LH_BROWSER_DIR ??= path.join(target, ".browser");
  await seed(target);
  console.log(`seeded ${target}`);
  process.exit(0);
}
