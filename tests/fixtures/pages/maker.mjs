import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
let prompt = ''; for await (const part of process.stdin) prompt += part;
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }) + '\n');
if (mode === 'fail' || mode === 'model' && process.argv.includes('-m')) { console.error('The chosen model is unavailable.'); process.exit(1); }
if (mode === 'signed_out') { console.error('Not signed in.'); process.exit(1); }
if (mode === 'timeout') {
  const marker = path.join(process.env.CODEX_HOME, 'child-survived');
  spawn(process.execPath, ['-e', `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'left running'),1800)`], { stdio: 'ignore', windowsHide: true });
  setTimeout(() => {}, 10000);
} else {
  const id = 'page-test-picture';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
  if (mode !== 'missing') {
    const dir = path.join(process.env.CODEX_HOME, 'generated_images', id); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  }
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
