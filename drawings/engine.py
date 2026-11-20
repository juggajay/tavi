"""Tavi drawing engine (PyMuPDF). Called by the Node gateway; prints JSON.

    python engine.py ingest <pdf> <out_dir>
        For each page: read-path signals, full text, word boxes (normalised 0..1, saved to
        <out_dir>/p<N>.words.json), title-block region guess, and candidate sheet number /
        title / revision from the file name, labelled title-block fields and any cover-sheet
        drawing list. Candidates come with their source; nothing is guessed silently.

    python engine.py serve
        Long-lived worker: JSON requests on stdin, one per line (see serve()).

    python engine.py ref_index <pdf>
        A reference book, one JSON line at a time: the book (pages, title, table of contents), then each page's text.

    python engine.py crop <pdf> <page> <x0> <y0> <x1> <y1> <out_png> [max_px]
        Render a region (normalised 0..1 page coords, rotation-aware) so its long edge is
        about max_px (default 1568, Claude's native vision size). Prints {path, width, height, dpi}.

Ideas carried over from an earlier document reader: per-page read-path from text/vector/image
signals, title block in the bottom-right, cover register cross-check, flag-don't-guess.
"""
import json
import os
import re
import sys

import pymupdf

pymupdf.TOOLS.mupdf_display_errors(False)

# A-2000, CC.04, S101, and a numbered series in front: A2-201, A5-202.
SHEET_CORE = r"[A-Z]{1,3}(?:\d{1,2}[-.])?[-.]?\d{1,4}(?:\.\d{1,3})?[A-Z]?"
SHEET_NO = re.compile(rf"\b({SHEET_CORE})\b")
SHEET_TOKEN = re.compile(rf"^{SHEET_CORE}$")
# Postcodes, levels and tags look like sheet numbers ("NSW 2034", "RL12", "FRL120").
NOT_SHEET = re.compile(r"^(NSW|VIC|QLD|ACT|TAS|NT|WA|SA|RL|FFL|SSL|FRL|CL|LVL|DN|UP)\b", re.I)
REV_TOKEN = re.compile(r"^[A-Z]{1,2}\d{0,2}$|^\d{1,2}$|^[A-Z]\d{1,2}$|^P\d{1,2}$|^T\d{1,2}$")
TB_LABELS = {"project", "client", "scale", "date", "title", "drawn", "checked", "approved", "rev", "revision",
             "drawing", "dwg", "sheet", "job", "issue", "status", "designed", "north", "no.", "number"}
NO_WORDS = {"no", "no.", "number", "nº", "#", "num"}
NO_LEADS = {"dwg", "dwg.", "drawing", "drg", "drg.", "sheet"}
REV_LABELS = {"rev", "rev.", "revision", "issue"}
NOT_REV = {"AS", "NO", "BY", "OF", "TO", "AT", "ON", "IN", "OR", "IF", "IS", "IT", "MM", "UP", "DN", "NTS", "A1", "A3"}
# Things that sit in a title-block "title" cell but aren't titles: table headers and issue statuses.
NOT_TITLE = re.compile(
    r"^(by|date|rev|revision|description|amendment|amendments|issue|status|scale|drawn|checked|approved|client|project|"
    r"north|notes?|for (coordination|construction|tender|approval|information|review|comment)|preliminary|draft|"
    r"not for construction|issued for\b.*|wip\b.*)\b[\s:.]*", re.I)


def looks_like_title(s):
    if not s or len(re.sub(r"[^A-Za-z]", "", s)) < 3 or s[0].islower():
        return False
    return not NOT_TITLE.fullmatch(s.strip()) and not re.match(r"^(by|date|rev)\b", s.strip(), re.I)


def norm_words(page):
    """Word boxes as fractions of the page as displayed. Text comes out in unrotated coordinates, so rotated
    pages (common on A1 sheets) are turned to match what a person sees."""
    r = page.rect
    m = page.rotation_matrix
    out = []
    for x0, y0, x1, y1, w, *_ in page.get_text("words"):
        if page.rotation:
            x0, y0, x1, y1 = pymupdf.Rect(x0, y0, x1, y1) * m
        out.append([round(x0 / r.width, 5), round(y0 / r.height, 5), round(x1 / r.width, 5), round(y1 / r.height, 5), w])
    return out


