import type { Page } from "./pages/shape.js";
// Messages between the gateway and the phone and desktop apps over /ws. TYPES ONLY: imported by both the gateway
// (Node) and the UI (browser), so it must never import anything or contain code. docs/v2/PROTOCOL.md describes each
// message, who receives it, and gives an example.
//
// Version 1 is the original phone page (web/index.html): it never sends hello and gets the v1 messages unchanged.
// Everything below is version 2.

export type ProtocolVersion = 2;
export type ClientKind = "phone" | "desktop";

/** Where a brain turn came from: a client (typed, or by voice on the client that owns the voice session) or the app itself. */
export type Origin = { client: ClientKind | "legacy"; id: string } | { kind: "voice" | "routine" | "followup" };

/** What a client has on screen (sent from Stage 1 on). view is the sheet viewer's state for sheets. */
export type ScreenState = {
  item_id: string | null;
  view?: { s: number; cx: number; cy: number };
  stack_depth?: number;
  page_index?: number;
  page_count?: number;
  /** The sketch pad is open (Stage 8.5): they're drawing something to show the assistant. */
  pad?: boolean;
  /** A 3D model is up (Stage 9): whether it's pulled apart and showing its sizes. */
  model?: { apart: boolean; sizes: boolean };
  /** The pages it's swiping between, when there's more than one (Stage 13.2: "pin this" keeps them together). */
  set?: string[];
  /** A 3D model's camera (Stage 13.2: a pin opens it the way it was being looked at). */
  camera?: CamPlace;
};

/** Where a page is being looked at: zoom (1 = the whole page) and the middle of the view, as fractions of the page. */
export type ViewPlace = { s: number; cx: number; cy: number };
/** A 3D model's camera: where it is and what it looks at, in the model's millimetres. */
export type CamPlace = { pos: [number, number, number]; target: [number, number, number] };
/**
 * A pin (Stage 13.2): something the owner keeps on the phone's home screen. items: the pages it opens with (sent whole,
 * so it opens at once and with no reception); idx, view, camera: where he left it; until: "for today" (his midnight).
 * sheet: when the item at idx is a set of shop drawings (Stage 12), which of its sheets he left it on (from 1).
 */
export type Pin = { id: string; item_ids: string[]; items: Item[]; idx: number; view: ViewPlace | null; camera: CamPlace | null; sheet?: number; label: string; pinned_at: string; until: string | null };

/* ---------------- client → server ---------------- */

export type ClientHello = { type: "hello"; v: 2; client: ClientKind; id: string; hq?: boolean };
/** files: photos sent with these words (Stage 8.4), by the ids /api/v2/upload?as=photo answered with. */
export type ClientTyped = { type: "typed"; text: string; request_id: string; test?: boolean; files?: string[]; bot?: string };
export type ClientDecide = { type: "decide"; id: string; nonce: string; decision: "approve" | "reject" };
export type ClientSeen = { type: "seen"; ids: string[] };
export type ClientScreen = { type: "screen" } & ScreenState;
/** Stop a running job (Stage 5; accepted and ignored before then). */
export type ClientCancel = { type: "cancel"; job_id: string };

/** Change an email draft's words before sending: makes a new approval for the same item (Stage 1.5). */
export type ClientRevise = { type: "revise"; id: string; nonce: string; subject?: string; body?: string };

/** The round table (Stage 17): End tapped; a line it was asked to say has been said; the owner cut in on it. */
export type ClientTable = { type: "table_end" } | { type: "table_played"; id: string; ok: boolean; first_ms?: number; waited_ms?: number } | { type: "table_cut"; id: string };
export type ClientMessage = ClientHello | ClientTyped | ClientDecide | ClientSeen | ClientScreen | ClientCancel | ClientRevise | ClientTable;

/* ---------------- server → client ---------------- */

/** Pending approval, as the broker shows it (src/broker/broker.ts ApprovalView). The nonce is what makes Send work. */
export type Approval = {
  id: string;
  nonce: string;
  operation: string;
  kind: "email" | "action";
  account: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  rows?: { label: string; value: string }[];
  image?: string;
  expires_at: string;
};
export type Outcome = { approvalId: string; status: string; message: string; providerRef?: string };
export type Notice = { id: string; title: string; spoken: string; card: unknown; priority: "urgent" | "normal" | "low"; created_at: string };
export type Settings = Record<string, unknown>;

