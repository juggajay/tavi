# After a Blender render (Stage 9.6b): draws the sizes as clean dimension lines on the shots that asked for them (front,
# side), and makes a smaller JPG copy of every picture for email. Run with the repo's .venv Python:
#   python -I render/labels.py <folder>
# Reads <shot>.png and, if there, <shot>.dims.json (where each size's ends land in the picture, worked out by Blender).
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

folder = sys.argv[1]
FONTS = [r"C:\Windows\Fonts\seguisb.ttf", r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arial.ttf"]


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def label(im, spec):
    w, h = im.size
    k = w / 1920
    dark = spec.get("dark")
    ink = (240, 130, 67) if dark else (150, 62, 18)
    pill = (24, 26, 29, 230) if dark else (247, 246, 243, 235)
    over = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    f = font(round(30 * k))
    placed = []
    lines = []
    for dm in spec["dims"]:
        (ax, ay), (bx, by) = dm["a"], dm["b"]
        L = math.hypot(bx - ax, by - ay)
        if L < 8 * k:
            continue
        lines.append((ax, ay, bx, by, L, dm["text"]))
    # the same size shown twice the same way (a board's width at both ends): keep the one further out from the middle
    keep = []
    for ln in sorted(lines, key=lambda l: -math.hypot((l[0] + l[2]) / 2 - w / 2, (l[1] + l[3]) / 2 - h / 2)):
        dx, dy = (ln[2] - ln[0]) / ln[4], (ln[3] - ln[1]) / ln[4]
        if any(k[5] == ln[5] and abs(dx * (k[3] - k[1]) / k[4] - dy * (k[2] - k[0]) / k[4]) < 0.05 for k in keep):
            continue
        keep.append(ln)
    lines = keep
    for ax, ay, bx, by, L, _ in lines:
        nx, ny = -(by - ay) / L, (bx - ax) / L
        d.line([(ax, ay), (bx, by)], fill=ink, width=max(2, round(2.6 * k)))
        t = 11 * k
        for px, py in ((ax, ay), (bx, by)):
            d.line([(px - nx * t, py - ny * t), (px + nx * t, py + ny * t)], fill=ink, width=max(2, round(3.4 * k)))
    # labels, longest sizes first, kept off each other
    for ax, ay, bx, by, L, text in sorted(lines, key=lambda l: -l[4]):
        nx, ny = -(by - ay) / L, (bx - ax) / L
        tw = d.textlength(text, font=f) + 26 * k
        th = 46 * k
        spot = None
        for step in (0, 1, -1, 2, -2, 3, -3):
            cx = (ax + bx) / 2 + nx * step * th * 0.9
            cy = (ay + by) / 2 + ny * step * th * 0.9
            r = (cx - tw / 2, cy - th / 2, cx + tw / 2, cy + th / 2)
            if r[0] < 4 or r[1] < 4 or r[2] > w - 4 or r[3] > h - 4:
                continue
            if not any(r[0] < p[2] and p[0] < r[2] and r[1] < p[3] and p[1] < r[3] for p in placed):
                spot = r
                break
        if not spot:
            continue
        placed.append(spot)
        d.rounded_rectangle(spot, radius=th / 2, fill=pill)
        d.text(((spot[0] + spot[2]) / 2, (spot[1] + spot[3]) / 2), text, font=f, fill=ink, anchor="mm")
    return Image.alpha_composite(im.convert("RGBA"), over).convert("RGB")


for name in sorted(os.listdir(folder)):
    if not name.endswith(".png"):
        continue
    base = name[:-4]
    path = os.path.join(folder, name)
    im = Image.open(path).convert("RGB")
    spec_path = os.path.join(folder, base + ".dims.json")
    if os.path.exists(spec_path):
        with open(spec_path, encoding="utf-8") as fh:
            im = label(im, json.load(fh))
        im.save(path, optimize=True)
        os.remove(spec_path)
        print("LABELLED", path, flush=True)
    small = im.copy()
    small.thumbnail((1600, 1600))
    small.save(os.path.join(folder, base + ".jpg"), quality=84, optimize=True, progressive=True)
    print("JPG", os.path.join(folder, base + ".jpg"), flush=True)
