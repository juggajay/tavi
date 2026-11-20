import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { freePort, stopSupervisor, safeOutput, sleep } from '../tavi-supervise.mjs';

export function execute(program, args, { cwd, env = process.env, input = '', timeout = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: { ...env, WSL_UTF8: '1' }, windowsHide: true, stdio: 'pipe' });
    let output = '', diagnostic = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    // Machine replies retain their identities. Only failure text is shown, after cleaning it.
    child.stdout.on('data', part => { output = (output + part).slice(-128000); });
    child.stderr.on('data', part => { diagnostic = (diagnostic + part).slice(-128000); });
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.once('error', () => { clearTimeout(timer); reject(new Error(`Cannot start ${path.basename(program)}. Check that it is installed.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.replace(/\0/g, '').trim());
      else {
        let clean = ''; const accept = safeOutput(line => { clean += line; }, env);
        accept(output + '\n' + diagnostic); accept.end();
        const lines = clean.trim().split(/\r?\n/);
        const failed = lines.find(line => /^FAIL\b/.test(line));
        reject(new Error(`${path.basename(program)} stopped (${code ?? 'time limit'}). ${failed ? failed + '\n' : ''}${lines.slice(-8).join('\n')}`));
      }
    });
  });
}
export function system(root, config, print = console.log, adapters = {}) {
  const run = (program, args, options = {}) => (adapters.execute || execute)(program, args, { cwd: root, ...options });
  const ps = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const linux = (script, user = 'root') => run('wsl.exe', ['-d', config.run.distro, '-u', user, '--', 'bash', '-s', '--'], { input: script });
  const npm = (folder, words) => run('cmd.exe', ['/d', '/s', '/c', ['npm', ...words].join(' ')], { cwd: path.join(root, folder) });
  const request = async route => {
    const reply = await fetch(`http://127.0.0.1:${config.port}${route}`, { headers: { Origin: `http://127.0.0.1:${config.port}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!reply.ok) throw new Error('The app did not answer.');
    return reply.json();
  };
  return {
    run, ps, linux, npm,
    // The tools that read documents and drawings are Python programs kept in this project's own .venv folder.
    async python() {
      const own = path.join(root, '.venv', 'Scripts', 'python.exe');
      if (!existsSync(own)) {
        try { await run('py.exe', ['-3', '-m', 'venv', '.venv']); }
        catch { await run('python.exe', ['-m', 'venv', '.venv']); }
      }
      await run(own, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', 'requirements.txt']);
    },
    async stepPresent(id) {
      if (id.startsWith('packages-')) {
        const folder = id.slice('packages-'.length);
        return existsSync(path.join(root, folder === 'root' ? '' : folder, 'node_modules/.package-lock.json'));
      }
      // The screens are built into web/dist (found on a real PC: looking in the wrong folder rebuilt them every run).
      if (id === 'build') return existsSync(path.join(root, 'web/dist/hq.html')) && existsSync(path.join(root, 'web/dist/phone.html'));
      if (id === 'python') return existsSync(path.join(root, '.venv/Scripts/python.exe'));
      if (id === 'desktop') return existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs/tavi-desktop/Tavi.exe'));
      return true;
    },
    async inspect(state) {
      const facts = { platform: adapters.platform || process.platform, nodeMajor: Number(process.versions.node.split('.')[0]),
        memoryFree: freemem(), memoryTotal: totalmem(), ports: {}, spaces: [], build: 0, diskFree: 0 };
      for (const port of [config.port, 3090, 3091]) facts.ports[port] = await (adapters.freePort || freePort)(port, port === 3090 ? '0.0.0.0' : '127.0.0.1');
      // The safety switch accepts the first space's name or any name starting with tavi-, and nothing else.
      facts.guardSupportsName = /^(?:lh-bots|tavi-[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?)$/.test(config.run.distro);
      facts.python = false;
      for (const [program, words] of [['py.exe', ['-3', '--version']], ['python.exe', ['--version']]]) {
        if (facts.python) break;
        try { const [, major, minor] = (await run(program, words, { timeout: 15000 })).match(/Python (\d+)\.(\d+)/) || []; facts.python = Number(major) === 3 && Number(minor) >= 10; } catch {}
      }
      if (facts.platform !== 'win32') return facts;
      // Read feature state without an administrator prompt. Do not start any Linux space to inspect it.
      const windows = JSON.parse(await ps(`$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$features = @(Get-CimInstance Win32_OptionalFeature)
$disk = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq ([IO.Path]::GetPathRoot($env:TAVI_PROJECT)).TrimEnd('\\') }
$spaces = @(Get-ChildItem HKCU:/Software/Microsoft/Windows/CurrentVersion/Lxss -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty -LiteralPath $_.PSPath; @{name=$p.DistributionName;id=$_.PSChildName;version=$p.Version;location=$p.BasePath} })
@{build=[int]$os.BuildNumber;diskFree=$disk.FreeSpace;virtualization=($cpu.VirtualizationFirmwareEnabled -or (Get-CimInstance Win32_ComputerSystem).HypervisorPresent);linuxFeature=!!($features | Where-Object {$_.Name -eq 'Microsoft-Windows-Subsystem-Linux' -and $_.InstallState -eq 1});vmFeature=!!($features | Where-Object {$_.Name -eq 'VirtualMachinePlatform' -and $_.InstallState -eq 1});spaces=$spaces} | ConvertTo-Json -Depth 4 -Compress`.replace('$env:TAVI_PROJECT', `'${root.replaceAll("'", "''")}'`)));
      Object.assign(facts, windows);
      try {
        const version = await run('wsl.exe', ['--version']);
        facts.wslMajor = Number(version.match(/(?:WSL[^\d]*)(\d+)\./i)?.[1] || 0);
        facts.kernel = /kernel[^\d]*\d+\./i.test(version);
        const listing = await run('wsl.exe', ['--list', '--verbose']);
        for (const space of facts.spaces) {
          const fields = listing.split(/\r?\n/).map(line => line.replace(/^\s*\*?\s*/, '').split(/\s+/)).find(parts => parts[0]?.toLowerCase() === space.name.toLowerCase());
          space.state = fields?.[1] || 'unknown';
        }
      } catch { facts.wslMajor = 0; facts.kernel = false; }
      const owned = facts.spaces.find(row => row.name.toLowerCase() === config.run.distro.toLowerCase());
      const location = owned?.location?.replace(/^\\\\\?\\/, '');
      if (owned && state?.creating && path.resolve(location).toLowerCase() === path.join(config.folder, 'linux').toLowerCase()) facts.pendingSpaceId = owned.id;
      try {
        const keeper = JSON.parse(readFileSync(path.join(config.folder, 'tavi-run.json'), 'utf8'));
        process.kill(keeper.pid, 0);
        const health = await request('/api/health');
        if (keeper.port === config.port && keeper.distro === config.run.distro && health.name === 'Tavi' && health.dev === (config.run.mode === 'practice')) {
          const hq = await request('/api/hq/state');
          if (hq.guard === 'up') facts.ownedPorts = [config.port, 3090, 3091];
        }
      } catch {}
      return facts;
    },
    async createSpace() {
      await run('wsl.exe', ['--install', 'Ubuntu-24.04', '--name', config.run.distro, '--location', path.join(config.folder, 'linux'), '--no-launch']);
      // A new space is already version 2 on a current Windows, and asking again is an error there (found on a real PC).
      const listing = await run('wsl.exe', ['--list', '--verbose']);
      const fields = listing.split(/\r?\n/).map(line => line.replace(/^\s*\*?\s*/, '').split(/\s+/)).find(parts => parts[0]?.toLowerCase() === config.run.distro.toLowerCase());
      if (fields?.[2] !== '2') await run('wsl.exe', ['--set-version', config.run.distro, '2']);
    },
    async adoptSpace() {
      await linux('set -eu\ntest -f /opt/lh/hermes-version\ntest -f /opt/lh/probe.sh\ntest -f /opt/lh/run-gateway.sh\ntest -d /srv/lh/team\n');
    },
    async terminateSpace() { await run('wsl.exe', ['--terminate', config.run.distro]); },
    async permissions() {
      // Use the current Windows identity, never a name from a different PC.
      await ps(`$folder='${config.folder.replaceAll("'", "''")}'
$who=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($who,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'),(New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) { $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }
[System.IO.Directory]::SetAccessControl($folder, $acl)`);
      // Set through Windows itself, not the Set-Acl command: that command's module fails to load when this is
      // started from a terminal running the newer PowerShell (found on a real PC).
    },
    async desktop() { await run(process.execPath, ['scripts/tavi-desktop.mjs', '--install'], { env: { ...process.env, TAVI_DATA_DIR: config.folder } }); },
    async autostart(remove = false) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/tavi-install-autostart.ps1'), remove ? '-Remove' : '-Install', '-Root', root]);
    },
    async start() {
      const child = spawn(process.execPath, [path.join(root, 'scripts/tavi-supervise.mjs')], { cwd: root,
        env: { ...process.env, TAVI_DATA_DIR: config.folder }, windowsHide: true, detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    },
    stop: () => stopSupervisor(config.folder),
    async live() {
      const result = [];
      let health, hq;
      try { health = await request('/api/health'); } catch {}
      try { hq = await request('/api/hq/state'); } catch {}
      result.push({ id: 'app', ok: health?.ok === true && health.name === 'Tavi' && health.dev === (config.run.mode === 'practice'),
        line: 'The app answers in the chosen mode.', fix: 'Run node scripts/tavi.mjs start, then read the server log if it still fails.' });
      result.push({ id: 'guard', ok: hq?.guard === 'up',
        line: `The safety switch answers${hq?.safety?.level ? ` (${hq.safety.level})` : ''}.`, fix: 'Read guard.log. Do not reopen the safety switch to hide a failed check.' });
      const bots = hq?.bots || [];
      const engines = {};
      for (const bot of bots) { try { engines[bot.id] = await request(`/api/hq/bots/${encodeURIComponent(bot.id)}/engine`); } catch {} }
      // A new installation has no bots yet: the first steps in the app make the first one.
      result.push({ id: 'engine', ok: hq?.on === true && bots.every(bot => ['ready', 'not_signed_in'].includes(engines[bot.id]?.status)),
        line: bots.length ? 'Each bot engine answers (a subscription sign-in can still be needed).' : 'The team is on. There are no bots yet: the first steps in the app make the first one.', fix: 'Read the engine status in the app and guard.log. Sign in inside the app when asked.' });
      return { rows: result, hq, health, engines };
    },
    async waitLive() {
      const until = Date.now() + 180000;
      let result;
      do { result = await this.live(); if (result.rows.every(row => row.ok)) return result; await sleep(1000); } while (Date.now() < until);
      return result;
    },
    async phone() {
      try {
        const details = JSON.parse(await run('tailscale.exe', ['status', '--json'], { timeout: 5000 }));
        const name = details.Self?.DNSName?.replace(/\.$/, '');
        print(name ? `Private network name: ${name}. On this PC run tailscale serve --bg http://127.0.0.1:${config.port}; then open https://${name} on a phone signed in to the same private network.` : 'Private phone access is not ready. See public/INSTALL.md.');
      } catch { print('For phone access, install and sign in to Tailscale yourself. See public/INSTALL.md. Setup changes no private network settings.'); }
    },
    async removeDesktop() {
      const folder = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'tavi-desktop');
      const file = path.join(folder, 'Uninstall Tavi.exe');
      if (existsSync(file)) await run(file, ['/S']);
      // Only this app's own per-user entry is removed.
      await ps("foreach($name in @('Tavi','tavi-desktop')) { Remove-ItemProperty -LiteralPath HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name $name -ErrorAction SilentlyContinue }");
    },
    async unregister() { await run('wsl.exe', ['--unregister', config.run.distro]); },
    async removeData() {
      const folder = path.resolve(config.folder), relative = path.relative(root, folder);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || ['src', 'ui', 'scripts', 'box', 'desktop', 'tests', 'public', 'docs', 'node_modules'].includes(relative.split(path.sep)[0]))
        throw new Error('Automatic data removal is limited to a separate folder inside this project. Remove an outside data folder yourself after reviewing it.');
      for (let current = folder; current !== root; current = path.dirname(current)) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Data removal refuses a file link.');
      }
      rmSync(folder, { recursive: true, force: true });
    },
    async logs() {
      print(`Logs: ${path.join(config.folder, 'logs')}`);
      for (const name of ['tavi-status.json', 'supervisor.log', 'guard.log', 'server.log']) {
        const file = path.join(config.folder, 'logs', name);
        if (!existsSync(file)) continue;
        const clean = safeOutput(line => print(line.trimEnd()));
        print(name); clean(readFileSync(file).subarray(-12000)); clean.end();
      }
    },
    async lastErrors() {
      const lines = [];
      for (const name of ['guard.log', 'server.log']) {
        const file = path.join(config.folder, 'logs', name);
        if (!existsSync(file)) continue;
        const clean = safeOutput(line => { if (/fail|error|could not/i.test(line)) lines.push(`${name}: ${line.trim()}`); });
        clean(readFileSync(file).subarray(-12000)); clean.end();
      }
      return lines.slice(-3);
    },
    async pull() { await run('git', ['pull', '--ff-only']); },
    async cleanCode() {
      if (await run('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Finish or save the code changes before updating.');
    },
  };
}