export type ServerHello = { type: "hello"; v: 2; voiceReady: boolean; notice: string | null; name: string | null; settings: Settings; dev: boolean; first_run?: boolean; /** One short line for under Pebble after a quiet spell (Stage 7.4); text only, never spoken. */ say?: string; /** The build of this app the gateway serves (Stage 13.4, src/shared/build.ts): an app on another reloads itself at a safe moment. null: not built. */ build?: string | null };
export type ServerBrain = {
  type: "brain";
  phase: "thinking" | "done" | "error";
  job_id: string;
  request_id?: string;
  origin: Origin;
  source: "voice" | "typed";
  label?: string;
  spoken?: string;
  card?: unknown;
  message?: string;
  /** v2, on error: what to say about it, in plain words ("I've hit my limit for now. Try again in a bit."). */
  say?: string;
  /** v2, thinking: the label is the brain's own words of what it's doing (Stage 21.3), not a tool's step label. */
  own?: boolean;
};
export type ServerHeard = { type: "heard"; text: string; job_id: string | null };
/** A conversation line was written (the desktop thread uses it from Stage 3). */
/** role guest: the round table's second assistant (Stage 17), on the "table" channel. */
export type ServerLine = { type: "line"; id: number; role: "user" | "assistant" | "system" | "guest"; channel: string; text: string; at: string; job_id: string | null };
export type ServerApproval = { type: "approval"; approval: Approval & { item_id?: string } };
export type ServerOutcome = { type: "outcome"; outcome: Outcome };
export type ServerNotices = { type: "notices"; items: Notice[] };
export type ServerNotice = { type: "notice"; notice: Notice };
export type ServerLive = { type: "live"; state: "closed" | "degraded"; message?: string };
export type ServerName = { type: "name"; name: string | null };
export type ServerAccounts = { type: "accounts" };
/** Work going on in the background (Stage 5): the newest piece and, since Stage 21.3, what it is doing now in plain words. */
export type ServerBackground = { type: "background"; phase: "start" | "end"; title: string; doing?: string; job_id?: string };
export type ServerDrawings = { type: "drawings"; phase: string; name?: string; project?: string; detail?: string };
export type ServerSettings = { type: "settings"; values: Settings };

/* ---------------- items: what the assistant shows (Stage 1) ---------------- */

/** A box on a page as fractions of its width and height, origin top-left: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];
export type Mark = { box: Box; label?: string };
export type Row = { label: string; value: string };
export type ListTarget = { type: "sheet"; sheet_id: string; box: Box; label: string } | { type: "item"; item_id: string };

export type SheetPayload = {
  sheet_id: string;
  sheet_no: string | null;
  title: string | null;
  revision: string | null;
  status: string;
  project: string;
  aspect: number; // page width / height
  marks: Mark[];
  view: Box; // where to open; [0,0,1,1] is the whole page
};
/** A row with a url is a web result (a place, business or page): tapping it opens the link in the browser. */
export type ListPayload = { heading: string; sub?: string; columns?: string[]; rows: { id: string; cells: string[]; target?: ListTarget; url?: string }[] };
export type TablePayload = { columns: string[]; rows: string[][]; highlight?: { row: number; col: number }[]; note?: string };
export type DraftStatus = "pending" | "sent" | "done" | "declined" | "expired" | "failed";
/** A write waiting for the owner's OK. The nonce is never in here: it arrives only in the live approval message. */
export type DraftPayload = {
  approval_id: string;
  operation: string;
  account: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  summary: string;
  details: Row[];
  image?: string;
  editable: boolean;
  status: DraftStatus;
  outcome_message?: string;
};
export type NotePayload = { rows: Row[]; text?: string };
export type ImagePayload = { src: string; w: number; h: number; alt: string };
export type LegacyPayload = { images: { src: string; caption?: string; source?: string }[]; rows: Row[] };
export type DocPayload = { file_id: string; name: string; part_label: string; text: string; more: boolean };
/** A page of one of the owner's reference books (Stage 8.2), zoomable like a sheet. marks: the row it used, ringed. */
export type ReferencePayload = { book_id: string; page: number; printed: string | null; aspect: number; marks: Mark[]; view: Box };