def read_path(page, text):
    tc = len(text.strip())
    nd = len(page.get_drawings())
    ni = len(page.get_images())
    # A handful of characters (e.g. just a stamp) on a heavily drawn page means the real lettering is outlined.
    if tc > 400:
        rp = "text"
    elif nd > 0:
        rp = "outlined" if ni == 0 or nd > 50 else "scanned"
    elif ni > 0:
        rp = "scanned"
    else:
        rp = "empty"
    return rp, {"text_chars": tc, "drawings": nd, "images": ni}


def from_filename(name):
    base = os.path.splitext(name)[0]
    out = {}
    m = re.match(r"^\s*([A-Z]{1,3}[-. ]?\d{2,4}(?:\.\d{1,3})?)[\s_-]+(.+?)\s*\[([A-Z0-9]{1,3})\]\s*$", base)  # A-2000 GROUND FLOOR PLAN [I]
    if m:
        return {"sheet_no": m.group(1).strip(), "title": m.group(2).strip(" _-"), "revision": m.group(3)}
    m = re.match(r"^\s*([A-Z]{1,3}\d?\.\d{2,3})[-_](.+?)[-_]Rev\.?([A-Z0-9]{1,3})\s*$", base, re.I)  # A1.101-GROUND-FLOOR-...-Rev.Y
    if m:
        return {"sheet_no": m.group(1), "title": m.group(2).replace("-", " ").strip(), "revision": m.group(3).upper()}
    m = re.search(r"\bRev(?:ision)?\.?\s*([A-Z0-9]{1,3})\b", base, re.I)
    if m:
        out["revision"] = m.group(1).upper()
    m = re.match(r"^\s*([A-Z]{1,3}[-.]?\d{3,4}(?:\.\d{1,3})?)\b", base)
    if m:
        out["sheet_no"] = m.group(1)
    return out


def is_label(w):
    return w[4].strip(":").lower() in TB_LABELS


def no_anchors(words):
    """Positions of 'DWG No.' / 'Drawing Number' / 'Sheet No' style labels."""
    out = []
    for ln in lines_of(words):
        for w in ln:
            t = w[4].strip(":").lower()
            joined = re.sub(r"[^a-z]", "", t)
            if joined in ("dwgno", "drgno", "drawingno", "sheetno", "drawingnumber", "sheetnumber"):
                out.append(w)
            elif t in NO_WORDS:
                # The lead word just left of it, by position: a tall value can share the line and sort in between.
                leads = [p for p in ln if p is not w and p[4].strip(":").lower() in NO_LEADS and p[2] <= w[0] + 0.002 and w[0] - p[2] < 0.03]
                if leads:
                    p = max(leads, key=lambda p: p[2])
                    out.append([p[0], p[1], w[2], w[3], f"{p[4]} {w[4]}"])
    return out


def title_block_region(words):
    """Where the title block is. The label band (bottom strip or right-hand column) with the most labels,
    narrowed around the drawing-number label when there is one; fallback bottom-right."""
    hits = [w for w in words if is_label(w)]
    bottom = [w for w in hits if w[1] > 0.78]
    right = [w for w in hits if w[0] > 0.78]
    band = right if len(right) >= max(3, len(bottom)) else bottom if len(bottom) >= 3 else None
    if not band:
        return [0.6, 0.7, 1.0, 1.0]
    vertical = band is right
    zone = [min(w[0] for w in band) - 0.02, min(w[1] for w in band) - 0.03, 1.0, 1.0]
    anchors = [a for a in no_anchors(words) if in_box(a, [max(0, zone[0]), max(0, zone[1]), 1, 1])]
    if anchors:
        a = max(anchors, key=lambda a: (a[0] + a[1]))  # the one nearest the bottom-right corner
        if vertical:
            zone = [zone[0], a[1] - 0.3, 1.0, min(1.0, a[3] + 0.12)]
        else:
            zone = [a[0] - 0.3, zone[1], min(1.0, a[2] + 0.3), 1.0]
    return [max(0.0, zone[0]), max(0.0, zone[1]), min(1.0, zone[2]), min(1.0, zone[3])]


def in_box(w, b):
    return w[0] >= b[0] and w[1] >= b[1] and w[2] <= b[2] + 1e-6 and w[3] <= b[3] + 1e-6


