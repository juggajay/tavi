# Install Tavi on Windows

Tavi needs Windows 11 or Windows 10 version 22H2 (build 19045 or later), Node 24,
Python 3.10 or later (for the tools that read documents and drawings), Git,
15 GB free disk space, and at least 8 GB memory with 2 GB free. Allow more
memory for several bot computers. Setup needs an internet connection to install
packages and Ubuntu. This source can be reviewed and tested without one.
Keep the project in an ordinary folder you can write to. Do not use a shared
folder, a file link, or a folder containing another assistant's data.

Your AI helper should read this guide and the scripts in `scripts/setup` first.
It must not inspect your passwords, subscription sign-ins, keys or personal data.
Sign in to your AI subscriptions yourself, inside the app after installation.

## Before the first installation

Run this in a terminal in the project folder:

```powershell
node scripts/tavi.mjs setup --check
```

This only looks. It does not enable Windows features, start a Linux space, make
folders, install programs or change a private network. Each failed line begins
with STOP and gives the next action. Fix those lines and run the command again.
The app port defaults to 3077; the safety switch uses 3091 and the tool service
uses 3090. All three must be free before a new installation.

The bots get a Linux space of their own, called `tavi-bots` unless you choose
another name. The name must start with `tavi-`: the safety switch refuses to
work on any other, so a Linux installation you use yourself can never be
touched. Do not rename or reuse another Linux space to get past this check.

The engine's public installer must also be reviewed. Your helper obtains
`https://hermes-agent.nousresearch.com/install.sh`, reads its contents, and saves
the reviewed public script as `scripts/setup/hermes-installer.sh`. This file is
an installation program, never a key file. The existing box script installs and
checks Hermes v0.23.2 at commit
`ae2a81ccc00e9b7c06301523e5bb09608397149c`; another version is refused.

Then run:

```powershell
node scripts/tavi.mjs setup --engine-installer scripts/setup/hermes-installer.sh
```

`npm.cmd run setup -- --engine-installer scripts/setup/hermes-installer.sh` is the
same command. On Windows, `npm.cmd` avoids PowerShell's script execution policy.
After the first engine installation, `node scripts/tavi.mjs setup` is enough.

## What setup does

1. Checks Windows, Node, the two Windows features, virtual machine support, WSL 2
   and its kernel, disk, memory, ports and ownership of the chosen Linux space.
   Usually under a minute. An administrator must enable missing Windows features
   and approve the Windows prompt themselves, then restart Windows. Setup never
   grants itself administrator access or restarts Windows.
2. Makes a private setup record, installs the project, screen and desktop packages
   with `npm ci` from their lock files, builds the screens and checks the code.
   Usually 2–10 minutes, longer on a slow connection. It adds no packages to the
   manifests. The desktop builder and Electron come from this project's desktop
   lock file, with the versions already specified there. It then makes a
   `.venv` folder in the project and installs the pinned Python packages in
   `requirements.txt` into it; nothing is installed into your own Python.
3. Creates only the selected Ubuntu 24.04 space, default `tavi-bots`, as WSL 2.
   Files go through a pipe to a root shell; no Windows drive is mounted. It runs
   the base setup, installs the fixed engine and browser tools, installs the
   computers and their programs, makes the team and check user, and restarts
   only that space. It runs the wall, screen and engine-version checks, stopping
   at a failed check. Usually 10–30 minutes, sometimes longer for downloads.
4. Keeps data in `data` inside the project, initially empty apart from setup
   settings. It copies nothing from another installation. Windows permissions
   allow this user, system services and administrators. Another ordinary user
   cannot read this data. Never put unrelated files in this folder.
5. Builds and installs Tavi for this Windows user. It creates its own Start menu
   and desktop shortcuts and `Tavi.vbs` in this user's Startup folder. It uses its
   own application identity and settings folder. Usually 2–10 minutes. It reads
   no builder from another project.
6. Starts the keeper, checks the app, safety switch and every engine, then shows
   the app address, next steps and logs. Allow up to three minutes for the team
   to answer. A missing subscription sign-in is reported as needing sign-in,
   rather than pretending the engine is broken. A closed safety switch stays
   closed, and a stopped engine fails this final check.

Setup is safe to repeat. `setup-state.json` records each finished step and the
inputs it used. Unchanged package, build and install steps are skipped; changed
inputs are installed again. The safety checks and live checks run again every
time. A failing step is recorded and later steps do not run. Keep the record;
repair the reported problem and repeat the same command. Setup stops the keeper
before any repair work, without changing the saved safety level.

## Choices and questions

Setup asks no questions, including no password, key, code or subscription login.
Windows may ask for administrator approval when **you** enable its features.
These command options are explicit choices:

| Choice | Meaning |
|---|---|
| `--data saved` | Use `saved` inside this project instead of `data`. |
| `--port 3100` | Use a different app port; do not choose 3090 or 3091. |
| `--distro tavi-second` | Use this exact Linux space name (it must start with `tavi-`). Other spaces are left alone. |
| `--mode practice` | Keep real sending and automatic background work off. Fresh installs default to `real`. |
| `--voice` | Enable optional voice if your own voice settings file is present. |
| `--adopt` | After reviewing an existing Tavi space, check its existing Tavi files before recording ownership. Never use this for another person's Linux space. |
| `--engine-installer scripts/setup/hermes-installer.sh` | Use this reviewed public installer. |
| `--check` | Look only. An existing unrecorded space still needs an explicit adoption decision. |

