# Updating, backups and another PC

Run commands in the project folder. Use `--data your-folder` if you have chosen
a folder other than the one recorded in `desktop/app-config.json`.

Before an update, finish or save any changes to the source and make a backup:

```powershell
node scripts/tavi.mjs stop
```

Copy the whole chosen data folder to a private backup destination, with the app
stopped so its database and waiting writes agree. Keep its Windows permissions
private. Do not send that backup to an AI helper or check it into Git. It holds
conversations, memory, settings and local access records. The Windows data copy
does not include bot files or subscription sign-ins held in Linux.

To save those too, with the keeper stopped, export **only** the name in your
`run.json` using `wsl --export <chosen-name> <backup-file.tar>`. That archive
contains private bot files and subscription sign-ins: store it privately. Never
export, terminate or unregister any other Linux space. Keep the source revision
with the backup (`git rev-parse HEAD` shows it).

Then run:

```powershell
node scripts/tavi.mjs update
```

This refuses pending tracked source changes, stops the keeper, pulls only a
forward update, and runs the updated setup command. Packages, screens and the
desktop are rebuilt when their inputs changed. Changed box files are sent by
pipe and installed with the system stopped. Only the chosen Linux space is
restarted for its checks; no running bot browser or gateway is killed by hand.
The saved safety level stays as it was. The keeper starts again and all live
checks must pass before success is reported. If the engine installer changes,
give its reviewed path with `update --engine-installer scripts/setup/hermes-installer.sh`.

If a pull, build or check fails, work stays stopped. Fix the reported cause and
run setup again to resume, or restore the reviewed source revision and backup
while stopped. Do not clear a failed safety check. Run `doctor`, `status` and
`logs` after a repair. This command does not merge local changes, discard work,
sign in to subscriptions or change private network access.

For another PC, the simplest choice is a fresh installation followed by your own
subscription sign-ins. Copy reviewed source without `node_modules`, local build
output, `.env` files or personal data. Run the checks and setup in INSTALL.md.
Do not copy a built desktop installer: its project location belongs to the PC
that built it. Build it on the destination through setup.

To carry history across, stop both installations first. On the destination,
keep a backup of its empty data folder, then restore the source data backup to
the chosen folder. Edit `run.json` for the destination's chosen port, mode,
Linux name and voice-file location. Remove the copied `setup-state.json`,
`setup.lock` and `tavi-run.json`: Windows Linux identities and process numbers
belong to the source PC. Do not copy `desktop/app-config.json` or the old
`tavi-launch.json`; destination setup writes its own location.

If carrying Linux files too, have your helper import the private Linux backup
under a new, unused chosen name using `wsl --import <chosen-name> <new-folder>
<backup-file.tar> --version 2`. Do not replace a space already on the PC. Review
the imported Tavi files and use setup with `--adopt` to record its new identity.
Then run setup to repair paths and permissions, rebuild the desktop and check
the walls and engines. No tool should print subscription files or key contents.
An import may still need you to sign in again yourself.

Set up phone access on the destination yourself. Check a typed question, safety
switch, bot computer and optional voice before relying on it. Keep the original
PC stopped until you choose which installation should run for real, so routines
and notices are not doubled. Keep your backups until the destination is proven.
