# Read files on another computer

The optional helper can list, find and read files in folders you choose on another Windows computer. It cannot change files or run commands. Keep its settings file private: it contains the paired computer's access key.

On the main computer, run `npm run helper:pair -- example-computer --gateway wss://your-private-address/helper`. Use your own private HTTPS address. The command writes a helper folder outside the project and tells you where it is. It never asks for an account password. Copy that whole folder to the other computer and install Node there if needed.

Edit `helper.json` on the other computer. Add only folders you want the assistant to read, such as `C:\Users\you\Documents`. Start with a small folder containing made-up files. Do not allow a drive root, system folders, personal browser profiles or account folders. Leave folders empty to share nothing.

Double-click `Try it.cmd` to see each request. Ask the assistant to list paired computers and read a made-up text file. Once it works, `Start at login.cmd` starts the helper without a window at Windows sign-in. `Stop.cmd` stops it for now. `Remove.cmd` removes its sign-in entry. On the main computer, `npm run helper:unpair -- example-computer` revokes its key.

The other computer must be on and reachable through your private network. A disconnected computer is reported as unavailable. The helper's log records requests and errors, not the contents of your files. Read-only access still reveals information, so review the allowed folders before using real files.
