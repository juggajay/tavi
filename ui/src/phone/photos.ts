// Photos from the phone (Stage 8.4): the camera button in the type row picks up to four pictures; each is shrunk to at
// most 2,560 px on its long side as a JPEG (upright, and without the camera's location details), sent at once to
// /api/v2/upload?as=photo, and shown as a small thumbnail above the type field with a progress ring, then a tick.
// Typed words go with the photos as one message. A photo alone starts nothing: it waits for the owner to ask.

export type Shot = { key: number; url: string; blob: Blob; state: "sending" | "done" | "failed"; progress: number; file?: string; w: number; h: number; sent?: boolean; req?: Promise<void> };

const MAX = 4;
const LONG = 2560;
const RING = 2 * Math.PI * 15;
export const NOT_A_PHOTO = "That isn't a photo.";
export const FAILED = "Couldn't send the photo. Tap to try again.";

/** The photo upright (browsers apply its EXIF turn when drawing an <img>), at most 2,560 px long, as a JPEG. */
async function shrink(file: Blob): Promise<{ blob: Blob; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, LONG / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k),
      h = Math.round(img.naturalHeight * k);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.86));
    if (!blob) throw new Error("no blob");
    return { blob, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Post a picture (a photo, or a sketch from the pad) with upload progress. Resolves with the file id it was saved as. */
export function postPicture(blob: Blob, as: "photo" | "sketch", onProgress: (f: number) => void, over?: string): Promise<{ file: string; name: string }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/v2/upload?as=${as}${over ? `&over=${encodeURIComponent(over)}` : ""}`);
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status !== 200) return reject(new Error(x.status === 400 ? "refused" : `status ${x.status}`));
      try {
        resolve(JSON.parse(x.responseText));
      } catch (e) {
        reject(e as Error);
      }
    };
    x.onerror = () => reject(new Error("offline"));
    x.send(blob);
  });
}

export function createShots(host: HTMLElement, o: { say: (text: string) => void; onOpen: (s: Shot) => void }) {
  let shots: Shot[] = [];
  let n = 0;

  function render() {
    host.hidden = !shots.length;
    host.innerHTML = shots
      .map(
        (s) =>
          `<button class="snap ${s.state}" type="button" data-k="${s.key}" aria-label="${s.state === "failed" ? FAILED : s.state === "done" ? "Photo sent. Tap to draw on it." : "Sending the photo"}"><img src="${s.url}" alt="">` +
          (s.state === "sending" ? `<svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15"/><circle class="p" cx="18" cy="18" r="15" stroke-dasharray="${RING}" stroke-dashoffset="${RING * (1 - s.progress)}"/></svg>` : "") +
          (s.state === "done" ? `<span class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>` : "") +
          (s.state === "failed" ? `<span class="bang">!</span>` : "") +
          `</button>`,
      )
      .join("");
  }

  function send(s: Shot) {
    s.state = "sending";
    s.progress = 0;
    render();
    s.req = postPicture(s.blob, "photo", (f) => {
      s.progress = f;
      const ring = host.querySelector<SVGCircleElement>(`[data-k="${s.key}"] .p`);
      ring?.setAttribute("stroke-dashoffset", String(RING * (1 - f)));
    })
      .then((r) => {
        s.file = r.file;
        s.state = "done";
      })
      .catch(() => {
        s.state = "failed";
        o.say(FAILED);
      })
      .finally(render);
  }

  host.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-k]");
    const s = b && shots.find((x) => x.key === Number(b.dataset.k));
    if (!s) return;
    if (s.state === "failed") send(s);
    else if (s.state === "done") o.onOpen(s);
  });

  return {
    /** Photos picked with the camera button: at most four at a time, pictures only. */
    async add(files: FileList | File[]) {
      const list = [...files];
      const pictures = list.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
      if (pictures.length < list.length) o.say(NOT_A_PHOTO);
      const room = MAX - shots.filter((s) => !s.sent).length;
      if (pictures.length > room) o.say("Four at a time.");
      for (const f of pictures.slice(0, Math.max(0, room))) {
        let blob: Blob = f;
        let w = 0,
          h = 0;
        try {
          ({ blob, w, h } = await shrink(f));
        } catch {
          blob = f; // couldn't shrink it here: send the original
        }
        const s: Shot = { key: ++n, url: URL.createObjectURL(blob), blob, state: "sending", progress: 0, w, h };
        shots.push(s);
        send(s);
      }
      render();
    },
    /** Once every photo still sending is in: the ids to go with the next message (each goes with one message only). */
    async forMessage(): Promise<string[]> {
      await Promise.all(shots.filter((s) => s.state === "sending").map((s) => s.req));
      const ids = shots.filter((s) => s.state === "done" && !s.sent).map((s) => s.file!);
      shots.forEach((s) => s.state === "done" && (s.sent = true));
      return ids;
    },
    /** The answer came: sent thumbnails go; one that failed stays so it can be tried again. */
    clearSent() {
      const keep = shots.filter((s) => s.state === "failed" || s.state === "sending");
      for (const s of shots) if (!keep.includes(s)) URL.revokeObjectURL(s.url);
      shots = keep;
      render();
    },
    get count() {
      return shots.length;
    },
  };
}