def lines_of(words):
    """Group words into reading lines (by y), left to right."""
    rows = []
    for w in sorted(words, key=lambda w: (round(w[1], 3), w[0])):
        if rows and abs(rows[-1][0][1] - w[1]) < 0.004:
            rows[-1].append(w)
        else:
            rows.append([w])
    return [sorted(r, key=lambda w: w[0]) for r in rows]


def after_label(lines, labels, pattern=None, max_words=12):
    """Value that follows a label on the same line, or on the next line."""
    for i, ln in enumerate(lines):
        toks = [w[4] for w in ln]
        for j, t in enumerate(toks):
            if t.strip(":").lower() in labels:
                rest = [x for x in toks[j + 1:] if x.strip(":").lower() not in TB_LABELS][:max_words]
                cand = " ".join(rest).strip(" :")
                if not cand and i + 1 < len(lines):
                    cand = " ".join(w[4] for w in lines[i + 1][:max_words]).strip(" :")
                if cand and (not pattern or re.search(pattern, cand)):
                    return cand
    return None


def nearest(label, cands, aspect, limit=0.05):
    """Closest candidate word to a label (values sit beside, above or below their label)."""
    lx, ly = (label[0] + label[2]) / 2, (label[1] + label[3]) / 2
    best, bd = None, limit
    for w in cands:
        if w is label or (w[0] >= label[0] and w[2] <= label[2] and w[1] >= label[1] and w[3] <= label[3]):
            continue
        dx = max(0.0, w[0] - label[2], label[0] - w[2]) * aspect
        dy = max(0.0, w[1] - label[3], label[1] - w[3])
        d = (dx * dx + dy * dy) ** 0.5
        if d < bd:
            best, bd = w, d
    return best


def sheet_token(t):
    t = t.strip(".:,;()[]")
    return t if SHEET_TOKEN.match(t) and re.search(r"\d", t) and not NOT_SHEET.match(t) else None


def from_title_block(words, box, aspect=1.0):
    tb = [w for w in words if in_box(w, box)]
    lines = lines_of(tb)
    out = {}
    anchors = no_anchors(tb)
    anchor = max(anchors, key=lambda a: a[0] + a[1]) if anchors else None
    if anchor:
        # two digits or a separator, so a revision like "T2" or "P1" isn't taken for the number
        w = nearest(anchor, [w for w in tb if sheet_token(w[4]) and re.search(r"\d.*\d|[-.]\w", w[4])], aspect)
        if w:
            out["sheet_no"] = sheet_token(w[4])
        revs = [w for w in tb if w[4].strip(":").lower() in REV_LABELS]
        rl = min(revs, key=lambda r: abs(r[0] - anchor[0]) * aspect + abs(r[1] - anchor[1])) if revs else None
        if rl and abs(rl[0] - anchor[0]) * aspect + abs(rl[1] - anchor[1]) < 0.12:
            v = nearest(rl, [x for x in tb if REV_TOKEN.match(x[4].strip(".:")) and not is_label(x)
                             and x is not w and x[4].strip(".:") not in NOT_REV], aspect, 0.04)
            if v:
                out["revision"] = v[4].strip(".:")
    else:
        no = after_label(lines, {"dwg", "drawing", "sheet", "number", "no.", "no"}, r"\d")
        m = SHEET_NO.search(no) if no else None
        if m and sheet_token(m.group(1)):
            out["sheet_no"] = m.group(1)
        rev = after_label(lines, REV_LABELS)
        if rev:
            tok = rev.split()[0].strip(".:")
            if REV_TOKEN.match(tok):
                out["revision"] = tok
    title = drawing_title(lines)
    if title:
        out["title"] = title
    return out, " ".join(" ".join(w[4] for w in ln) for ln in lines)[:1500]


