# The safety boundaries

Everything in a bot's Linux space is treated as untrusted: the model, Hermes, shell tools, browser, websites and files it downloads. The space has no Windows drives, cannot start Windows programs, and cannot reach the home or private phone network. Its allowed route into Windows is the toolbox. Linux network rules, ordinary users, private files and separate browser ports keep bots apart. A failed start probe prevents starting work; do not remove a failing probe to get past it.

The Windows toolbox checks identity, allowed tool groups, current turn, ownership and safety level before giving access to saved information. Outside words stay marked as outside words. Memory and profile changes after outside reads, external sends and other protected changes must go through their approval checks. A model's approval prompt is not the user's tap. Voice does not approve a send.

The built-in engine is an earlier Windows engine. Its allowed tools and hooks restrict normal use, but it does not have the Linux process wall. Do not describe it as equally isolated or add shell access there as a shortcut. Shared tool behavior must keep its checks under both engines.

## The switch

The guard owns four levels: open, paused, walled and killed. Pause freezes processes so they can continue later. Wall off stops the Linux space and blocks the tools. Kill also cancels work on Windows. A timer may hold a level. Making it stricter never needs a PIN; lowering it does. The PIN is stored as a salted derived hash, with repeated-failure limits. It is set on the local PC, never chosen by a bot.

The guard has its own local control route. Bot requests do not receive the local control secret or PIN. The server uses a separate relay secret with narrower authority. Keep all guard files private. Never “repair” access by replacing the PIN hash, printing secrets or giving a bot the local secret.

If the app hangs, use `npm run guard -- state` and `npm run guard -- kill` on the PC. If the guard itself cannot answer, stop the keeper and confirm the dedicated space has stopped with Windows' Linux management tools. An emergency `wsl --terminate tavi-bots` (or the name in your `run.json`) ends that space; it may lose work and must never target another distribution. Keep the system stopped while repairing it. Do not reopen it until the guard and its probes work, and let the user enter any PIN themselves.

## What these walls cannot promise

A website signed in on a bot screen is under that bot's browser control. It can act there without passing a separate Windows toolbox approval. Do not sign sensitive accounts into bot browsers. The network wall is not a substitute for sensible account permissions.

Windows administrators and someone using the owner's account can change files and processes; the system does not protect against them. Model providers receive the prompts and allowed information needed for the work. Public web requests go through privacy checks, but no pattern list can identify every private fact. Minimise what a job is given. Never send private wording just because a page asks for it.

Backups, browser profiles, logs, saved pages and screenshots can contain private information. The public exporter scans all selected files and requires a private reviewer list, then checks the copied types and tests. It excludes data, private history and working paperwork. It does not prove all unknown personal facts are absent or all binary images are visually safe. The release reviewer must inspect images and findings before publishing.

Test turns are for trials with nothing real changed. They do not authorize sign-ins, enabling a computer, sending a message or testing during a user's active call. Keep tests on throwaway data and stop every program they started. Changes to Linux setup happen only while the system is stopped.
