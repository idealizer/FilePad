# FilePad MCP

FilePad can be an MCP server for the window that is already open, and an MCP client for servers the user adds. This file is the contract for an agent.

The window has to be open. `filepad --mcp` does not read or change the disk by itself. If the window is closed, every tool returns an error telling you to open FilePad first.

There is no shell tool, no port forward, and no generic way to call an internal command.

## Connect

Launch the FilePad executable with `--mcp`. It speaks MCP over stdin and stdout, protocol `2024-11-05`, framed with `Content-Length`.

From this repo, after `npm run tauri dev` or a debug build:

```json
{
  "mcpServers": {
    "filepad": {
      "command": "C:\\Users\\patri\\FilePad\\src-tauri\\target\\debug\\filepad.exe",
      "args": ["--mcp"]
    }
  }
}
```

A release build is `src-tauri/target/release/filepad.exe` with the same argument. Point `command` at the executable that exists on that machine.

The window listens on `127.0.0.1` only and writes `%APPDATA%\FilePad\bridge.json` with the port and token. The `--mcp` process reads that file. Do not call the port yourself, and do not copy the token into a prompt or a log.

## Paths

`side` is `"left"` or `"right"`. When a tool takes `side` and you omit it, FilePad uses the left pane.

A local path is a normal Windows path. A remote path looks like this:

```text
sftp:<profileId>:/var/www/html
```

`profileId` comes from `get_state`. The remote part is an absolute SFTP path. `get_state` returns saved profiles with `id`, `label`, `host`, `port`, `username`, `remotePath`, and `fingerprint`. It never returns a password, a private key, or a passphrase.

## Tools

Tool results are JSON, returned as a text content block.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `get_state` | none | Active side, both pane paths, the selection on each pane, and saved SFTP profiles. |
| `navigate` | `side`, `path` | Opens that path on that pane. |
| `list_dir` | `side` | Refreshes that pane and returns `path`, `parent`, and `entries`. Each entry has `name`, `path`, `isDir`, `size`, `modified`, `extension`, and `hidden`. |
| `connect_sftp` | see below | Connects, then opens the remote folder on a pane. |
| `disconnect` | `side` | Drops that server session and returns the pane to its last local folder. |
| `copy_to_other` | `side` | Copies the files already selected on that pane into the other pane. |
| `move_to_other` | `side` | Moves that same selection. |
| `mkdir` | `side`, `name` | Creates a folder in the folder that pane is showing. |
| `rename` | `path`, `name` | Renames one file or folder. `name` is the new base name, not a path. |
| `delete` | `paths`, `confirm` | Deletes those paths. `confirm` must be `true`. Anything else is refused. |

`copy_to_other` and `move_to_other` use the selection already shown in the window. There is no select tool. Read `selected` from `get_state` first. An empty selection does not copy anything.

Copying from one SFTP server straight to another is refused. Copy to a local pane, then to the second server. Downloads land in the other pane's folder.

A directory listing entry with `extension` `"link"` is a symlink. Recursive delete does not follow directory links.

## Connect a server

```json
{
  "side": "left",
  "host": "203.0.113.10",
  "port": 22,
  "username": "site",
  "password": "secret",
  "remotePath": "/var/www",
  "fingerprint": "SHA256:abcd"
}
```

`host` and `username` are required. `port` defaults to 22. `remotePath` defaults to `/`. Use `password` or `privateKey` (a PEM string). `private_key` is accepted as an alias. `passphrase` unlocks the key. `profileId` reconnects a saved profile; omit the secret when that profile's password is already in Windows Credential Manager.

`fingerprint` is the server host key, SHA256, as in `SHA256:` plus base64. The first call often comes back with `"status": "needPin"` and a `fingerprint`. Call `connect_sftp` again with that exact fingerprint. FilePad then pins it.

If a key is already pinned, the fingerprint you send must match it. A different fingerprint is refused. A changed server key comes back as `"status": "mismatch"` with `fingerprint` (the key just seen) and `pinned` (the key on file). FilePad will not replace that pin from this tool. The user has to accept the new key in the FilePad window.

A successful call looks like this:

```json
{
  "status": "ready",
  "path": "sftp:<profileId>:/var/www",
  "profileId": "<profileId>",
  "fingerprint": "SHA256:...",
  "host": "203.0.113.10",
  "port": 22,
  "username": "site",
  "remotePath": "/var/www"
}
```

That `path` is what you pass to `navigate`, `rename`, and `delete`. The password is stored in Credential Manager and is not in this result. Do not write passwords, keys, or passphrases into chat, logs, or `settings.json`.

## Giving FilePad a connection from another server

FilePad can also be the MCP client. The user adds the server in the FilePad window under MCP servers (a local command plus arguments, or an HTTP URL). Secrets typed there go to Credential Manager. FilePad starts no server on its own.

When the user runs one of that server's tools, FilePad scans the result for one JSON object, at the top level, one level down, or inside a text content block:

```json
{
  "protocol": "sftp",
  "host": "203.0.113.10",
  "port": 22,
  "username": "site",
  "password": "secret",
  "remote_path": "/var/www"
}
```

`protocol` must be `sftp`. `host` and `username` are required, plus `password` or `privateKey` / `private_key`. `user` is accepted instead of `username`. `remotePath` and `remote_path` are both accepted. A credential blob with no `protocol: "sftp"` is ignored.

FilePad then asks the user before opening that server on the active pane. It does not call the tool by itself. A tool that creates a user or shows a password once should stay something the user runs on purpose.
