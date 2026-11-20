# When something is wrong

Start with the smallest check. Read the current safety state and the selected data folder, then find the corresponding log. Do not restart an active call or a user's long job without agreement.

| What you see | Check and next step |
|---|---|
| App cannot connect | Is the PC awake? Is its keeper running? Is the correct local port free? Check `logs/tavi-status.json`, `logs/supervisor.log`, `logs/server.log` and `logs/guard.log` under the selected data folder. Start only one keeper. |
| Guard unavailable | The app being down does not stop Linux. Try the local guard state and kill commands. If necessary stop the keeper and terminate only the bots' own space (`tavi-bots`, or the name in your `run.json`), then keep it stopped for repair. See SAFETY. |
| Bots are walled off | Read the guard's reason and `guard/audit.jsonl`. A failed probe or partial Linux change can trigger it. Stop the system, fix setup through the scripts, and repeat probes. The user reopens the switch with their PIN. |
| No subscription or model | Open More → Subscriptions. The user signs in. A provider limit or an unavailable model differs from a network fault. Choose an offered model or an approved fallback, and wait for a reset when supplied. |
| No bot computer | Give the bot a computer through its settings only after review. Check screen setup, per-bot keys and fence probes. Do not hand-start browsers or kill them while the guard is running. |
| Computer blank or wrong tab | Check the relay and screen logs with the system stopped before repairing it. A visible browser tab needs to be brought forward by the bot's browser tools. Do not use the user's own browser or profile. |
| Phone cannot connect | Confirm pairing, private network, HTTPS and PC power. Try the local app first. A watch-only screen is expected on the phone. Do not open public ports to work around a private connection problem. |
| No voice | Check microphone permission, output device, private HTTPS and optional voice key configuration without printing it. Try one short typed message first. A call may need a fresh connection after sleep. |
| Files or books missing | Check the configured folder, access permissions and indexing state. Books are never supplied with the app. Do not copy someone else's books or use private documents as a public test fixture. |
| Page picture missing | The page may refuse access or supply an unsupported image. The saved page can only embed pictures successfully fetched and checked. Save HTML when a searchable file is requested; PDF export is not supplied. |
| Model preview missing | The app viewer needs its built files. Off-screen rendering also needs the separately installed Blender program. A geometry check passing does not prove the renderer is installed. |
| A look found nothing | That can be correct. Check whether finds are enabled, paused, within limits, and allowed web tools. The lead's requested work has priority. Never raise limits silently just to produce a result. |
| Changes are not visible | Rebuild the UI, confirm the correct app address and build, then reload when work is idle. F5 works in the desktop program. A stale build is different from a server restart. |
| Type check fails | Run `npm run check` from the project root. Check the installed lock-file packages and both TypeScript configurations. Do not disable strict checking or exclude a failing source file as a repair. |
| Vite cannot write its settings cache | On a restricted shared package folder use `npm --prefix ui run build -- --configLoader runner`. Keep dependencies pinned. |
| A test fails | Run that one file, inspect its made-up inputs, and check it closed its resources. Do not run several files together. A fake provider test cannot prove a real sign-in works. |
| tsx reports an account lookup memory error | On Node 24 set `NODE_OPTIONS` to `--import ./scripts/test-reader.mjs --experimental-transform-types --no-warnings` and run the shipped tests. Use an absolute file URL for the import if a child test changes folders. This helper is for the shipped unit tests; it does not compile JSX browser trials. Other reader failures still need repair. |
| Export refuses to run | In the private source the reviewer must supply the real private list. Fix reported file/line findings or stale cleaning rules. An edited export loses its proof; rebuild it. Never turn off the scanner to publish. |

Keep diagnostic material local. A helpful issue report has the public version, Windows and Node versions, a short error, what happened and steps using made-up data. Remove account details, file paths identifying people, addresses, private network names, tokens and screenshots of sign-ins. Do not attach the full database or log folder.
