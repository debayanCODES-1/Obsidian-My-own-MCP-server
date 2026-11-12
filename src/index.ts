import "dotenv/config";

import { realpath, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_QUERY_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;
const IGNORED_DIRECTORIES = new Set([".obsidian", ".git", "node_modules"]);

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function getVaultRoot(): Promise<string> {
  const configuredPath = process.env.OBSIDIAN_VAULT_PATH?.trim();
  if (!configuredPath) {
    throw new Error(
      "OBSIDIAN_VAULT_PATH is not set. Configure it in .env or the VS Code MCP server settings.",
    );
  }

  const root = await realpath(path.resolve(configuredPath));
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error("OBSIDIAN_VAULT_PATH must point to an existing directory.");
  }

  return root;
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath));
}

async function getMarkdownFiles(root: string): Promise<string[]> {
  const markdownFiles: string[] = [];
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) continue;

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pendingDirectories.push(entryPath);
        }
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        markdownFiles.push(entryPath);
      }
    }
  }

  return markdownFiles;
}

async function readBoundedNote(filePath: string): Promise<string> {
  const noteStats = await stat(filePath);
  if (!noteStats.isFile()) {
    throw new Error("The requested path is not a regular file.");
  }
  if (noteStats.size > MAX_NOTE_BYTES) {
    throw new Error("The note exceeds the 5 MiB per-note processing limit.");
  }

  return readFile(filePath, "utf8");
}

function getSnippet(content: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 100);
  const end = Math.min(content.length, matchIndex + 200);
  const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < content.length ? "…" : ""}`;
}

const server = new McpServer({
  name: "obsidian-local-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "search_notes",
  {
    description:
      "Search the Markdown notes in the configured Obsidian vault for a case-insensitive text phrase. Returns matching note paths and short excerpts. Use this to locate notes or find where a topic is mentioned; it does not search attachments or the .obsidian configuration folder.",
    inputSchema: {
      query: z.string()
        .trim()
        .min(1, "Query must not be empty.")
        .max(MAX_QUERY_LENGTH, `Query must be at most ${MAX_QUERY_LENGTH} characters.`)
        .describe("A non-empty phrase to find in Markdown note text."),
      limit: z.number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of matching notes to return (1-50; default 10)."),
    },
  },
  async ({ query, limit }): Promise<ToolResult> => {
    try {
      const root = await getVaultRoot();
      const files = await getMarkdownFiles(root);
      const normalizedQuery = query.toLocaleLowerCase();
      const matches: Array<{ path: string; excerpt: string }> = [];

      for (const file of files) {
        const content = await readBoundedNote(file);
        const matchIndex = content.toLocaleLowerCase().indexOf(normalizedQuery);
        if (matchIndex === -1) continue;

        matches.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          excerpt: getSnippet(content, matchIndex),
        });
        if (matches.length >= limit) break;
      }

      return textResult(
        matches.length > 0
          ? JSON.stringify({ query, count: matches.length, matches }, null, 2)
          : `No Markdown notes matched "${query}".`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected file-system error.";
      console.error(`search_notes failed: ${message}`);
      return textResult(`Could not search the Obsidian vault: ${message}`, true);
    }
  },
);

server.registerTool(
  "read_note",
  {
    description:
      "Read the full text of one Markdown note in the configured Obsidian vault. Provide its vault-relative path, such as 'Projects/Planning.md' (use forward slashes). Use search_notes first when you need to discover a note path. Paths outside the vault, non-Markdown files, and notes larger than 5 MiB are not permitted.",
    inputSchema: {
      path: z.string()
        .trim()
        .min(1, "Note path must not be empty.")
        .max(MAX_PATH_LENGTH, `Note path must be at most ${MAX_PATH_LENGTH} characters.`)
        .describe("Vault-relative path to a Markdown note, for example 'Projects/Planning.md'."),
    },
  },
  async ({ path: notePath }): Promise<ToolResult> => {
    try {
      if (notePath.includes("\0") || path.isAbsolute(notePath)) {
        throw new Error("Provide a vault-relative path, not an absolute path.");
      }

      const root = await getVaultRoot();
      const candidate = path.resolve(root, notePath);
      if (!isWithinDirectory(root, candidate)) {
        throw new Error("The requested path must stay inside the Obsidian vault.");
      }
      if (path.extname(candidate).toLowerCase() !== ".md") {
        throw new Error("Only Markdown (.md) notes can be read.");
      }

      const resolvedNote = await realpath(candidate);
      if (!isWithinDirectory(root, resolvedNote)) {
        throw new Error("The requested note resolves outside the Obsidian vault.");
      }

      const content = await readBoundedNote(resolvedNote);
      return textResult(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected file-system error.";
      console.error(`read_note failed: ${message}`);
      return textResult(`Could not read the requested note: ${message}`, true);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Obsidian local MCP server is ready on stdio.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error.";
    console.error(`Failed to start Obsidian local MCP server: ${message}`);
    process.exitCode = 1;
  });
}