An existing space with no ownership record is refused unless you explicitly use
`--adopt`. Its existing engine-version file, wall check, gateway script and team
home must be present. A WSL 1 space is refused. The recorded Windows Linux-space
identity must match on later runs. If setup was interrupted while creating a
space, its recorded creation location also identifies it on the next run.

## The one run file

The app, commands and keeper read `data/run.json` (or the chosen data folder):

```json
{
  "port": 3077,
  "distro": "tavi-bots",
  "mode": "real",
  "voice": false
}
```

The real mode enables approved sending, routines, the memory keeper and phone
notices. Practice mode keeps those off and puts approved sends in the demo
outbox. A damaged run file refuses a start. Environment settings cannot override
its mode, port, voice choice or Linux name.

A second, practice installation beside a real one (for development) uses its own data folder,
port and Linux space, for example with `--data data-practice`:

```json
{
  "port": 3100,
  "distro": "tavi-practice",
  "mode": "practice",
  "voice": true,
  "voiceFile": "voice.env"
}
```

Use `--data data-practice` on the commands until the desktop has been rebuilt by setup.
Thereafter `desktop/app-config.json` records the data location so the commands,
Windows sign-in and desktop find the same run file. Alternatively set
`TAVI_DATA_DIR` to the chosen folder. The older launch commands remain available
and obey that run file too. The old `tavi-launch.json` location is still accepted
for a previous installation, but does not override a run file.

## Optional voice

Put your own key in `data/voice.env` (or in the data folder you chose). Make the file yourself; do not paste its contents into chat or logs:

```text
OPENAI_API_KEY=your-own-key
```

Set `voice` to `true` in `run.json`, then restart Tavi. An optional `voiceFile`
setting gives another path, relative to the data folder or absolute. The keeper
reads only the voice key from it, only while voice is enabled. Setup never opens
it. A missing file starts Tavi with voice off. An unreadable file stops the start
with a plain error. No subscription sign-in is copied from another project.

## First use and phone access

Open Tavi from the Start menu, or open the printed local `/desktop` address.
In Subscriptions, sign in yourself to Claude and OpenAI. Set your safety PIN,
try a typed question and the safety switch, then try a bot's computer. Voice
requires the optional key above. The first-run screens belong to another stage;
this installer does not fill in your profile or make sign-in decisions.

For a phone, install and sign in to Tailscale yourself on both devices. If it is
already installed, setup reads its status and prints the private network name
and this command, using your chosen port:

```powershell
tailscale serve --bg http://127.0.0.1:3077
```

Run that command yourself if you want phone access. Open the printed HTTPS
address on the phone, then pair the phone in the app. Setup never installs,
enables or changes Tailscale, a firewall rule, or public internet access.

## Failures and everyday commands

| Failure | What to do |
|---|---|
| Windows too old | Run Windows Update and restart. |
| Node missing or too old | Install Node 24, reopen the terminal. |
| Python missing or too old | Install Python 3 from python.org with "Add python.exe to PATH" ticked, reopen the terminal. |
| Linux features missing | Follow the exact administrator PowerShell command in the STOP line, then restart. |
| Virtual machine support off | Enable Intel VT-x or AMD SVM in the PC firmware settings. |
| WSL or kernel missing | Run the printed `wsl --install --no-distribution` and `wsl --update` commands yourself. |
| Space or memory short | Free the stated amount, close other programs, rerun. |
| Port taken | Stop the owning program yourself, or select another app port. The two service ports remain fixed. |
| Linux name not accepted | Choose a name starting with `tavi-`, such as `tavi-bots`. |
| Space belongs elsewhere | Choose another name; never unregister it to get past setup. |
| Package, build or engine failure | Keep the failing output and setup record. Check internet access, available disk and the reviewed installer; fix the cause and rerun. |
| Wall or screen check fails | Keep the failing line. Have the box maintainer repair that check; do not bypass it. |
| Data permissions fail | Check folder ownership and Windows policy, rerun as the intended Windows user. |
| Desktop build or install fails | Check its packages with `npm.cmd ci --prefix desktop`, close Tavi's desktop window and retry setup. |
| Final live check fails | Run `doctor` and `logs`. Keep the safety level; never reopen it just to make setup pass. |
| Setup lock remains after a crash | Check its process number. Only when that process has stopped, remove `setup.lock` and repeat setup. |

```powershell
node scripts/tavi.mjs start
node scripts/tavi.mjs stop
node scripts/tavi.mjs restart
node scripts/tavi.mjs status
node scripts/tavi.mjs doctor
node scripts/tavi.mjs logs
node scripts/tavi.mjs update
node scripts/tavi.mjs uninstall
```

Add `--data your-folder` when using a location not yet recorded by the desktop.
Status shows running or stopped, mode, safety level, Linux name, each bot's
engine and last errors. Doctor repeats all installation checks and live checks
with a next action for every failure. Logs are in the data folder's `logs`
folder; commands show recent output with private values hidden.

Uninstall stops the keeper and its Linux work, removes the Windows app and its
sign-in entries, and keeps the Linux space and all data. For permanent removal,
the separate command is `node scripts/tavi.mjs uninstall erase`. It first says
what will be lost, verifies ownership, then removes only the chosen Linux space
and chosen data folder. Bot files, downloads, subscription sign-ins,
conversations, memory and settings are lost. Back them up first. A plain
uninstall never does this. Source files and other Linux spaces stay in place.