/** A point in millimetres: x to the right, y UP (the app flips it for the screen). */
export type Pt = [number, number];
/** One thing in a sketch (Stage 8.5). Everything in millimetres; angles in degrees, counter-clockwise from +x. */
export type SketchShape =
  | { type: "line"; a: Pt; b: Pt; style?: "solid" | "dashed"; weight?: 1 | 2 | 3 }
  | { type: "rect"; x: number; y: number; w: number; h: number; fill?: "none" | "timber" | "hatch" }
  | { type: "poly"; points: Pt[]; fill?: "none" | "timber" | "hatch" }
  | { type: "arc"; c: Pt; r: number; from_deg: number; to_deg: number }
  | { type: "dim"; a: Pt; b: Pt; offset: number; text?: string }
  | { type: "angle"; at: Pt; from_deg: number; to_deg: number; text?: string }
  | { type: "label"; at: Pt; text: string; leader?: Pt };
/** A simple dimensioned line drawing the brain describes and the app draws (the brain never writes SVG or HTML). */
export type SketchPayload = { shapes: SketchShape[]; note?: string };

/* 3D models (Stage 9). Millimetres, right-handed, z UP. Rotations in degrees, applied about x, then y, then z. */
export type Vec3 = [number, number, number];
/**
 * box: at is its minimum corner before rotation (it turns about that corner). cyl: at is the centre of its base; it runs
 * h along its axis. prism: a flat outline of [u, v] points pushed depth along the plane's third axis from at
 * ("xy": u = x, v = y, pushed along z; "xz": u = x, v = z, along y; "yz": u = y, v = z, along x).
 */
export type Solid =
  | { type: "box"; size: Vec3; at?: Vec3; rot?: Vec3 }
  | { type: "cyl"; r: number; h: number; axis: "x" | "y" | "z"; at: Vec3 }
  | { type: "prism"; points: [number, number][]; plane: "xy" | "xz" | "yz"; depth: number; at?: Vec3 };
export type ModelMaterial = "pine" | "hardwood" | "oak" | "walnut" | "ply" | "mdf" | "steel" | "concrete" | "plain";
/**
 * One piece: its stock with every cut taken away, both in the part's own frame; then turned by rot and moved to at.
 * grain: the way the timber's grain runs in the part's own frame (default: the stock's longest side). apart: how far,
 * and which way, it slides when the model is pulled apart.
 */
export type ModelPart = { id: string; name: string; material: ModelMaterial; stock: Solid; cuts?: Solid[]; at?: Vec3; rot?: Vec3; grain?: "x" | "y" | "z"; apart?: Vec3 };
/**
 * A size shown on the model, from a to b; no text: the app writes the true length. part: it moves with that part when
 * pulled apart. show: only "together" or only "apart" (a tenon's sizes, hidden inside the post when it's together).
 */
export type Dim3 = { a: Vec3; b: Vec3; text?: string; part?: string; show?: "together" | "apart" };
/**
 * Who chose how it goes together (Stage 19.7): the owner ("owner"), the assistant ("assistant") or some of each
 * ("mixed"); per joint, by the parts it joins (their names or kinds: ["apron", "leg"]), what it is, how it's held in
 * his words ("top screwed through buttons") and whose it was; and the design rules its proportions follow (Stage 20.2's
 * ids, src/shared/model3d/designRules.ts; none: the assistant's own judgement). The shop drawing's joint schedule says
 * AS DIRECTED or SUGGESTED, CONFIRM from it, and under a suggestion where it came from.
 */
export type ModelDesign = { by: "owner" | "assistant" | "mixed"; joints?: { parts: string[]; kind: string; fixing?: string; by: "owner" | "assistant"; rules?: string[] }[] };
export type ModelPayload = { parts: ModelPart[]; dims?: Dim3[]; note?: string; made_by?: { recipe: string; params: Record<string, number | string | boolean> }; design?: ModelDesign };

/**
 * A set of shop drawings (Stage 12): one revision of a numbered drawing made from a 3D model. Its sheets are PDF pages
 * the gateway draws as pictures and zoom tiles (GET /api/shopdrawings/<drawing>/<rev>/<sheet>…, like a drawing sheet);
 * pdf and dxf are where the files download from. revisions: the whole history, newest last.
 */