def drawing_title(lines):
    """Text after a 'Drawing title' / 'Sheet title' / 'Title' label: same line up to the next label, else the next lines."""
    for i, ln in enumerate(lines):
        toks = [w[4] for w in ln]
        for j, t in enumerate(toks):
            if t.strip(":").lower() != "title" or (j > 0 and toks[j - 1].strip(":").lower() in ("project", "job", "client")):
                continue
            lab = ln[j - 1] if j > 0 and toks[j - 1].strip(":").lower() in ("drawing", "dwg", "sheet") else ln[j]
            # the title cell ends where the next label column starts
            right = min([w[0] for l2 in lines for w in l2 if is_label(w) and w[0] > ln[j][2] + 0.03 and abs(w[1] - lab[1]) < 0.03],
                        default=lab[0] + 0.25)
            rest = []
            for w in ln[j + 1:]:
                if w[0] >= right or is_label(w) or w[4].strip(":").lower() == "by":
                    break
                rest.append(w[4])
            cand = " ".join(rest[:12]).strip(" :")
            if not looks_like_title(cand):
                # value underneath the label, in the label's column; titles often wrap onto a second line
                below = []
                for nxt in lines[i + 1:]:
                    if nxt[0][1] - lab[1] > 0.05:
                        break
                    col = [w for w in nxt if lab[0] - 0.01 <= w[0] < right]
                    if any(is_label(w) for w in col):
                        break
                    below += [w[4] for w in col]
                cand = " ".join(below[:14]).strip(" :")
            cand = re.split(r"\s+(?:\d+\s?:\s?\d+\b|@|NTS\b|AS SHOWN\b|SCALE\b)", cand, maxsplit=1, flags=re.I)[0].strip(" ,:")
            if looks_like_title(cand):
                return cand
    return None


REGISTER_KEYS = ("DRAWING LIST", "DRAWING SCHEDULE", "DRAWING REGISTER", "SHEET INDEX", "DRAWING INDEX")


def parse_register(text, words=None):
    """A cover sheet's drawing list: rows like 'A-2000 GROUND FLOOR PLAN I'. Returns {sheet_no: {title, revision}}.
    Tables come out of the text layer column by column, so rows are rebuilt from word positions when possible."""
    up = text.upper()
    if not any(k in up for k in REGISTER_KEYS):
        return {}
    reg = {}
    if words:
        cols = {}
        for w in words:
            if sheet_token(w[4]):
                cols.setdefault(round(w[0], 2), []).append(w)
        col = max(cols.values(), key=len, default=[])
        for w in col if len(col) >= 3 else []:
            cy, h = (w[1] + w[3]) / 2, w[3] - w[1]
            row = sorted((v for v in words if v[0] > w[2] and abs((v[1] + v[3]) / 2 - cy) < h * 0.6), key=lambda v: v[0])
            cells, last = [], None
            for v in row:
                if last is None:
                    if v[0] - w[2] > 0.15:
                        break
                    cells.append([v[4]])
                elif v[0] - last < 0.012:
                    cells[-1].append(v[4])
                else:
                    cells.append([v[4]])
                last = v[2]
            if cells:
                title = " ".join(cells[0]).strip()
                tail = [" ".join(c) for c in cells[1:]]
                rev = tail[0] if len(tail) == 1 and REV_TOKEN.match(tail[0]) else None
                if looks_like_title(title):
                    reg[sheet_token(w[4])] = {"title": title, "revision": rev}
        if len(reg) >= 3:
            return reg
        reg = {}
    for line in text.splitlines():
        m = re.match(r"^\s*([A-Z]{1,3}[-.]?\d{2,4}(?:\.\d{1,3})?)\s+(.{4,80}?)(?:\s+([A-Z]{1,2}\d{0,2}|\d{1,2}))?\s*$", line.strip())
        if m and not m.group(2).strip().isdigit():
            reg[m.group(1)] = {"title": m.group(2).strip(), "revision": m.group(3)}
    return reg if len(reg) >= 3 else {}


