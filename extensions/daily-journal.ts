import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, createReadStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// The first version is intentionally minimal: only two things are
// configurable — the input directory (where pi stores its sessions) and the
// output directory (where the generated diary markdown files are written).
interface JournalConfig {
  /** Directory containing pi session folders (each folder holds .jsonl files). */
  inputDir: string;
  /** Directory where the daily journal markdown files are written. */
  outputDir: string;
}

const DEFAULT_CONFIG: JournalConfig = {
  inputDir: join(homedir(), ".pi", "agent", "sessions"),
  // Empty means "current working directory" and is resolved at run time.
  outputDir: "",
};

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Load config, merging (in priority order):
 *   1. built-in defaults
 *   2. ~/.pi/agent/daily-journal.json          (global)
 *   3. <cwd>/.pi/daily-journal.json            (project-local, trusted only)
 */
function loadConfig(ctx: ExtensionCommandContext): JournalConfig {
  let config: JournalConfig = { ...DEFAULT_CONFIG };

  const globalPath = join(homedir(), ".pi", "agent", "daily-journal.json");
  config = mergeConfigFile(config, globalPath);

  if (ctx.isProjectTrusted()) {
    const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "daily-journal.json");
    config = mergeConfigFile(config, projectPath);
  }

  // Resolve paths.
  config.inputDir = expandHome(config.inputDir) || DEFAULT_CONFIG.inputDir;
  config.outputDir = config.outputDir ? resolve(ctx.cwd, expandHome(config.outputDir)) : ctx.cwd;
  return config;
}

function mergeConfigFile(base: JournalConfig, path: string): JournalConfig {
  if (!existsSync(path)) return base;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<JournalConfig>;
    return {
      inputDir: typeof raw.inputDir === "string" && raw.inputDir ? raw.inputDir : base.inputDir,
      outputDir: typeof raw.outputDir === "string" ? raw.outputDir : base.outputDir,
    };
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
/** Local date string YYYY-MM-DD. */
function localDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse the command argument into a target local date string (YYYY-MM-DD).
 * Empty / whitespace argument means "today". Returns null if the argument is
 * present but not a valid date.
 */
function parseDateArg(args: string): string | null {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return localDateString();

  const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = +y;
  const month = +mo;
  const day = +d;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Validate the date is real (e.g. reject 2026-02-30).
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return localDateString(date);
}

/**
 * A session filename looks like:
 *   2026-07-08T07-11-00-978Z_019f4090-....jsonl
 * The leading portion is a UTC timestamp. We convert it to a real Date so we
 * can compare against the *local* date the user cares about.
 */
function parseSessionDate(fileName: string): Date | null {
  const m = fileName.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return new Date(
    Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms),
  );
}

// ---------------------------------------------------------------------------
// Session parsing (token-efficient)
// ---------------------------------------------------------------------------
// Full JSONL files are huge (thinking blocks, tool call args, tool results,
// base64 images...). To keep token usage low we stream each file line by line
// and keep only:
//   - user text prompts
//   - assistant natural-language text (NOT thinking, NOT tool calls)
// Everything else (tool calls, tool results, images, reasoning) is dropped.
// We also cap the number/size of extracted pieces per session.

interface SessionDigest {
  file: string;
  cwd: string;
  startedAt: Date;
  turns: Array<{ role: "user" | "assistant"; text: string }>;
}

const MAX_TURNS_PER_SESSION = 40;
const MAX_TEXT_LEN = 1500;

function clip(text: string, max = MAX_TEXT_LEN): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + " …[truncated]" : t;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      // Keep only plain text. Skip thinking / toolCall / toolResult / image.
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

async function digestSession(filePath: string): Promise<SessionDigest | null> {
  const fileName = filePath.split("/").pop() ?? filePath;
  const startedAt = parseSessionDate(fileName);
  if (!startedAt) return null;

  const digest: SessionDigest = {
    file: fileName,
    cwd: "",
    startedAt,
    turns: [],
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (digest.turns.length >= MAX_TURNS_PER_SESSION) break;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === "session") {
        if (typeof entry.cwd === "string") digest.cwd = entry.cwd;
        continue;
      }

      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || typeof msg !== "object") continue;

      if (msg.role === "user") {
        const text = extractText(msg.content);
        if (text.trim()) digest.turns.push({ role: "user", text: clip(text) });
      } else if (msg.role === "assistant") {
        const text = extractText(msg.content);
        if (text.trim()) digest.turns.push({ role: "assistant", text: clip(text) });
      }
      // toolResult messages are ignored entirely.
    }
  } finally {
    rl.close();
    stream.close();
  }

  if (digest.turns.length === 0 && !digest.cwd) return null;
  return digest;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
