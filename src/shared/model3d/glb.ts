// A model as a GLB file plus a small JSON beside it (Stage 9.6b), written on the server from the same shapes the app
// shows, for Blender to make polished pictures from. Each part is a node at its place in the model, with its mesh in the
// part's own frame, so in Blender a part's grain runs along its own x, y or z. glTF wants metres and y up; Blender's
// importer turns it back to z up. Each part has two primitives: its long-grain (or ply face) triangles and its end-grain
// (or ply edge) ones. The JSON carries what a GLB can't say plainly: materials, grain, how each part pulls apart, sizes.
import type { ModelPayload } from "../protocol.js";
import { type V3, apply, applyDir, invert } from "./math.js";
import { buildModel } from "./build.js";

const toGl = (v: V3, k = 1): [number, number, number] => [v[0] * k, v[2] * k, -v[1] * k];

export type ModelJson = {
  title: string;
  note?: string;
  parts: { id: string; name: string; material: string; grain: "x" | "y" | "z"; apart: V3; size_mm: V3 }[];
  dims: { a: V3; b: V3; text?: string; part?: string; show?: "together" | "apart" }[];
  bbox: { min: V3; max: V3 };
};

export function modelFiles(m: ModelPayload, title: string): { glb: Uint8Array; json: ModelJson } {
  const built = buildModel(m, { mesh: true });
  const bin: Uint8Array[] = [];
  let binLen = 0;
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const add = (data: Float32Array) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    views.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.byteLength });
    bin.push(bytes);
    binLen += bytes.byteLength;
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) (bin.push(new Uint8Array(pad)), (binLen += pad));
    return views.length - 1;
  };
  built.parts.forEach((p) => {
    if (!p.mesh) return;
    const inv = invert(p.frame);
    const n = p.mesh.positions.length / 3;
    const pos = new Float32Array(n * 3),
      nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const q = toGl(apply(inv, [p.mesh.positions[i * 3], p.mesh.positions[i * 3 + 1], p.mesh.positions[i * 3 + 2]]), 0.001);
      const r = toGl(applyDir(inv, [p.mesh.normals[i * 3], p.mesh.normals[i * 3 + 1], p.mesh.normals[i * 3 + 2]]));
      pos.set(q, i * 3);
      nrm.set(r, i * 3);
    }
    const prims = p.mesh.groups.map((g) => {
      const slice = (a: Float32Array, k: number) => a.slice(g.start * k, (g.start + g.count) * k);
      const ps = slice(pos, 3);
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ps.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], ps[i + k])), (max[k] = Math.max(max[k], ps[i + k]));
      accessors.push({ bufferView: add(ps), componentType: 5126, count: g.count, type: "VEC3", min, max });
      const posAcc = accessors.length - 1;
      accessors.push({ bufferView: add(slice(nrm, 3)), componentType: 5126, count: g.count, type: "VEC3" });
      const nAcc = accessors.length - 1;
      accessors.push({ bufferView: add(slice(p.mesh!.uvs, 2)), componentType: 5126, count: g.count, type: "VEC2" });
      const uvAcc = accessors.length - 1;
      materials.push({ name: `${p.id}:${g.mat}`, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.65, 0.45, 1], metallicFactor: 0, roughnessFactor: 0.6 } });
      return { attributes: { POSITION: posAcc, NORMAL: nAcc, TEXCOORD_0: uvAcc }, material: materials.length - 1, mode: 4 };
    });
    meshes.push({ name: p.name, primitives: prims });
    // the part's place in the model, as glTF's column-major matrix, turned to y up: M = C · [R | t] · Cᵀ
    const r = p.frame.r,
      t = p.frame.t;
    const C = [1, 0, 0, 0, 0, 1, 0, -1, 0]; // (x, y, z) → (x, z, -y)
    const mul = (a: number[], b: number[]) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
    const Ct = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const R = mul(mul(C, r), Ct);
    const T = toGl(t, 0.001);
    const matrix = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, T[0], T[1], T[2], 1];
    nodes.push({ name: p.name, mesh: meshes.length - 1, matrix, extras: { part_id: p.id, material: p.material, grain: p.grain } });
  });
  const gltf = {
    asset: { version: "2.0", generator: "Tavi" },
    scene: 0,
    scenes: [{ name: title, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: binLen }],
  };
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(gltf));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const j = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    j.set(jsonBytes);
    jsonBytes = j;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true); // BIN
  o += 8;
  for (const b of bin) (out.set(b, o), (o += b.byteLength));
  const mm = (v: V3): V3 => [v[0] / 1000, v[1] / 1000, v[2] / 1000];
  const json: ModelJson = {
    title,
    ...(m.note ? { note: m.note } : {}),
    parts: built.parts.map((p) => ({ id: p.id, name: p.name, material: p.material, grain: p.grain, apart: mm(p.apart), size_mm: p.size })),
    dims: (m.dims ?? []).map((d) => ({ a: mm(d.a), b: mm(d.b), ...(d.text ? { text: d.text } : {}), ...(d.part ? { part: d.part } : {}), ...(d.show ? { show: d.show } : {}) })),
    bbox: { min: mm(built.bbox.min), max: mm(built.bbox.max) },
  };
  return { glb: out, json };
}

/** Read a GLB's JSON part back (for checks): its nodes and meshes. */
export function readGlbJson(b: Uint8Array): { nodes?: { name?: string; mesh?: number; extras?: Record<string, unknown> }[]; meshes?: unknown[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len)));
}