def ingest(pdf, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    doc = pymupdf.open(pdf)
    pymupdf.TOOLS.mupdf_warnings()
    name = os.path.basename(pdf)
    fn = from_filename(name)
    pages, register = [], {}
    for i, page in enumerate(doc):
        text = page.get_text()
        rp, sig = read_path(page, text)
        words = norm_words(page)
        with open(os.path.join(out_dir, f"p{i}.words.json"), "w", encoding="utf-8") as f:
            json.dump(words, f)
        r = page.rect
        box = title_block_region(words)
        tb, tb_text = from_title_block(words, box, r.width / r.height) if rp == "text" else ({}, "")
        reg = parse_register(text, words) if rp == "text" else {}
        register.update(reg)
        r = page.rect
        pages.append({
            "page": i,
            "width_pt": round(r.width, 1),
            "height_pt": round(r.height, 1),
            "rotation": page.rotation,
            "read_path": rp,
            "signals": sig,
            "is_register": bool(reg),
            "title_block_box": [round(v, 4) for v in box],
            "title_block_text": tb_text,
            "from_title_block": tb,
            "from_filename": fn if doc.page_count == 1 else {k: v for k, v in fn.items() if k == "revision"},
            "text": text[:60000],
        })
    warnings = sorted({l.strip() for l in pymupdf.TOOLS.mupdf_warnings().splitlines() if l.strip()})[:10]
    print(json.dumps({"pdf": name, "page_count": doc.page_count, "pages": pages, "register": register, "warnings": warnings}))


def crop(pdf, page_no, x0, y0, x1, y1, out_png, max_px=1568):
    doc = pymupdf.open(pdf)
    page = doc[page_no]
    r = page.rect  # the page as displayed (rotation applied); get_pixmap's clip is in this same space
    clip = pymupdf.Rect(r.x0 + x0 * r.width, r.y0 + y0 * r.height, r.x0 + x1 * r.width, r.y0 + y1 * r.height)
    long_pt = max(clip.width, clip.height) or 1
    zoom = min(max_px / long_pt, 600 / 72)  # cap at 600 dpi for tiny regions
    pm = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
    pm.save(out_png)
    print(json.dumps({"path": out_png, "width": pm.width, "height": pm.height, "dpi": round(zoom * 72)}))


MAX_ZOOM = 600 / 72  # never render finer than 600 dpi


def render_region(doc, page_no, box, out_png, width):
    """Render box (normalised 0..1 of the displayed page) so it is `width` pixels wide, capped at 600 dpi."""
    page = doc[page_no]
    r = page.rect
    x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in box]
    clip = pymupdf.Rect(r.x0 + x0 * r.width, r.y0 + y0 * r.height, r.x0 + x1 * r.width, r.y0 + y1 * r.height)
    if clip.width <= 0 or clip.height <= 0:
        raise ValueError("empty box")
    zoom = min(float(width) / clip.width, MAX_ZOOM)
    pm = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
    pm.save(out_png, output="png")  # explicit: the gateway writes to a temporary name first
    return {"w": pm.width, "h": pm.height, "dpi": round(zoom * 72)}



# ---------------- any-file reading (Word, Excel, text, photos, saved emails) ----------------
# Only ever reads. Nothing in a file is run: no macros (openpyxl never runs them), no links followed, no scripts.
WORDS_PER_PART = 1500
MAX_CHARS = 2_000_000
MAX_ROWS, MAX_COLS = 2000, 50


def _chunks(text, label_base):
    words = text.split()
    if not words:
        return []
    parts = []
    for i in range(0, len(words), WORDS_PER_PART):
        n = i // WORDS_PER_PART + 1
        parts.append({"label": f"{label_base} {n}" if len(words) > WORDS_PER_PART else label_base, "text": " ".join(words[i:i + WORDS_PER_PART])})
    return parts


def _is_ole(path):
    with open(path, "rb") as fh:
        return fh.read(8) == bytes.fromhex("D0CF11E0A1B11AE1")


def extract_docx(path):
    import docx  # python-docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    d = docx.Document(path)
    parts, cur_label, cur = [], "Start", []

    def flush():
        text = "\n".join(cur).strip()
        if text:
            parts.extend(_chunks(text, cur_label) if len(text.split()) > WORDS_PER_PART else [{"label": cur_label, "text": text}])

    for block in d.element.body.iterchildren():
        tag = block.tag.split("}")[-1]
        if tag == "p":
            p = Paragraph(block, d)
            style = (p.style.name if p.style is not None else "") or ""
            if style.startswith("Heading 1") or style.startswith("Heading 2") or style == "Title":
                flush()
                cur_label, cur = (p.text.strip() or cur_label), []
            elif p.text.strip():
                cur.append(p.text)
        elif tag == "tbl":
            t = Table(block, d)
            for row in t.rows:
                cur.append("\t".join(c.text.strip() for c in row.cells))
    flush()
    return {"parts": parts or [{"label": "Document", "text": ""}]}


