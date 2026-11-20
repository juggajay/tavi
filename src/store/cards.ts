// Cards: what Tavi puts on the phone screen. Every one is kept so the user can find it again (the Cards button,
// or "put that floor plan back up"). One answer is ONE card: the drawing shown mid-answer plus the summary the brain
// finishes with, instead of the summary replacing the drawing a second later.
import { db, newId, nowIso } from "./db.js";

export type CardImage = { src: string; caption?: string; source?: string };
export type CardRow = { label: string; value: string };
export type Card = { id: string; title: string; source: string; images: CardImage[]; rows: CardRow[]; origin: string; created_at: string; shown_at: string };
type Summary = { title?: string; rows?: CardRow[]; source?: string };
type Row = { id: string; title: string; source: string | null; images_json: string; rows_json: string; origin: string; created_at: string; shown_at: string };

const KEEP = 300;
// Only pictures our own server made (drawing crops, browser screenshots).
const ownImage = (src: unknown): src is string => typeof src === "string" && /^\/api\/(drawings\/crop|browser\/shot)\/[\w.-]+$/.test(src);

const fromRow = (r: Row): Card => ({
  id: r.id,
  title: r.title,
  source: r.source ?? "",
  images: JSON.parse(r.images_json),
  rows: JSON.parse(r.rows_json),
  origin: r.origin,
  created_at: r.created_at,
  shown_at: r.shown_at,
});

function fresh(s: Summary & { images?: CardImage[] }, origin: string, id = newId("crd")): Card {
  const at = nowIso();
  return {
    id,
    title: (s.title || "Card").slice(0, 200),
    source: (s.source ?? "").slice(0, 300),
    images: (s.images ?? []).filter((i) => ownImage(i.src)),
    rows: (s.rows ?? []).slice(0, 60).map((r) => ({ label: String(r.label), value: String(r.value) })),
    origin,
    created_at: at,
    shown_at: at,
  };
}

function store(c: Card, persist = true): Card {
  if (!persist) return c;
  db.prepare(
    `INSERT INTO cards (id, title, source, images_json, rows_json, origin, created_at, shown_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, source = excluded.source, images_json = excluded.images_json,
       rows_json = excluded.rows_json, shown_at = excluded.shown_at`,
  ).run(c.id, c.title, c.source, JSON.stringify(c.images), JSON.stringify(c.rows), c.origin, c.created_at, c.shown_at);
  db.prepare(`DELETE FROM cards WHERE id NOT IN (SELECT id FROM cards ORDER BY shown_at DESC LIMIT ${KEEP})`).run();
  return c;
}

export const getCard = (id: string) => {
  const r = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
};

export const recentCards = (limit = 80) => (db.prepare("SELECT * FROM cards ORDER BY shown_at DESC LIMIT ?").all(limit) as Row[]).map(fromRow);

/** Recent cards matching the words (title, source, picture captions), best match first; no words means the latest. */
export function findCards(query = "", limit = 5): Card[] {
  const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter((w) => w.length > 1);
  const all = recentCards(KEEP);
  if (!words.length) return all.slice(0, limit);
  const hay = (c: Card) => [c.title, c.source, ...c.images.map((i) => `${i.caption ?? ""} ${i.source ?? ""}`), ...c.rows.map((r) => r.label)].join(" ").toLowerCase();
  return all
    .map((c, i) => ({ c, score: words.filter((w) => hay(c).includes(w)).length * 1000 - i }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

/* ---------- one answer, one card ---------- */
// The brain answers one request at a time (the gateway queues them), so there is at most one answer in progress.
let turn: { card: Card | null; reopened: boolean; persist: boolean } | null = null;

/** An answer is starting. persist=false for test messages: their cards go to the phone but are never kept. */
export function beginTurn(persist = true) {
  turn = { card: null, reopened: false, persist };
}

/** Has the answer in progress put anything on screen yet (a drawing, or an earlier card brought back)? */
export const shownThisTurn = () => !!turn?.card;

/** A drawing put on screen (show_drawing). Mid-answer it starts the answer's card, or joins it; otherwise it's its own card. */
export function cardShown(show: { title: string; image: string; source?: string; background?: boolean }): Card {
  const image = { src: show.image, caption: show.title, source: show.source };
  if (!turn || show.background) return store(fresh({ title: show.title, source: show.source, images: [image] }, "answer"));
  if (!turn.card || turn.reopened) {
    turn.card = fresh({ title: show.title, source: show.source, images: [image] }, "answer");
    turn.reopened = false;
  } else if (!turn.card.images.some((i) => i.src === image.src)) {
    turn.card.images.push(image);
  }
  return store(turn.card, turn.persist);
}

/** v1 phone page: a list, table or note shown as a v2 item becomes a card of label/value rows. */
export function rowsShown(s: { title: string; source?: string; rows: CardRow[] }): Card {
  return store(fresh(s, "answer"), turn?.persist ?? true);
}

/** Bring an earlier card back up ("show me that again"). It moves to the top of the list. */
export function reopenCard(id: string): Card | null {
  const c = getCard(id);
  if (!c) return null;
  c.shown_at = nowIso();
  store(c, turn?.persist ?? true);
  if (turn && !turn.card) {
    turn.card = c;
    turn.reopened = true;
  }
  return c;
}

/** The answer is finished: its summary joins the card shown during it, or becomes a card of its own. */
export function endTurn(summary?: Summary | null): Card | null {
  const t = turn;
  turn = null;
  if (!t) return summary ? store(fresh(summary, "answer")) : null;
  if (t.reopened) return t.card; // they asked to see an earlier card: leave it as it was
  if (!summary) return t.card;
  if (!t.card) return store(fresh(summary, "answer"), t.persist);
  if (summary.title) t.card.title = summary.title.slice(0, 200);
  if (summary.rows?.length) t.card.rows = fresh(summary, "answer").rows;
  if (summary.source) t.card.source = summary.source.slice(0, 300);
  return store(t.card, t.persist);
}

/** A notice's card (follow-ups, routines, browser jobs), kept once under an id tied to the notice. */
export function noticeCard(n: { id: string; card: unknown }): Card | null {
  if (!n.card || typeof n.card !== "object") return null;
  const id = `crd_${n.id}`;
  const known = getCard(id);
  if (known) return known;
  const s = n.card as Summary & { image?: string };
  return store(fresh({ ...s, images: s.image ? [{ src: s.image }] : [] }, "notice", id));
}
