// One command for installing and running Tavi. Importing it starts nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import configuration from './setup/config.cjs';
import { install, readState, dataPath } from './setup/install.mjs';
import { checkFacts, printChecks } from './setup/checks.mjs';
import { system } from './setup/system.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function argumentsFor(args) {
  const options = { word: args[0] || 'status' };
  if (!['setup', 'start', 'stop', 'restart', 'status', 'doctor', 'logs', 'update', 'uninstall'].includes(options.word))
    throw new Error('Use setup, start, stop, restart, status, doctor, logs, update or uninstall.');
  const flags = { '--data': 'data', '--port': 'port', '--distro': 'distro', '--mode': 'mode', '--engine-installer': 'engineInstaller' };
  for (let i = 1; i < args.length; i++) {
    const word = args[i];
    if (['--check', '--adopt', '--voice'].includes(word) && options.word === 'setup') options[word.slice(2)] = true;
    else if (word === 'erase' && options.word === 'uninstall' && !options.erase) options.erase = true;
    else if (flags[word] && args[i + 1] && !args[i + 1].startsWith('--') && options[flags[word]] === undefined &&
      (word === '--data' || options.word === 'setup' || options.word === 'update' && word === '--engine-installer')) options[flags[word]] = args[++i];
    else throw new Error('That option is not available. See public/INSTALL.md. Lasting data is removed only by uninstall erase.');
  }
  return options;
}
export async function main(args = process.argv.slice(2), supplied = {}) {
  const print = supplied.print || console.log, root = supplied.root || ROOT;
  try {
    const options = argumentsFor(args), source = { ...(supplied.source || process.env), ...(options.data ? { TAVI_DATA_DIR: options.data } : {}) };
    const config = configuration.loadRun(source, root, supplied.read);
    if (['setup', 'update'].includes(options.word)) {
      for (const name of ['port', 'distro', 'mode']) if (options[name] !== undefined) config.run[name] = name === 'port' ? Number(options[name]) : options[name];
      if (options.voice) config.run.voice = true;
      // Validate command choices through the same reader as every other start path.
      const chosen = configuration.loadRun({ TAVI_DATA_DIR: config.folder }, root, file => {
        if (file === path.join(config.folder, 'run.json')) return JSON.stringify(config.run);
        throw Object.assign(new Error(), { code: 'ENOENT' });
      }); Object.assign(config, chosen);
    }
    const ops = supplied.ops || system(root, config, print);
    switch (options.word) {
      case 'setup': return await install(root, config, options, ops, print);
      case 'start': {
        const state = await ops.live();
        if (state.rows.every(row => row.ok)) { print('Tavi is already running.'); return 0; }
        if (state.health) throw new Error('An app already answers on this port. Use status and stop before starting another keeper.');
        await ops.start(); return printChecks((await ops.waitLive()).rows, print) ? 0 : 1;
      }
      case 'stop': await ops.stop(); print('Tavi has stopped. Its data and safety level are kept.'); return 0;
      case 'restart': await ops.stop(); await ops.start(); return printChecks((await ops.waitLive()).rows, print) ? 0 : 1;
      case 'status': {
        const live = await ops.live();
        let spaceState = 'not checked';
        try { const facts = await ops.inspect(readState(config.folder)); spaceState = facts.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase())?.state || 'missing or unknown'; } catch {}
        print(`Tavi: ${live.health ? 'running' : 'stopped'}. Mode: ${config.run.mode}. Address: http://127.0.0.1:${config.port}.`);
        print(`Linux space: ${config.run.distro} (${spaceState}). Safety switch: ${live.hq?.guard || 'not answering'}; level: ${live.hq?.safety?.level || 'unknown'}.`);
        for (const bot of live.hq?.bots || []) print(`${bot.name}: ${bot.engine}; ${bot.primary?.provider || 'service not set'}; ${live.engines?.[bot.id]?.status || 'not answering'}.`);
        try { print(`Last error or change: ${JSON.parse(readFileSync(path.join(config.folder, 'logs/tavi-status.json'), 'utf8')).reason}`); } catch { print('No saved app error or change.'); }
        const state = readState(config.folder); if (state.failure) print(state.failure);
        for (const line of await ops.lastErrors?.() || []) print(line);
        return 0;
      }
      case 'doctor': {
        const state = readState(config.folder), facts = await ops.inspect(state);
        const first = printChecks(checkFacts(facts, config, state, { live: true }), print);
        const second = printChecks((await ops.live()).rows, print); return first && second ? 0 : 1;
      }
      case 'logs': await ops.logs(); return 0;
      case 'update':
        await ops.cleanCode(); await ops.stop(); await ops.pull();
        // Re-enter the new command after pulling so updated setup code is used too.
        if (supplied.ops) return await install(root, config, options, ops, print);
        await ops.run(process.execPath, [path.join(root, 'scripts/tavi.mjs'), 'setup', '--data', config.folder,
          ...(options.engineInstaller ? ['--engine-installer', options.engineInstaller] : [])]); return 0;
      case 'uninstall': {
        const state = readState(config.folder);
        if (options.erase) {
          print(`ERASE: ${config.run.distro} will be removed with all bot files, downloads and subscription sign-ins. ${config.folder} will be removed with all conversations, memory, settings and logs. Keep a backup before using this command.`);
          dataPath(root, config.folder);
          if (state.distro !== config.run.distro) throw new Error('This data folder has no matching installation record. Nothing lasting was removed.');
          const facts = await ops.inspect(state), chosen = facts.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase());
          if (chosen && chosen.id !== state.spaceId) throw new Error('Ownership of the chosen Linux space cannot be proved. Nothing lasting was removed.');
        }
        await ops.stop(); await ops.autostart(true); await ops.removeDesktop();
        if (options.erase) { await ops.unregister(); await ops.removeData(); }
        else print(`The program and its sign-in entry were removed. Linux space ${config.run.distro} and data ${config.folder} were kept. To lose them permanently, use uninstall erase. Bot files, sign-ins, conversations and memory will be lost.`);
        return 0;
      }
    }
  } catch (error) { print(error.message || 'The command could not finish. Read public/INSTALL.md.'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) process.exitCode = await main();