def extract_xlsx(path):
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    parts = []
    for ws in wb.worksheets:
        grid = []
        cut = False
        for r, row in enumerate(ws.iter_rows(values_only=True)):
            if r >= MAX_ROWS:
                cut = True
                break
            cells = ["" if v is None else (v.strftime("%d/%m/%Y") if hasattr(v, "strftime") else str(v)) for v in row[:MAX_COLS]]
            grid.append(cells)
        # drop trailing empty rows and columns
        while grid and not any(c.strip() for c in grid[-1]):
            grid.pop()
        width = max((max((i + 1 for i, c in enumerate(r) if c.strip()), default=0) for r in grid), default=0)
        grid = [r[:width] + [""] * (width - len(r[:width])) for r in grid]
        text = "\n".join("\t".join(r) for r in grid)
        parts.append({"label": ws.title + (" (first 2,000 rows)" if cut else ""), "text": text, "grid": grid})
    wb.close()
    return {"parts": parts or [{"label": "Workbook", "text": ""}]}


def extract_text(path):
    raw = open(path, "rb").read(MAX_CHARS * 2)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    return {"parts": _chunks(text[:MAX_CHARS], "Part") or [{"label": "Text", "text": ""}]}


def extract_eml(path):
    from email import policy
    from email.parser import BytesParser

    with open(path, "rb") as fh:
        msg = BytesParser(policy=policy.default).parse(fh)
    body = msg.get_body(preferencelist=("plain", "html"))
    text = body.get_content() if body is not None else ""
    if body is not None and body.get_content_type() == "text/html":
        text = re.sub(r"<[^>]+>", " ", text)
    attachments = [a.get_filename() for a in msg.iter_attachments() if a.get_filename()]
    head = "\n".join(f"{k}: {msg.get(k, '')}" for k in ("From", "To", "Date", "Subject"))
    full = head + "\n\n" + text.strip() + (("\n\nAttachments: " + ", ".join(attachments)) if attachments else "")
    return {"parts": [{"label": msg.get("Subject", "Email") or "Email", "text": full[:MAX_CHARS]}], "meta": {"from": str(msg.get("From", "")), "date": str(msg.get("Date", "")), "subject": str(msg.get("Subject", ""))}}


def _open_image(path):
    from PIL import Image, ImageOps

    try:
        import pillow_heif  # noqa: F401  (registers HEIC)

        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001
        pass
    im = Image.open(path)
    return ImageOps.exif_transpose(im)


def extract_image(path):
    im = _open_image(path)
    meta = {"w": im.width, "h": im.height}
    try:
        exif = im.getexif()
        taken = exif.get(36867) or exif.get(306)
        if taken:
            meta["taken_at"] = str(taken)
    except Exception:  # noqa: BLE001
        pass
    return {"parts": [], "meta": meta}


OLD_FORMATS = {
    ".doc": "Old Word format. Save it as .docx and I can read it.",
    ".xls": "Old Excel format. Save it as .xlsx and I can read it.",
    ".ppt": "PowerPoint isn't something I read yet.",
    ".pptx": "PowerPoint isn't something I read yet.",
    ".msg": "Outlook .msg files aren't something I read. Save the email as .eml instead.",
}


def extract(path, kind):
    """Text and tables from one file, or {"skipped": reason}. kind: docx | xlsx | text | eml | image | old."""
    ext = os.path.splitext(path)[1].lower()
    if kind == "old" or ext in OLD_FORMATS:
        return {"skipped": OLD_FORMATS.get(ext, "I can't read this kind of file.")}
    if os.path.getsize(path) > 100 * 1024 * 1024:
        return {"skipped": "Too big (over 100 MB)."}
    try:
        if kind in ("docx", "xlsx") and _is_ole(path):
            return {"skipped": "Password protected."}
        if kind == "docx":
            return extract_docx(path)
        if kind == "xlsx":
            return extract_xlsx(path)
        if kind == "text":
            return extract_text(path)
        if kind == "eml":
            return extract_eml(path)
        if kind == "image":
            return extract_image(path)
    except Exception as e:  # noqa: BLE001
        return {"skipped": f"Couldn't open it ({type(e).__name__})."}
    return {"skipped": "I can't read this kind of file."}


def image_for_screen(src, out, width):
    """A photo straightened, resized to `width` at most, saved as JPEG with no EXIF (no location, no camera details)."""
    im = _open_image(src).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)))
    im.save(out, format="JPEG", quality=84, optimize=True)
    return {"w": im.width, "h": im.height}


# ---------------- reference books (Stage 8): read once into the shelf index ----------------
# Only ever reads. A book is streamed out one JSON line at a time (the book, then one line per page), so a
# 2,700-page book is never held in memory and the gateway can write it in batches.


