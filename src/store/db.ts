// Local system of record: one SQLite file under data/. Node's built-in driver, no native deps.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devCheckDataDir } from "../dev.js";

// LH_DATA_DIR lets tests run on a private copy (data/isolate.ts), never the data the live gateway is using.
export const DATA_DIR = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
devCheckDataDir(DATA_DIR, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "harness.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

// Append-only schema versions. Earlier explanatory comments were generalised; their SQL operations are unchanged. Add a migration for any schema change.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,          -- user | voice | brain | broker | system
    event TEXT NOT NULL,
    ref TEXT,                     -- job / approval / action id
    detail TEXT                   -- JSON
  );
  CREATE INDEX audit_ts ON audit_log(ts);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT,
    request TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','interrupted','cancelled')),
    result TEXT,
    error TEXT,
    lease_until TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status);

  CREATE TABLE conversation_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,           -- user | assistant | system
    channel TEXT NOT NULL,        -- voice | typed | system
    text TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE conversation_fts USING fts5(text, content='conversation_log', content_rowid='id');
  CREATE TRIGGER conversation_ai AFTER INSERT ON conversation_log BEGIN
    INSERT INTO conversation_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    job_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    operation TEXT NOT NULL,
    draft_id TEXT REFERENCES drafts(id),
    account TEXT NOT NULL,
    grant_json TEXT NOT NULL,     -- exactly what the user is approving
    grant_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','rejected','expired','used')),
    expires_at TEXT NOT NULL,
    job_id TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL REFERENCES approvals(id),
    operation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','executing','accepted','verified','failed','unknown')),
    provider_ref TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Demo mail provider for the backbone build. Real connectors replace this in step 3.
  CREATE TABLE demo_outbox (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL,
    account TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    bcc_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );
  `,
  `
  -- Connected accounts (Gmail first). Tokens live in secrets, encrypted.
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,       -- google | microsoft | imap
    label TEXT NOT NULL,          -- what the user calls it: Gmail, Work, Hotmail
    address TEXT NOT NULL,
    scopes TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('connected','needs_reconnect','disconnected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX accounts_provider_address ON accounts(provider, address);

  -- Encrypted blobs (AES-256-GCM; key protected by Windows DPAPI for this user).
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- Things someone has promised to do. The assistant checks on them at next_check_at.
  CREATE TABLE commitments (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    detail TEXT,
    owner TEXT NOT NULL,          -- assistant | user | a person's name
    counterpart TEXT,             -- who it involves, e.g. Ruvo Pell
    due_at TEXT,
    next_check_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','done','dropped')),
    source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE INDEX commitments_check ON commitments(status, next_check_at);

  -- Curated facts about the user, their people and their jobs. Never silently overwritten: superseded instead.
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user','person','project','preference')),
    subject TEXT NOT NULL,
    fact TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','superseded','forgotten')),
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Scheduled routines: built-in (morning brief, wrap-up) and ones the user asks for.
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('push','brief')),
    status TEXT NOT NULL CHECK (status IN ('active','paused','deleted')),
    builtin TEXT,                 -- 'morning_brief' | 'wrap_up' for the built-ins
    next_run_at TEXT,
    last_run_at TEXT,
    last_outcome TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Everything the assistant wants to tell the user, and whether/when it was delivered and seen.
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    spoken TEXT NOT NULL,
    card_json TEXT,
    priority TEXT NOT NULL CHECK (priority IN ('urgent','normal','low')),
    status TEXT NOT NULL CHECK (status IN ('queued','delivered','seen','dismissed')),
    source TEXT,
    deliver_after TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    seen_at TEXT
  );
  CREATE INDEX notifications_status ON notifications(status, deliver_after);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Drawing library. Originals are never modified; everything here can be rebuilt from them.
  CREATE TABLE drawing_files (
    hash TEXT PRIMARY KEY,          -- sha256 of the PDF
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    project TEXT NOT NULL,
    page_count INTEGER,
    status TEXT NOT NULL CHECK (status IN ('queued','indexing','ready','failed')),
    error TEXT,
    added_at TEXT NOT NULL,
    indexed_at TEXT
  );

  CREATE TABLE sheets (
    id TEXT PRIMARY KEY,
    file_hash TEXT NOT NULL REFERENCES drawing_files(hash),
    page INTEGER NOT NULL,
    project TEXT NOT NULL,
    sheet_no TEXT,
    title TEXT,
    revision TEXT,
    discipline TEXT,
    read_path TEXT,                 -- text | outlined | scanned | empty
    source TEXT,                    -- where the sheet no / title / revision came from
    confidence TEXT,                -- high | medium | low
    status TEXT NOT NULL CHECK (status IN ('current','superseded','needs_review')),
    superseded_by TEXT,
    title_block_box TEXT,
    width_pt REAL,
    height_pt REAL,
    data_dir TEXT NOT NULL,         -- where this page's word boxes live
    created_at TEXT NOT NULL,
    UNIQUE (file_hash, page)
  );
  CREATE INDEX sheets_lookup ON sheets(project, sheet_no);
  CREATE VIRTUAL TABLE sheet_fts USING fts5(sheet_id UNINDEXED, sheet_no, title, body, tokenize = 'unicode61 tokenchars ''-.''');

  CREATE TABLE drawing_crops (
    id TEXT PRIMARY KEY,
    sheet_id TEXT NOT NULL,
    box TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Every change to SOUL.md / USER.md, and memory writes held for the user's OK because the turn
  -- that made them had read email, documents, drawings or the web (where planted text can hide).
  CREATE TABLE profile_changes (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL CHECK (target IN ('SOUL.md','USER.md','memory')),
    op TEXT NOT NULL,              -- add | patch | remove | replace | remember
    section TEXT,
    old TEXT,
    new TEXT,
    source TEXT,                   -- said | onboarding | you (PC) | read: email ...
    trust TEXT NOT NULL CHECK (trust IN ('user','external')),
    status TEXT NOT NULL CHECK (status IN ('applied','held','rejected')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX profile_changes_status ON profile_changes(status, created_at);
  `,
  `
  -- The follow-up loop ("did you get it sorted?"). A commitment can be asked about before it's due,
  -- once if it goes overdue, and "how did it go?" after the event. Plain code decides when; the brain
  -- writes the questions at capture time.
  ALTER TABLE commitments ADD COLUMN kind TEXT;              -- remind | book | order | chase | call | inspect | meeting | decide | goal | other
  ALTER TABLE commitments ADD COLUMN site TEXT;
  ALTER TABLE commitments ADD COLUMN event_at TEXT;          -- the pour / inspection / meeting it serves
  ALTER TABLE commitments ADD COLUMN ask_before TEXT;        -- e.g. "Room for Thursday's club meeting. Booked yet?"
  ALTER TABLE commitments ADD COLUMN ask_after TEXT;         -- e.g. "Frame inspection was this morning. Did it pass?"
  ALTER TABLE commitments ADD COLUMN must_confirm INTEGER NOT NULL DEFAULT 0;  -- ask at every window until done (permits, inspections, safety)
  ALTER TABLE commitments ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;         -- "stop asking": still tracked and listed
  ALTER TABLE commitments ADD COLUMN stage TEXT;             -- next question: before | overdue | after
  ALTER TABLE commitments ADD COLUMN asks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE commitments ADD COLUMN last_asked_at TEXT;
  ALTER TABLE commitments ADD COLUMN last_answer TEXT;       -- done | not_yet | later | stop_asking | blocked | already_done
  ALTER TABLE commitments ADD COLUMN outcome TEXT;

  -- The user's stop controls. The scheduler reads these before every push; the model can't argue past them.
  CREATE TABLE controls (key TEXT PRIMARY KEY, value TEXT NOT NULL, set_at TEXT NOT NULL);

  -- Every proactive question asked, and the answer, for tuning later.
  CREATE TABLE proactive_log (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    trigger TEXT,                  -- before | overdue | after | carry | reminder
    line TEXT,
    notification_id TEXT,
    asked_at TEXT NOT NULL,
    answer TEXT,
    answered_at TEXT
  );

  -- exact: a reminder the user set for a specific time (comes through even when paused).
  -- bundle: a non-urgent follow-up that can share one buzz with others due at the same window.
  ALTER TABLE notifications ADD COLUMN exact INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE notifications ADD COLUMN bundle INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The memory keeper: what it noticed in conversation that should be tracked, but the user hasn't said "track it".
  CREATE TABLE offers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    detail TEXT,
    evidence TEXT,                 -- the user's own words it came from
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  -- Short notes on what happened each day (the keeper's gist of each conversation), for "yesterday in brief" and look-back.
  CREATE TABLE day_notes (id INTEGER PRIMARY KEY, day TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX day_notes_day ON day_notes(day);
  -- Time-bound facts ("the pour's Thursday") stop being used after valid_until.
  ALTER TABLE memories ADD COLUMN valid_until TEXT;
  `,
  `
  -- Every card put on the phone, so the user can find it again. One answer is one card: the drawing it showed
  -- mid-answer plus the summary it finished with. shown_at moves when a card is brought back up.
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT,
    images_json TEXT NOT NULL DEFAULT '[]',
    rows_json TEXT NOT NULL DEFAULT '[]',
    origin TEXT NOT NULL,          -- answer | notice
    created_at TEXT NOT NULL,
    shown_at TEXT NOT NULL
  );
  CREATE INDEX cards_shown ON cards(shown_at);
  `,
  `
  -- v2 items: everything the assistant shows (a drawing sheet, a list, a table, a draft waiting for an OK, a note...).
  -- Items made in the same turn (same job_id, ordered by seq) are pages the owner swipes between.
  CREATE TABLE items (
    id TEXT PRIMARY KEY,              -- itm_ + 16 hex
    kind TEXT NOT NULL,               -- sheet | list | table | draft | note | image | doc | legacy
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    origin TEXT NOT NULL,             -- answer | notice | approval | legacy
    job_id TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    shown_at TEXT NOT NULL,
    pinned_at TEXT                    -- "keep that handy"
  );
  CREATE INDEX items_shown ON items(shown_at DESC);
  CREATE INDEX items_job ON items(job_id, seq);
  ALTER TABLE conversation_log ADD COLUMN job_id TEXT;
  ALTER TABLE jobs ADD COLUMN summary TEXT;    -- JSON: { tools: [{ name, label, ms }], ms, model }
  ALTER TABLE jobs ADD COLUMN progress TEXT;   -- latest progress label
  -- Earlier cards come across as legacy items, so "show me that again" still finds them.
  INSERT INTO items (id, kind, title, source, payload_json, origin, job_id, seq, created_at, shown_at)
    SELECT 'itm_' || substr(id, 5), 'legacy', title, COALESCE(source, ''),
           json_object('images', json(images_json), 'rows', json(rows_json)), 'legacy', NULL, 0, created_at, shown_at
    FROM cards;
  `,
  `
  -- v2 Stage 4: folders the owner lets it read (the drawings folder it manages, and folders it only reads), and every
  -- file in them that isn't a drawing: Word, Excel, text, photos, saved emails. Linked folders are never written to.
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,              -- fld_ + 12 hex
    path TEXT NOT NULL UNIQUE,        -- real, absolute
    label TEXT NOT NULL,
    kind TEXT NOT NULL,               -- managed | linked
    enabled INTEGER NOT NULL DEFAULT 1,
    split_subfolders INTEGER NOT NULL DEFAULT 0,  -- each top-level subfolder is its own job
    added_at TEXT NOT NULL,
    last_scan_at TEXT,
    last_error TEXT
  );
  ALTER TABLE drawing_files ADD COLUMN folder_id TEXT;
  ALTER TABLE drawing_files ADD COLUMN type TEXT NOT NULL DEFAULT 'pdf';
  ALTER TABLE drawing_files ADD COLUMN mtime INTEGER;
  ALTER TABLE drawing_files ADD COLUMN size INTEGER;
  ALTER TABLE drawing_files ADD COLUMN skipped_reason TEXT;
  CREATE TABLE docs (
    id TEXT PRIMARY KEY,              -- doc_ + 16 hex of the path
    folder_id TEXT,
    project TEXT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,               -- docx | xlsx | text | eml | image | old
    mtime INTEGER,
    size INTEGER,
    parts INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT,
    skipped_reason TEXT,              -- why it couldn't be read, in plain words
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX docs_folder ON docs(folder_id);
  CREATE TABLE doc_parts (doc_id TEXT NOT NULL, n INTEGER NOT NULL, label TEXT, text TEXT NOT NULL, grid_json TEXT, PRIMARY KEY (doc_id, n));
  CREATE VIRTUAL TABLE doc_fts USING fts5(doc_id UNINDEXED, n UNINDEXED, name, label, text);
  `,
  `
  -- v2 6.2: the conversation search index only followed new lines. Keep it right when a line is changed or removed,
  -- and rebuild it once from the log.
  CREATE TRIGGER conversation_ad AFTER DELETE ON conversation_log BEGIN
    INSERT INTO conversation_fts(conversation_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER conversation_au AFTER UPDATE OF text ON conversation_log BEGIN
    INSERT INTO conversation_fts(conversation_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO conversation_fts(rowid, text) VALUES (new.id, new.text);
  END;
  INSERT INTO conversation_fts(conversation_fts) VALUES ('rebuild');
  `,
  `
  -- v2 7.2: held writes can expire (after three days, or cleared here). SQLite can't change a CHECK, so the table is
  -- copied into one that allows 'expired'. Then the keeper's old "noticed in conversation" holds are cleared, not applied:
  -- the owner gets asked afresh in the sit-down.
  CREATE TABLE profile_changes_new (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL CHECK (target IN ('SOUL.md','USER.md','memory')),
    op TEXT NOT NULL,
    section TEXT,
    old TEXT,
    new TEXT,
    source TEXT,
    trust TEXT NOT NULL CHECK (trust IN ('user','external')),
    status TEXT NOT NULL CHECK (status IN ('applied','held','rejected','expired')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  INSERT INTO profile_changes_new (id, target, op, section, old, new, source, trust, status, created_at, decided_at)
    SELECT id, target, op, section, old, new, source, trust, status, created_at, decided_at FROM profile_changes;
  DROP TABLE profile_changes;
  ALTER TABLE profile_changes_new RENAME TO profile_changes;
  CREATE INDEX profile_changes_status ON profile_changes(status, created_at);
  UPDATE profile_changes SET status = 'expired', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'held' AND source = 'noticed in conversation';
  `,
  `
  -- v2 8.1: the shelf of reference books (src/reference/library.ts). The books stay in the owner's reference folder and
  -- are only ever read; this is an index of them. A shelf note (.md or .txt beside the books) is a row with pages = 0
  -- and its first 6,000 characters in note.
  CREATE TABLE ref_books (
    id TEXT PRIMARY KEY,              -- ref_ + 12 hex of the path
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,               -- the file name
    title TEXT NOT NULL DEFAULT '',
    shelf TEXT NOT NULL DEFAULT '',   -- the first folder under the reference folder ("Standards")
    pages INTEGER NOT NULL DEFAULT 0,
    has_toc INTEGER NOT NULL DEFAULT 0,
    size INTEGER,
    mtime INTEGER,
    hash TEXT,
    state TEXT NOT NULL CHECK (state IN ('waiting','reading','ready','failed')),
    error TEXT,                       -- why it couldn't be read, in plain words
    note TEXT,                        -- a shelf note's text
    indexed_at TEXT
  );
  CREATE TABLE ref_toc (
    book_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    level INTEGER NOT NULL,
    title TEXT NOT NULL,
    page INTEGER NOT NULL,            -- PDF page, from 1
    trail TEXT NOT NULL,              -- the entry's whole path joined with " › "
    PRIMARY KEY (book_id, seq)
  );
  CREATE TABLE ref_pages (
    book_id TEXT NOT NULL,
    page INTEGER NOT NULL,            -- PDF page, from 1
    printed TEXT,                     -- the page number printed on it, when it shows one
    heading TEXT NOT NULL DEFAULT '', -- the first few lines (book, wind class and grade, table number and title)
    text TEXT NOT NULL,
    PRIMARY KEY (book_id, page)
  );
  CREATE VIRTUAL TABLE ref_fts USING fts5(book_id UNINDEXED, page UNINDEXED, heading, text);
  `,
  `
  -- v2 11.3: computers paired with the assistant (a small helper on each, src/helper/). Only a hash of each one's secret
  -- is kept; the secret itself is only ever in that computer's helper.json.
  CREATE TABLE computers (
    name TEXT PRIMARY KEY,            -- as paired: npm run helper:pair -- <name>
    called TEXT,                      -- what the owner calls it ("the office PC"), when he's said
    secret_hash TEXT NOT NULL,        -- sha256 of its secret, hex
    paired_at TEXT NOT NULL,
    last_seen TEXT
  );
  `,
  `
  -- v2 12.5: shop drawings made from 3D models (src/drawings/shop.ts). A drawing has a number for its job and a revision
  -- history; every revision keeps the model it was drawn from and where its files are, so an earlier one can be opened.
  CREATE TABLE shop_drawings (
    id TEXT PRIMARY KEY,              -- sd_ + 8 hex
    number TEXT NOT NULL UNIQUE,      -- COO-SD-003
    job TEXT NOT NULL,                -- COO
    project TEXT NOT NULL,
    client TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PRELIMINARY','FOR APPROVAL','FOR CONSTRUCTION')),
    rev TEXT NOT NULL,                -- the newest revision
    model_item TEXT,                  -- the model item the newest revision was drawn from
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE shop_drawing_revs (
    drawing_id TEXT NOT NULL,
    rev TEXT NOT NULL,
    status TEXT NOT NULL,
    text TEXT NOT NULL,               -- what changed, one line ("Top 50 wider")
    date TEXT NOT NULL,               -- as written on the drawing (13.11.26)
    model_json TEXT NOT NULL,         -- the model as drawn
    input_json TEXT NOT NULL,         -- title, finish, notes as drawn
    sheets_json TEXT NOT NULL,        -- [{title, aspect}]
    pdf TEXT NOT NULL,                -- the files, in the folder the app manages
    dxf TEXT NOT NULL,
    parts_dir TEXT NOT NULL,
    item_id TEXT,
    made_at TEXT NOT NULL,
    PRIMARY KEY (drawing_id, rev)
  );
  `,
  `
  -- v2 13.2: pins, up to five things kept on the phone's home screen (src/store/pins.ts). A pin points at items (the
  -- page pinned and the pages it was opened with) and remembers where he left it. Items in a pin keep pinned_at set.
  CREATE TABLE pins (
    id TEXT PRIMARY KEY,              -- pin_ + 16 hex
    item_ids TEXT NOT NULL,           -- JSON list of item ids: the pages it opens with, in order
    idx INTEGER NOT NULL DEFAULT 0,   -- the page he left it on
    view_json TEXT,                   -- where he left it: { view: { s, cx, cy } } or a 3D model's { camera: { pos, target } }
    pinned_at TEXT NOT NULL,
    until TEXT,                       -- "for today": his next local midnight; NULL until he unpins it
    updated_at TEXT NOT NULL
  );
  -- What "keep that handy" kept before pins (it was the same words): the newest five become pins; any others let go.
  INSERT INTO pins (id, item_ids, idx, view_json, pinned_at, until, updated_at)
    SELECT 'pin_' || substr(id, 5), json_array(id), 0, NULL, pinned_at, NULL, pinned_at
    FROM items WHERE pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 5;
  UPDATE items SET pinned_at = NULL WHERE pinned_at IS NOT NULL AND id NOT IN (SELECT json_extract(item_ids, '$[0]') FROM pins);
  `,
  `
  -- v2 14.1: makers' guides, a second kind of book on the reference shelf (src/reference/guides.ts). A PDF under the
  -- shelf's "Guides" folder is a guide; what it is (maker, product, title, date, where it came from) comes from the
  -- manifest.json beside it, or from its folder and the PDF itself when there's none. Standards books keep kind 'book'.
  ALTER TABLE ref_books ADD COLUMN kind TEXT NOT NULL DEFAULT 'book';   -- book | guide
  ALTER TABLE ref_books ADD COLUMN maker TEXT;
  ALTER TABLE ref_books ADD COLUMN product TEXT;
  ALTER TABLE ref_books ADD COLUMN doc_date TEXT;                       -- as YYYY, YYYY-MM or YYYY-MM-DD, when printed
  ALTER TABLE ref_books ADD COLUMN doc_version TEXT;                    -- "Version 5", when that's all it prints
  ALTER TABLE ref_books ADD COLUMN source_url TEXT;                     -- the maker's address it was fetched from
  ALTER TABLE ref_books ADD COLUMN fetched_at TEXT;
  -- A newer copy of a guide found by the monthly check. Never swapped in without the owner's yes.
  CREATE TABLE guide_updates (
    book_id TEXT PRIMARY KEY,
    found_at TEXT NOT NULL,
    url TEXT NOT NULL,
    hash TEXT NOT NULL,                 -- sha256 of the newer copy
    doc_date TEXT,                      -- its date, when it prints one
    staged TEXT,                        -- where the newer copy waits (under the data folder, never the shelf)
    status TEXT NOT NULL CHECK (status IN ('new','told','swapped','declined','gone')),
    told_at TEXT,
    decided_at TEXT
  );
  `,
  `
  -- v2 14.3: keys for the iPhone's Shortcuts (Siri, the Action Button, the Share Sheet), one per device. Only a hash of
  -- each key is kept; the key itself was shown once on the PC and lives only in that Shortcut.
  CREATE TABLE shortcut_keys (
    name TEXT PRIMARY KEY,              -- as made: npm run shortcut:pair -- <name>, or the PC's Settings
    key_hash TEXT NOT NULL,             -- sha256 of the key, hex
    made_at TEXT NOT NULL,
    last_used TEXT,
    revoked_at TEXT                     -- set when it's taken away; the key stops working at once
  );
  `,
  `
  -- v3: each bot keeps its own choices and place in the team. Removed bots stay in the record.
  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    soul TEXT NOT NULL,
    look TEXT NOT NULL,
    engine TEXT NOT NULL CHECK (engine IN ('hermes', 'builtin')),
    "primary" TEXT NOT NULL,
    fallbacks TEXT NOT NULL,
    servers TEXT NOT NULL,
    computer INTEGER NOT NULL,
    voice TEXT NOT NULL,
    box TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    lead INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );
  CREATE UNIQUE INDEX bots_one_lead ON bots(lead) WHERE lead = 1 AND removed_at IS NULL;
  CREATE UNIQUE INDEX bots_gateway_port ON bots(json_extract(box, '$.gatewayPort'));
  `,
  `
  -- 20: the conversations shown by HQ.
  CREATE TABLE bot_rows (
    bot TEXT NOT NULL,
    generation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (bot, generation, seq)
  );
  CREATE INDEX bot_rows_rev ON bot_rows(bot, rev);
  `,
  `
  -- 21: job cards, an approved about card and separate notebooks.
  ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'lead';
  CREATE INDEX memories_scope ON memories(scope, status, updated_at);
  CREATE TABLE bot_cards (
    bot TEXT NOT NULL REFERENCES bots(id),
    version INTEGER NOT NULL,
    card_json TEXT NOT NULL,
    made_at TEXT NOT NULL,
    made_by TEXT NOT NULL,
    note TEXT NOT NULL,
    acknowledged_risk INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot, version)
  );
  CREATE TABLE about_card (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL, revision INTEGER NOT NULL);
  INSERT INTO about_card VALUES (1, '', 0);
  `,
];

function migrate() {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
migrate();