async function findSessionsForDate(
  inputDir: string,
  targetDate: string,
  excludeCwd: string,
): Promise<SessionDigest[]> {
  if (!existsSync(inputDir)) return [];

  const results: SessionDigest[] = [];
  const excludeResolved = resolve(excludeCwd);

  const folders = readdirSync(inputDir, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  );

  for (const folder of folders) {
    const folderPath = join(inputDir, folder.name);
    let files: string[];
    try {
      files = readdirSync(folderPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const parsed = parseSessionDate(file);
      if (!parsed) continue;
      // Compare against local date the user cares about.
      if (localDateString(parsed) !== targetDate) continue;

      const digest = await digestSession(join(folderPath, file));
      if (!digest) continue;

      // Exclude sessions whose working directory IS the diary folder itself.
      if (digest.cwd && resolve(digest.cwd) === excludeResolved) continue;

      results.push(digest);
    }
  }

  // Chronological order.
  results.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return results;
}

// ---------------------------------------------------------------------------
// Rendering the compact digest for the LLM
// ---------------------------------------------------------------------------
function renderDigestForLLM(sessions: SessionDigest[]): string {
  const lines: string[] = [];
  for (const s of sessions) {
    const projectName = s.cwd ? s.cwd.split("/").pop() || s.cwd : "(unknown)";
    const time = s.startedAt.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    lines.push(`\n## Session @ ${time} — ${projectName}`);
    lines.push(`Path: ${s.cwd || "(unknown)"}`);
    for (const t of s.turns) {
      const who = t.role === "user" ? "Me" : "Assistant";
      lines.push(`- **${who}**: ${t.text}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.registerCommand("daily", {
    description: "Summarize all pi sessions from a given day into a journal entry (defaults to today; use /daily YYYY-MM-DD to specify a date)",
    getArgumentCompletions: (prefix: string) => {
      // Offer today and the previous few days as suggestions.
      const items: Array<{ value: string; label: string }> = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const value = localDateString(d);
        const label = i === 0 ? `${value} (today)` : i === 1 ? `${value} (yesterday)` : value;
        items.push({ value, label });
      }
      const filtered = items.filter((it) => it.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const config = loadConfig(ctx);

      const targetDate = parseDateArg(args);
      if (targetDate === null) {
        ctx.ui.notify(
          `Unrecognized date "${args.trim()}". Please use the /daily YYYY-MM-DD format (e.g. /daily 2026-07-08).`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus("daily-journal", `Scanning ${config.inputDir} for sessions on ${targetDate}…`);

      let sessions: SessionDigest[];
      try {
        sessions = await findSessionsForDate(config.inputDir, targetDate, ctx.cwd);
      } catch (err) {
        ctx.ui.setStatus("daily-journal", "");
        ctx.ui.notify(
          `Failed to scan sessions: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus("daily-journal", "");

      if (sessions.length === 0) {
        ctx.ui.notify(
          `No sessions found for ${targetDate} (local date) — the current journal directory is excluded.`,
          "warn",
        );
        return;
      }

      const digest = renderDigestForLLM(sessions);
      const outputFile = join(config.outputDir, `${targetDate}.md`);

      // Make sure the output dir exists before the agent tries to write.
      try {
        await mkdir(config.outputDir, { recursive: true });
      } catch {
        /* ignore */
      }

      // Read existing file (we overwrite, but give the LLM prior content as
      // reference so it can preserve any manual notes the user already added).
      let existing = "";
      try {
        existing = await readFile(outputFile, "utf8");
      } catch {
        /* no existing file */
      }

      const totalTurns = sessions.reduce((n, s) => n + s.turns.length, 0);
      ctx.ui.notify(
        `Found ${sessions.length} session(s) and ${totalTurns} conversation segment(s). Generating journal…`,
        "info",
      );

      const prompt = [
        `Based on the condensed conversation records extracted below from all pi coding sessions on ${targetDate},`,
        `write a natural, coherent work journal in English and save it to the file:\n\`${outputFile}\``,
        ``,
        `Requirements:`,
        `1. Use the first person, narrating like a diary what was done that day, what problems came up, and how they were solved.`,
        `2. Group by project/session, highlight the key points, and do not list conversations item by item.`,
        `3. At the top, add a Markdown level-1 heading: \`# ${targetDate}\`, followed by a brief summary of the day.`,
        `4. Use the write tool to write the final content to the file path above (overwrite).`,
        existing
          ? `5. The file already contains the following content; if it includes any hand-written notes from the user, try to preserve and merge them:\n\n<existing>\n${existing}\n</existing>`
          : ``,
        ``,
        `Below are the condensed records of each session for that day:`,
        digest,
      ]
        .filter(Boolean)
        .join("\n");

      pi.sendUserMessage(prompt);
    },
  });
}
