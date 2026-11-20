import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { checkFacts, printChecks } from './checks.mjs';
import { boxFiles, boxHash, transferScript, installBase, engineScript, installScreens, checkBox } from './box.mjs';
import { checkDataFolder } from '../v3-dev.mjs';

export function readState(folder) {
  try { return JSON.parse(readFileSync(path.join(folder, 'setup-state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { done: {} }; throw new Error('The setup record cannot be read. Keep it and have it repaired before continuing.'); }
}
export function saveJson(file, value) {
  for (const candidate of [file, file + '.new']) if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink())
    throw new Error('Settings files must not be file links.');
  writeFileSync(file + '.new', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(file + '.new', file);
}
export function dataPath(root, folder) {
  const relative = path.relative(root, folder);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      ['src', 'ui', 'scripts', 'box', 'desktop', 'tests', 'docs', 'public', 'node_modules', '.git'].includes(relative.split(path.sep)[0]))
    throw new Error('Choose a separate data folder inside this project, such as data or data-v3.');
  for (let current = folder; current !== root; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('The data folder and its parents must not be file links.');
  }
}
function hashTree(root, folders) {
  const hash = createHash('sha256');
  const visit = (file, name) => {
    if (!existsSync(file)) return;
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error('Setup inputs must not be file links.');
    if (info.isDirectory()) {
      for (const child of readdirSync(file).sort()) {
        if (['node_modules', 'dist', 'dist-tavi', 'app-config.json'].includes(child)) continue;
        visit(path.join(file, child), name + '/' + child);
      }
    } else hash.update(name + '\0').update(readFileSync(file)).update('\0');
  };
  for (const name of folders) visit(path.join(root, name), name);
  return hash.digest('hex');
}
export async function install(root, config, options, ops, print) {
  dataPath(root, config.folder);
  if (config.run.mode === 'practice') checkDataFolder(config.folder, root);
  let state = readState(config.folder);
  if (state.distro && state.distro !== config.run.distro) throw new Error('This data folder belongs to another Linux space. Keep its name or choose a new data folder.');
  const facts = await ops.inspect(state);
  if (facts.pendingSpaceId) { state.spaceId = facts.pendingSpaceId; delete state.creating; }
  const rows = checkFacts(facts, config, state, { live: true, adopt: options.adopt });
  const passed = printChecks(rows, print);
  if (options.check) return passed ? 0 : 1;
  if (!passed) throw new Error('Setup stopped before changing anything. Follow the STOP lines, then run the same command again.');
  const files = boxFiles(root), box = boxHash(files);
  const existingSpace = facts.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase());
  if (!existingSpace) {
    for (const name of ['transfer', 'base', 'engine', 'screens', 'checks']) delete state.done[name];
  }
  let installer;
  if (options.engineInstaller) {
    const file = path.resolve(root, options.engineInstaller);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.startsWith('scripts' + path.sep + 'setup' + path.sep) || !file.endsWith('.sh'))
      throw new Error('Put the reviewed public engine installer in scripts/setup with a .sh ending; give its path with --engine-installer.');
    for (let current = file; current !== root; current = path.dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('The reviewed installer and its folders must not be file links.');
    }
    installer = readFileSync(file);
  }
  if (!state.done?.engine && !installer) throw new Error('Before setup can continue, have your helper obtain and read https://hermes-agent.nousresearch.com/install.sh. Save that public script in scripts/setup/hermes-installer.sh, then run setup --engine-installer scripts/setup/hermes-installer.sh. No sign-in is needed.');
  // Check-only ends above: no folder, record, lock or program is made by it.
  mkdirSync(config.folder, { recursive: true, mode: 0o700 });
  const lock = path.join(config.folder, 'setup.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); }
  catch { throw new Error('Another setup or update may be running. Check the process number in setup.lock; remove that file only when that process has stopped.'); }
  const file = path.join(config.folder, 'setup-state.json');
  state = { ...state, distro: config.run.distro, done: state.done || {} };
  const save = () => saveJson(file, state);
  const step = async (id, title, hash, action) => {
    if (state.done[id] === hash && (!ops.stepPresent || await ops.stepPresent(id))) { print(`DONE: ${title}`); return; }
    print(`START: ${title}`); state.step = id; save();
    try { await action(); state.done[id] = hash; delete state.failure; save(); print(`OK: ${title}`); }
    catch (error) { state.failure = `Stopped at: ${title}. Run the same setup command after fixing the reported failure.`; save(); throw new Error(`${state.failure}\n${error.message}`); }
  };
  try {
    await ops.stop();
    save();
    // Save the chosen mode before any app is launched. Existing settings are never replaced by defaults.
    saveJson(path.join(config.folder, 'run.json'), config.run);
    const packages = hashTree(root, ['package.json', 'package-lock.json', 'ui/package.json', 'ui/package-lock.json', 'desktop/package.json', 'desktop/package-lock.json']);
    for (const folder of ['', 'ui', 'desktop']) {
      const prefix = folder ? folder + '/' : '';
      await step('packages-' + (folder || 'root'), `Install ${folder || 'project'} packages from the lock file.`,
        hashTree(root, [prefix + 'package.json', prefix + 'package-lock.json']), () => ops.npm(folder, ['ci', '--no-audit', '--no-fund']));
    }
    const code = hashTree(root, ['src', 'ui/src', 'ui/public', 'ui/vite.config.ts', 'scripts', 'desktop']);
    await step('build', 'Build the screens.', packages + code, () => ops.npm('ui', ['run', 'build']));
    await step('types', 'Check the code.', packages + code, () => ops.npm('', ['run', 'check']));
    await step('python', 'Install the tools that read documents and drawings.', hashTree(root, ['requirements.txt']), () => ops.python());
    const existing = facts.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase());
    if (!existing) {
      delete state.done.space; state.creating = true; save();
      await step('space', `Create Linux space ${config.run.distro}.`, config.run.distro, () => ops.createSpace());
      const after = await ops.inspect(state);
      state.spaceId = after.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase())?.id;
      if (!state.spaceId) throw new Error('The new Linux space could not be identified. Keep the setup record and run setup again.');
      delete state.creating; save();
    } else if (!state.spaceId) {
      await ops.adoptSpace(); state.spaceId = existing.id; save();
    }
    // End any remaining work through the space's own stop, never by killing a bot program by hand.
    await ops.terminateSpace();
    await step('transfer', 'Send the box files through a trusted pipe.', box, () => ops.linux(transferScript(files)));
    await step('base', 'Prepare the Linux space and install its safety files.', box, async () => {
      await ops.linux(installBase); await ops.terminateSpace();
    });
    const engineHash = installer ? createHash('sha256').update(installer).digest('hex') : state.done.engine;
    await step('engine', 'Install the pinned engine and its browser tools.', engineHash, () => ops.linux(engineScript(installer)));
    await step('screens', 'Install the bot computers and their programs.', box, () => ops.linux(installScreens));
    // These are always run, including on a repair. A record of an earlier pass is not a new pass.
    delete state.done.checks;
    await step('checks', `Restart only ${config.run.distro} and check the walls, screens and pinned engine.`, box, async () => {
      await ops.terminateSpace(); print(await ops.linux(checkBox));
    });
    await step('data', 'Keep the data private to this Windows user and system administrators.', config.folder, () => ops.permissions());
    await step('desktop', 'Build and install the Windows app for this user.', code + packages + JSON.stringify(config.run) + config.folder, () => ops.desktop());
    delete state.done.running;
    let voiceReady = false;
    await step('running', 'Start the keeper and check the app, safety switch and engines.', JSON.stringify(config.run), async () => {
      await ops.autostart();
      await ops.start();
      const live = await ops.waitLive();
      voiceReady = live.health?.voiceReady === true;
      if (!printChecks(live.rows, print)) throw new Error('Setup finished installing, but a live check failed. Read the logs and run doctor. Your data and safety level were kept.');
    });
    print(`Tavi is ready at http://127.0.0.1:${config.port}/desktop. Open Subscriptions and sign in yourself, set your safety PIN, then try a message. Mode: ${config.run.mode}. Voice: ${voiceReady ? 'ready' : 'off; add your optional voice key if wanted'}.`);
    print(`Logs: ${path.join(config.folder, 'logs')}. Optional voice settings: ${config.voiceFile} (OPENAI_API_KEY=your-own-key). Setup never opens this file.`);
    await ops.phone(); return 0;
  } finally { if (fd !== undefined) closeSync(fd); rmSync(lock, { force: true }); }
}
