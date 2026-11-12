# Obsidian Local MCP Server

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an MCP-compatible client search and read Markdown notes from a local Obsidian vault. It uses TypeScript, Node.js, and the official MCP TypeScript SDK over `stdio`.

## What it can do

| Tool | Inputs | Result |
| --- | --- | --- |
| `search_notes` | `query` (required phrase), `limit` (optional, 1-50; default 10) | Case-insensitive matches in Markdown notes, with vault-relative paths and short excerpts. |
| `read_note` | `path` (vault-relative Markdown path, e.g. `Projects/Planning.md`) | Full text of the requested note. |

Search skips `.obsidian`, `.git`, `node_modules`, and symbolic links. Both tools are read-only; they do not edit notes or search attachments. A note must be no larger than 5 MiB to be processed.

## Requirements

- Node.js 20 or newer and npm.
- An existing Obsidian vault on the same machine as the MCP client.
- VS Code with MCP support, or another client that can launch a stdio MCP server.

## Folder map

```text
.
├── .vscode/
│   └── mcp.json          # VS Code launch and vault-path prompt
├── src/
│   └── index.ts          # Tool schemas, vault access, and stdio server
├── .env.example          # Local CLI configuration template
├── package.json          # Dependencies and build/run scripts
└── tsconfig.json         # Strict TypeScript compilation settings
```

`src/index.ts` is kept separate from generated output so the source remains easy to edit. `npm run build` emits the runnable JavaScript into `dist/`; the VS Code registration launches that compiled file rather than relying on a development runner.

## Setup and run in VS Code

1. **Install dependencies from the project folder.**

   ```sh
   npm install
   ```

   This installs the MCP SDK, Zod input validation, and TypeScript build tools and creates `package-lock.json` for repeatable installs.

2. **Build the server.**

   ```sh
   npm run build
   ```

   This type-checks the strict TypeScript source and writes `dist/index.js`, which is the entry point VS Code runs.

3. **Open the project folder in VS Code.** When prompted, enter the absolute path to the root of your Obsidian vault (for example, `/Users/alex/Documents/Research` or `C:\Users\Alex\Documents\Research`).

   The `.vscode/mcp.json` registration supplies this path as `OBSIDIAN_VAULT_PATH`; it does not put the vault path into source code or commit it to the repository.

4. **Start or refresh the MCP server** from VS Code's MCP controls. The `obsidian-vault` server is configured as a local `stdio` process. After changing TypeScript source, run the build again and restart/refresh the server so VS Code uses the new compiled output.

5. **Try the tools in Copilot Chat.** For example:

   > Search my Obsidian vault for notes mentioning “quarterly goals”, then read the most relevant note.

   Copilot should call `search_notes`, then use a returned path with `read_note`.

## Run from a terminal or another MCP client

Copy `.env.example` to `.env`, set `OBSIDIAN_VAULT_PATH` to the absolute path of your vault, then build and start:

```sh
cp .env.example .env
# Edit .env and set OBSIDIAN_VAULT_PATH.
npm run build
npm start
```

`dotenv` loads `.env` for this local workflow. For another stdio MCP client, configure its command as `node`, pass `${workspaceFolder}/dist/index.js` (or the absolute path to `dist/index.js`) as the argument, and provide `OBSIDIAN_VAULT_PATH` in that process's environment. Keep the process attached to the MCP client's stdin/stdout pipes.

For development without building each time, use `npm run dev`; it runs `src/index.ts` through `tsx`.

## Configuration and safety

- `OBSIDIAN_VAULT_PATH` is the only required setting. `.env.example` documents the terminal configuration; VS Code prompts for the same setting through `.vscode/mcp.json`.
- MCP protocol messages are written to stdout by the SDK. Startup and tool error logs go to stderr, so diagnostics cannot corrupt the JSON-RPC stream.
- Tool inputs are validated with strict Zod schemas. Filesystem failures and invalid paths return MCP tool errors (`isError: true`) instead of crashing the server.
- `read_note` accepts only `.md` files inside the configured vault. It checks resolved paths as well, so path traversal and symlinks targeting files outside the vault are rejected.
- `search_notes` reads note files only and skips symlinked entries and Obsidian's internal configuration folder.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install the locked project dependencies. |
| `npm run build` | Compile and type-check the server. |
| `npm start` | Start the compiled stdio server. |
| `npm run dev` | Run the TypeScript source during development. |
