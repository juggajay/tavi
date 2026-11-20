# How Tavi fits together

The desktop and phone are views of one Windows server. React supplies the HQ team view. The earlier phone and desktop modules still supply some pages and viewers. Vite builds them into `web/dist`. Electron adds a Windows window and tray around the server's app.

The server stores information in SQLite and files under the chosen data folder. Database migrations are numbered in `src/store/db.ts`; preserve existing migration text and append new changes. Profile files describe the user's preferences and the assistant's style. Code outside those files enforces safety. Scoped memory keeps the lead's memory apart from a specialist's notebook. Files and documents are indexed by Windows code; they are not mounted inside the bot space.

The guard is a separate Windows process with no model. It owns safety state, PIN checks, process control and start probes. The normal keeper starts the guard before the server and stops the separate Linux space before finishing shutdown. The practice keeper uses a separate address and data folder. The guard, server and UI must agree on data folder and safety state.

Hermes gateways run as ordinary users in the dedicated WSL2 space. Shared program files are read-only to those users. Bot records select subscription, model, effort, fallbacks, tool groups and whether a computer is requested. Provider sessions are held behind the shared access layer; they are not copied freely between private bot homes. The earlier built-in engine uses the shared tool code directly on Windows and has a different process boundary.

Each bot has a queue and an event stream. The conversation lane answers the user. Longer work runs separately with a written context and limits, so chat remains available. Quiet finds use a limited separate lane and yield to requested work. Separate profiles prevent the same engine session from being driven by two lanes. The transcript keeps work steps and results; progress wording is derived from events, not treated as a model instruction.

The toolbox exposes MCP over HTTP on the one Windows port allowed from Linux. A per-bot token, allowed groups and current turn bind each request to its bot. The adapter reuses the same tool factories as the built-in engine. It holds approvals inside calls, tracks outside reads, and blocks real changes in test turns. A specialist sees only its brief and explicitly handed-over items. Its receipt is information for the lead, never an instruction to send, remember or change something.

Screens run inside the Linux space. Each has its own Xvnc desktop, browser and control port. The Windows relay offers watch and take-control modes, guarded by device and bot checks. Phone access is watch only. Network fences prevent a bot controlling another bot's browser. Giving the bot a computer also gives it shell and browser tools inside that space; the web tools on Windows remain a separate checked path.

Voice uses a provider voice connection and routes speech to the chosen bot. Other bots in a group can speak through separate audio. Scheduler, push and shortcut entry points pass work to the same bot queues. Optional mail, calendar, Drive, The Brain and linked-computer tools depend on the user's own connections and permissions.

Pages are structured data rendered by Tavi rather than model-supplied executable HTML. Saved pages include their own search and pictures where available. Drawings use the Python worker for document pages and tiles. Shared TypeScript geometry supports models, validation and app viewers; optional Blender support supplies off-screen rendering. Reference books and indexed folders are user-supplied and never included in the public edition.

Default local ports are guard 3091, toolbox 3090 and practice server 3100. Gateways start at 8650 inside Linux, VNC at 5910 and browser control at 9210. These internal services are not public endpoints. The user-facing server needs device pairing and a private HTTPS route for a phone. See SAFETY before changing network access.