export type ShopDrawingStatus = "PRELIMINARY" | "FOR APPROVAL" | "FOR CONSTRUCTION";
export type ShopDrawingPayload = {
  drawing_id: string;
  number: string;
  rev: string;
  status: ShopDrawingStatus;
  project: string;
  client: string;
  model_item: string | null;
  sheets: { title: string; aspect: number }[];
  revisions: { rev: string; date: string; text: string; status: ShopDrawingStatus }[];
  pdf: string;
  dxf: string;
  /** In the apps only: which sheet (from 1) a page of the set shows. Never sent by the gateway. */
  sheet?: number;
  /** The sheet to open it at (from 1): where a view he just asked for was put (Stage 19.3). */
  open_at?: number;
};

export type ItemKind = "page" | "sheet" | "list" | "table" | "draft" | "note" | "image" | "legacy" | "doc" | "reference" | "sketch" | "model" | "shopdrawing";
type ItemOf<K extends ItemKind, P> = {
  id: string;
  kind: K;
  title: string;
  source: string;
  payload: P;
  origin: "answer" | "notice" | "approval" | "legacy";
  job_id: string | null;
  seq: number;
  created_at: string;
  shown_at: string;
  pinned: boolean;
};
export type Item =
  | ItemOf<"page", Page>
  | ItemOf<"sheet", SheetPayload>
  | ItemOf<"list", ListPayload>
  | ItemOf<"table", TablePayload>
  | ItemOf<"draft", DraftPayload>
  | ItemOf<"note", NotePayload>
  | ItemOf<"image", ImagePayload>
  | ItemOf<"legacy", LegacyPayload>
  | ItemOf<"doc", DocPayload>
  | ItemOf<"reference", ReferencePayload>
  | ItemOf<"sketch", SketchPayload>
  | ItemOf<"model", ModelPayload>
  | ItemOf<"shopdrawing", ShopDrawingPayload>;

/** Something to show. open: put it up now (only on the client whose turn made it); otherwise just list it. */
/** replaces: the id of a model it takes the place of (Stage 9.3): a screen showing that one swaps it in, keeping the view. */
export type ServerItem = { type: "item"; item: Item; open: boolean; replaces?: string };
export type ServerItemUpdate = { type: "item_update"; id: string; patch: Partial<Item> };
/** A command for the client's pull-up surface (from the voice fast path, Stage 1.4). */
export type SurfaceCommand =
  | { cmd: "clear" | "back" | "next" | "prev" | "zoom_out" | "zoom_in" }
  | { cmd: "focus"; box: Box; mark?: Mark }
  | { cmd: "open"; item_id: string }
  /** Open the sketch pad (Stage 8.5): blank, or over a photo they sent; prompt is the assistant's question, shown small. */
  | { cmd: "pad"; prompt?: string; over?: { file: string; src: string; w: number; h: number } }
  /** A 3D model on screen (Stage 9.3, from the fast path): pull apart, sizes, look from a side, turn round, reset. */
  | { cmd: "model"; op: ModelOp; side?: ModelSide }
  /** Draw these views of a model and post them to /api/v2/model/<item>/pictures (look_at_model). */
  | { cmd: "model_pictures"; item_id: string; req: string; views: ModelShot[] }
  /** Make a file of a model and post it to /api/v2/upload?as=model (save_model). */
  | { cmd: "model_save"; item_id: string; req: string; as: "picture" | "glb" | "stl"; name: string }
  /** The desktop's file viewer (Stage 15.1), opened at a group, a job or the words searched for ("everything for Example Lake"). */
  | { cmd: "files"; group?: string; job?: string; q?: string }
  /** The desktop's live view of the assistant's browser (Stage 15.2), in the right-hand pane. */
  | { cmd: "browser" };
export type ModelOp = "apart" | "together" | "sizes" | "no_sizes" | "look" | "turn" | "reset";
export type ModelSide = "top" | "front" | "side" | "back" | "underneath";
/** A picture of a model: three-quarter assembled (hero), the same pulled apart, or straight on from one side. */
export type ModelShot = "hero" | "apart" | "top" | "front" | "side" | "back";
export type ServerSurface = { type: "surface" } & SurfaceCommand;
export type ServerApprovalGone = { type: "approval_gone"; id: string; item_id: string | null; reason: "expired" | "decided" | "revised" };
/** Every pin, oldest first (Stage 13.2): on connecting, and whenever they change. */
export type ServerPins = { type: "pins"; pins: Pin[] };

