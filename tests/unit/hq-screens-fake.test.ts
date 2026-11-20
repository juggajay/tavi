import "../isolate.js";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { ByteQueue, PIXELS, VERSION, u32, vncAuthResponse } from "../../src/hq/screens/rfb.js";

export async function fakeScreen() {
  const sockets = new Set<Socket>();
  let connections = 0, keys = 0;
  const password = "test1234", width = 80, height = 48;
  const init = Buffer.alloc(24); init.writeUInt16BE(width); init.writeUInt16BE(height, 2); PIXELS.copy(init, 4);
  const rect = Buffer.alloc(12); rect.writeUInt16BE(width, 4); rect.writeUInt16BE(height, 6);
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 180; pixels[i + 1] = i % 128 < 64 ? 80 : 220; pixels[i + 2] = 40; }
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1]), rect, pixels]);
  const server = createServer(socket => {
    connections++; sockets.add(socket);
    const q = new ByteQueue(); socket.on("data", (b: Buffer) => q.push(b)); socket.on("error", () => q.close());
    socket.once("close", () => { sockets.delete(socket); q.close(); });
    void (async () => {
      socket.write(VERSION); assert.deepEqual(await q.read(12), VERSION);
      socket.write(Buffer.from([1, 2])); await q.read(1);
      const challenge = Buffer.alloc(16, 7); socket.write(challenge);
      assert.deepEqual(await q.read(16), vncAuthResponse(password, challenge));
      socket.write(u32(0)); await q.read(1); socket.write(init);
      for (;;) {
        const type = (await q.read(1))[0];
        if (type === 0) await q.read(19);
        else if (type === 2) { const h = await q.read(3); await q.read(h.readUInt16BE(1) * 4); }
        else if (type === 3) { await q.read(9); await new Promise(r => setTimeout(r, 15)); if (!socket.destroyed) socket.write(frame); }
        else if (type === 4) { await q.read(7); keys++; }
        else if (type === 5) await q.read(5);
        else throw new Error("The test screen received an unknown message.");
      }
    })().catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, password,
    get connections() { return connections; }, get keys() { return keys; },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); } };
}