def ref_index(pdf):
    """Print {"book": {...}} with the page count, title and table of contents, then {"page": n, "text": ...} per
    page (n counted from 1). A copy that won't open, or is locked, prints {"error": reason} instead."""
    out = sys.stdout
    try:
        doc = pymupdf.open(pdf)
    except Exception as e:  # noqa: BLE001
        out.write(json.dumps({"error": "unreadable", "detail": type(e).__name__}) + "\n")
        return
    if doc.needs_pass or doc.is_encrypted:
        out.write(json.dumps({"error": "locked"}) + "\n")
        return
    toc = [[int(level), str(title).strip(), int(page)] for level, title, page in doc.get_toc(simple=True)]
    title = (doc.metadata or {}).get("title") or ""
    out.write(json.dumps({"book": {"pages": doc.page_count, "title": str(title).strip(), "toc": toc}}) + "\n")
    for i in range(doc.page_count):
        try:
            text = doc[i].get_text()
        except Exception:  # noqa: BLE001 - one bad page must not stop the book
            text = ""
        out.write(json.dumps({"page": i + 1, "text": text}) + "\n")
    out.flush()


def image_crop(src, out, box, longest=1568):
    """Part of a photo (box: 0..1 fractions of the upright photo) at full sharpness, at most `longest` px on its long
    side, saved as JPEG with no EXIF. For reading a tape, a label or a stamp too small in the whole photo."""
    im = _open_image(src).convert("RGB")
    x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in box]
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        raise ValueError("empty box")
    part = im.crop((round(x0 * im.width), round(y0 * im.height), round(x1 * im.width), round(y1 * im.height)))
    if max(part.width, part.height) > longest:
        k = longest / max(part.width, part.height)
        part = part.resize((max(1, round(part.width * k)), max(1, round(part.height * k))))
    part.save(out, format="JPEG", quality=90)
    return {"w": part.width, "h": part.height}


def serve():
    """Long-lived worker for the gateway: one JSON request per line on stdin, one JSON reply per line on stdout.
    {"id", "op": "render", "pdf", "page", "box", "out", "width"} -> {"id", "ok": true, "w", "h", "dpi"}
    Any failure is a reply with ok false and an error; the worker keeps going."""
    from collections import OrderedDict

    docs = OrderedDict()  # the 8 most recently used PDFs stay open

    def open_doc(path):
        if path in docs:
            docs.move_to_end(path)
            return docs[path]
        d = pymupdf.open(path)
        docs[path] = d
        while len(docs) > 8:
            docs.popitem(last=False)[1].close()
        return d

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            if req.get("op") == "render":
                out = render_region(open_doc(req["pdf"]), int(req["page"]), req["box"], req["out"], req["width"])
                reply = {"id": rid, "ok": True, **out}
            elif req.get("op") == "extract":
                reply = {"id": rid, "ok": True, **extract(req["path"], req["kind"])}
            elif req.get("op") == "image":
                reply = {"id": rid, "ok": True, **image_for_screen(req["src"], req["out"], int(req["width"]))}
            elif req.get("op") == "image_crop":
                reply = {"id": rid, "ok": True, **image_crop(req["src"], req["out"], req["box"])}
            elif req.get("op") == "size":
                r = open_doc(req["pdf"])[int(req["page"])].rect
                reply = {"id": rid, "ok": True, "w": r.width, "h": r.height}
            elif req.get("op") == "ping":
                reply = {"id": rid, "ok": True}
            else:
                reply = {"id": rid, "ok": False, "error": f"unknown op {req.get('op')!r}"}
        except Exception as e:  # noqa: BLE001 - a bad request must never stop the worker
            reply = {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(reply) + chr(10))
        sys.stdout.flush()


if __name__ == "__main__":
    a = sys.argv
    if len(a) >= 2 and a[1] == "serve":
        serve()
    elif len(a) >= 3 and a[1] == "ref_index":
        ref_index(a[2])
    elif len(a) >= 4 and a[1] == "ingest":
        ingest(a[2], a[3])
    elif len(a) >= 9 and a[1] == "crop":
        crop(a[2], int(a[3]), *map(float, a[4:8]), a[8], int(a[9]) if len(a) > 9 else 1568)
    else:
        print(__doc__)
        sys.exit(2)