/** The assistant's browser (Stage 15.2), to the desktop: open or not, the site, what it's doing, taken over or not. */
export type BrowserView = {
  open: boolean;
  mode: "job" | "owner" | null;
  job_id: string | null;
  summary: string;
  url: string;
  domain: string;
  secure: boolean;
  title: string;
  doing: string;
  takeover: "off" | "pending" | "on";
  asking: string | null;
  approval: string | null;
  notes: string[];
  started_at: string | null;
};
export type ServerBrowser = { type: "browser"; view: BrowserView };
/** The round table (Stage 17): who's at it and what's been said (the newest 40 lines), whenever it changes. on false: over. */
export type TableSpeaker = "owner" | "pebble" | "guest";
export type TableLineView = { id: string; speaker: TableSpeaker; text: string; at: number; kind?: "start" | "end" | "note" | "close" };
export type ServerTable = {
  type: "table";
  on: boolean;
  id: string | null;
  names: { guest: string; pebble: string };
  /** What the assistant told the guest when it brought him in. */
  brief: string;
  lines: TableLineView[];
  thinking: "pebble" | "guest" | null;
  speaking: "pebble" | "guest" | null;
  test: boolean;
};
/** To the app on a call (Stage 17.3): say this line of the round table's, after anything before it, from its audio (raw
 * 24 kHz 16-bit mono, streamed). The app answers table_played { id, ok, first_ms } or table_cut { id }. table_hush: stop
 * anything of the round table's being said, and drop what's waiting. */
export type ServerTableSay = { type: "table_say"; id: string; speaker: "pebble" | "guest"; text: string; audio: string } | { type: "table_hush" };
/** While a round table is on (Stage 18.1) the device mutes the call's own voice (the table's lines are played by the
 * app), and un-mutes it when it's over. Sent to the v2 apps when one starts with a call on, when a call starts while one
 * is on, and when it ends. (The `table` message's `on` says the same, for an app that connects in the middle.) */
export type ServerCallVoice = { type: "call_voice"; muted: boolean };

/** Desktop pings: something on that page changed, refetch it. */
export type ServerRefresh = { type: "activity" | "memory" | "files" };
/** The original phone page's card (v1). v2 apps ignore it; it goes when that page is retired. */
export type ServerShow = { type: "show"; card: unknown };

export type ServerMessage =
  | ServerHq
  | ServerHello
  | ServerBrain
  | ServerHeard
  | ServerLine
  | ServerApproval
  | ServerOutcome
  | ServerNotices
  | ServerNotice
  | ServerLive
  | ServerName
  | ServerAccounts
  | ServerBackground
  | ServerDrawings
  | ServerSettings
  | ServerItem
  | ServerItemUpdate
  | ServerSurface
  | ServerApprovalGone
  | ServerPins
  | ServerTable
  | ServerTableSay
  | ServerCallVoice
  | ServerRefresh
  | ServerBrowser
  | ServerShow;

/** The bot team sends these only to apps which asked for hq in hello. */
export type HqSafety = { level: import("../hq/contract.js").SafetyLevel; until: string | null; pinSet: boolean; ownerUbuntuRunning: boolean };
export type HqEngine = {
  status: "ready" | "starting" | "stopped" | "not_signed_in" | "error";
  why: string; version: string; primary: import("../hq/contract.js").EngineChoice;
  fallbacks: import("../hq/contract.js").EngineChoice[]; signedIn: Record<string, boolean>;
  limits: { bot: string; provider: import("../hq/contract.js").Provider; resetsAt: string }[];
  usage: { day: string; week: string;
    today: Partial<Record<import("../hq/contract.js").Provider, { input: number; output: number }>>;
    thisWeek: Partial<Record<import("../hq/contract.js").Provider, { input: number; output: number }>> };
};
export type ServerHq =
  | { type: "hq_row"; row: import("../hq/contract.js").Row }
  | { type: "hq_row_dropped"; bot: string; generation: number; seq: number }
  | { type: "hq_live"; live: import("../hq/contract.js").Live }
  | { type: "hq_bots"; bots: Omit<import("../hq/contract.js").Bot, "box">[] }
  | { type: "hq_safety"; safety: HqSafety }
  | { type: "hq_engine"; bot: string; engine: HqEngine };
