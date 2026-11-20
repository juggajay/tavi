// Shared by the commands and the Windows app. This file never opens a key file.
const fs = require('node:fs');
const path = require('node:path');

function optional(file, read) {
  try { return JSON.parse(read(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${file}. Repair the settings before starting Tavi.`);
  }
}
function loadRun(source, root, read = fs.readFileSync) {
  const pointer = optional(path.join(root, 'desktop', 'app-config.json'), read);
  const legacy = optional(path.join(root, 'tavi-launch.json'), read);
  const folder = path.resolve(root, source.TAVI_DATA_DIR || source.LH_DATA_DIR || source.LH_V3_DATA || pointer?.data || legacy?.data || 'data');
  for (const key of ['LH_DATA_DIR', 'LH_V3_DATA']) {
    if (source[key] && path.resolve(root, source[key]).toLowerCase() !== folder.toLowerCase())
      throw new Error('Tavi and the safety switch must use the same data folder.');
  }
  const relative = path.relative(root, folder);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Keep this installation data inside this project. Choose a folder such as data or data-v3.');
  const saved = optional(path.join(folder, 'run.json'), read);
  const run = saved === undefined ? { port: Number(source.PORT || legacy?.port || 3077), distro: 'tavi-bots', mode: 'real', voice: false } : saved;
  if (!run || typeof run !== 'object' || Array.isArray(run) || Object.keys(run).some(key => !['port', 'distro', 'mode', 'voice', 'voiceFile'].includes(key)))
    throw new Error('run.json must contain only the port, distro, mode, voice and optional voiceFile settings.');
  if (!Number.isInteger(run.port) || run.port < 1 || run.port > 65535 || [3090, 3091].includes(run.port))
    throw new Error('Choose a free app port from 1 to 65535, other than 3090 and 3091, in run.json.');
  // The same rule as the safety switch (src/guard/runner.ts), so a person's own Linux can never be named here.
  if (typeof run.distro !== 'string' || !/^(?:lh-bots|tavi-[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?)$/.test(run.distro))
    throw new Error('In run.json, the Linux space name must start with tavi- and use small letters, numbers and dashes (for example tavi-bots).');
  if (!['real', 'practice'].includes(run.mode) || typeof run.voice !== 'boolean' ||
      (run.voiceFile !== undefined && (typeof run.voiceFile !== 'string' || !run.voiceFile.trim())))
    throw new Error('run.json needs mode real or practice, voice true or false, and an optional voiceFile path.');
  return { folder, port: run.port, host: '127.0.0.1', run, saved: saved !== undefined,
    voiceFile: path.resolve(folder, run.voiceFile || 'voice.env') };
}
function voiceKey(text) {
  // The optional file has one setting. Other settings cannot affect the app's start.
  const found = String(text).match(/^[ \t]*(?:export[ \t]+)?OPENAI_API_KEY[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#\r\n]*))[ \t]*(?:#.*)?$/m);
  return (found?.[1] ?? found?.[2] ?? found?.[3] ?? '').trim();
}
module.exports = { loadRun, voiceKey };
