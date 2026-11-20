# One A4 page for a proposal (Stage 9.6b), made from a model's polished pictures: the hero picture large, the pulled-apart
# picture and one dimensioned view below, the title, up to six short lines in the owner's own words, and the date. No
# logo, prices or terms, and nothing about strength or compliance. Run with the repo's .venv Python (PyMuPDF):
#   python -I render/proposal.py <spec.json>
# spec: { "out": path.pdf, "title": str, "lines": [str], "date": str, "hero": png, "apart": png?, "dims": png? }
import json
import os
import sys

import fitz  # PyMuPDF

spec = json.load(open(sys.argv[1], encoding="utf-8"))
W, H = fitz.paper_size("a4")  # points
M = 46  # margin
doc = fitz.open()
page = doc.new_page(width=W, height=H)
REG = r"C:\Windows\Fonts\segoeui.ttf"
BOLD = r"C:\Windows\Fonts\seguisb.ttf"
if os.path.exists(REG) and os.path.exists(BOLD):
    page.insert_font(fontname="ui", fontfile=REG)
    page.insert_font(fontname="uib", fontfile=BOLD)
    reg, bold = "ui", "uib"
else:
    reg, bold = "helv", "hebo"
ink = (0.11, 0.12, 0.13)
soft = (0.42, 0.44, 0.46)


def picture(path, rect):
    """A picture fitted into rect without stretching, centred."""
    pix = fitz.Pixmap(path)
    k = min(rect.width / pix.width, rect.height / pix.height)
    w, h = pix.width * k, pix.height * k
    r = fitz.Rect(rect.x0 + (rect.width - w) / 2, rect.y0 + (rect.height - h) / 2, rect.x0 + (rect.width + w) / 2, rect.y0 + (rect.height + h) / 2)
    page.insert_image(r, filename=path)
    return r


y = M
page.insert_text((M, y + 22), spec["title"][:80], fontname=bold, fontsize=21, color=ink)
page.insert_text((M, y + 42), spec.get("date", ""), fontname=reg, fontsize=10.5, color=soft)
y += 62
hero = picture(spec["hero"], fitz.Rect(M, y, W - M, y + (W - 2 * M) * 2 / 3))
y = hero.y1 + 14
small = [p for p in (spec.get("apart"), spec.get("dims")) if p and os.path.exists(p)]
if small:
    gap = 14
    cw = (W - 2 * M - gap * (len(small) - 1)) / len(small)
    ch = cw * 2 / 3
    bottom = y
    for i, p in enumerate(small):
        r = picture(p, fitz.Rect(M + i * (cw + gap), y, M + i * (cw + gap) + cw, y + ch))
        bottom = max(bottom, r.y1)
    y = bottom + 22
lines = [str(l).strip()[:140] for l in spec.get("lines", []) if str(l).strip()][:6]
if lines:
    box = fitz.Rect(M, y, W - M, H - M)
    text = "\n".join(lines)
    page.insert_textbox(box, text, fontname=reg, fontsize=11.5, color=ink, lineheight=1.45)
doc.set_metadata({"title": spec["title"][:80], "creator": "Tavi"})
doc.save(spec["out"], garbage=3, deflate=True)
print("SAVED pdf", spec["out"], flush=True)
