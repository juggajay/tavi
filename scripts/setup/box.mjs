import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Only the reviewed box folder travels across the pipe. It has no Windows path in it.
export function boxFiles(root) {
  const result = [];
  const visit = (folder, prefix = '') => {
    if (lstatSync(folder).isSymbolicLink()) throw new Error('The box folder must not be a file link.');
    for (const item of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, item.name), name = prefix + item.name;
      if (lstatSync(file).isSymbolicLink()) throw new Error('The box folder must not contain file links.');
      if (item.isDirectory()) visit(file, name + '/');
      else if (item.isFile()) result.push({ name, bytes: readFileSync(file) });
    }
  };
  visit(path.join(root, 'box'));
  return result;
}
export function boxHash(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.name + '\0').update(file.bytes).update('\0');
  return hash.digest('hex');
}
export function transferScript(files) {
  // Python receives data, never commands made from a file's text.
  const payload = files.map(({ name, bytes }) => ({ name, data: bytes.toString('base64') }));
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `set -euo pipefail
umask 077
python3 - <<'TAVI_FILES'
import base64, json, pathlib
root = pathlib.Path('/opt/tavi-setup/box')
root.mkdir(parents=True, exist_ok=True)
for row in json.loads(base64.b64decode('${encoded}')):
    name = pathlib.PurePosixPath(row['name'])
    assert not name.is_absolute() and '..' not in name.parts
    target = root / name
    current = root
    assert not current.is_symlink()
    for part in name.parts[:-1]:
        current = current / part
        assert not current.is_symlink()
        current.mkdir(exist_ok=True)
    assert not target.is_symlink()
    target.write_bytes(base64.b64decode(row['data']))
TAVI_FILES
`;
}
export const installBase = `set -euo pipefail
cd /opt/tavi-setup/box
bash setup.sh
for file in *.sh; do install -o root -g root -m 755 "$file" /opt/lh/; done
`;
export const installScreens = `set -euo pipefail
cd /opt/tavi-setup/box
bash screen/setup.sh
bash screen/apps.sh
bash /opt/lh/make-team.sh
bash /opt/lh/make-bot.sh bot-probe
`;
// The space runs its own start-up scripts when it starts. Wait for them to finish instead of running a second copy
// beside them: two at once rewrite the walls over each other and a check can catch a gap (found on a real PC).
export const waitBoot = `for attempt in $(seq 1 240); do
  if grep -q 'boot done' /var/log/lh-boot.log 2>/dev/null && ! pgrep -f '/opt/lh/boot.sh|/opt/lh/screen/boot.sh' >/dev/null; then break; fi
  sleep 0.5
done
grep -q 'boot done' /var/log/lh-boot.log
! pgrep -f '/opt/lh/boot.sh|/opt/lh/screen/boot.sh' >/dev/null
`;
export const checkBox = `set -euo pipefail
${waitBoot}bash /opt/lh/screen/boot.sh
runuser -u bot-probe -- bash /opt/lh/probe.sh
bash /opt/lh/screen/probe.sh
test "$(cat /opt/lh/hermes-version)" = 'v0.23.2 ae2a81ccc00e9b7c06301523e5bb09608397149c'
echo 'ok    the pinned engine is installed'
`;
export function engineScript(bytes) {
  const encoded = bytes.toString('base64');
  return `set -euo pipefail
umask 077
${waitBoot}printf '%s' '${encoded}' | base64 -d > /opt/tavi-setup/hermes-install.sh
bash /opt/tavi-setup/box/install-hermes.sh /opt/tavi-setup/hermes-install.sh
`;
}
