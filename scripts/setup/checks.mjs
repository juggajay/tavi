// Checks collect facts first. None of these steps enables a Windows feature.
export const GiB = 1024 ** 3;
export function checkFacts(facts, config, state, { live = false, adopt = false } = {}) {
  const rows = [];
  const add = (id, ok, line, fix) => rows.push({ id, ok: !!ok, line, fix });
  add('windows', facts.platform === 'win32' && facts.build >= 19045,
    'Windows 10 version 22H2 or Windows 11.', 'Run Windows Update. Windows build 19045 or later is needed.');
  add('node', facts.nodeMajor >= 24, 'Node 24 or later.', 'Install Node 24 from nodejs.org, then open a new terminal.');
  add('python', facts.python !== false, 'Python 3.10 or later (for reading documents and drawings).',
    'Install Python 3 from python.org with "Add python.exe to PATH" ticked, then open a new terminal.');
  add('features', facts.linuxFeature && facts.vmFeature, 'The Linux and virtual machine Windows features are on.',
    'In an administrator PowerShell run: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux,VirtualMachinePlatform -All; then restart Windows.');
  add('virtual', facts.virtualization, 'Virtual machine support is on.',
    'Restart into the PC firmware settings and enable Intel VT-x or AMD SVM. Ask the PC maker if the setting is hidden.');
  add('wsl', facts.wslMajor >= 2 && facts.kernel, 'The Linux tool and its WSL 2 kernel are installed.',
    'In an administrator terminal run wsl --install --no-distribution, then wsl --update and restart Windows.');
  add('disk', facts.diskFree >= 15 * GiB, 'At least 15 GB of disk space is free.', 'Free 15 GB on the drive holding this project, then run setup again.');
  add('memory', facts.memoryFree >= 2 * GiB && facts.memoryTotal >= 8 * GiB,
    'At least 8 GB of memory is fitted and 2 GB is free.', 'Close other programs to free 2 GB. This PC needs at least 8 GB fitted; 16 GB is better for several computers.');
  for (const port of [config.port, 3090, 3091]) add(`port-${port}`, facts.ports[port] || live && facts.ownedPorts?.includes(port),
    `Port ${port} is available to Tavi.`, `Stop the program using port ${port}. If it is this Tavi run, use node scripts/tavi.mjs stop first.`);
  const existing = facts.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase());
  add('space', !existing || existing.version === 2 && (state?.spaceId === existing.id || adopt),
    `Linux space ${config.run.distro}: ${existing ? state?.spaceId === existing.id ? 'belongs to this installation' : adopt ? 'will be checked before adoption' : 'ownership is not recorded' : 'will be created'}. Other spaces are left alone.`,
    'Choose another name with --distro. To keep an existing Tavi space, review it first and use setup --adopt; this requires its existing Tavi files. A WSL 1 space must be converted by its owner.');
  add('guard-name', facts.guardSupportsName, 'The safety switch accepts the chosen Linux space name.',
    'Choose a name starting with tavi- (for example --distro tavi-bots). The safety switch refuses any other name so that a personal Linux installation can never be touched.');
  return rows;
}
export function printChecks(rows, print) {
  for (const row of rows) print(`${row.ok ? 'OK' : 'STOP'}: ${row.line}${row.ok ? '' : ` Do this: ${row.fix}`}`);
  return rows.every(row => row.ok);
}
