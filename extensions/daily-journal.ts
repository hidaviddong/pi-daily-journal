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
    lines.push(`路径: ${s.cwd || "(unknown)"}`);
    for (const t of s.turns) {
      const who = t.role === "user" ? "我" : "助手";
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
    description: "把某一天所有 pi 会话总结成一篇日记（默认今天，可 /daily YYYY-MM-DD 指定日期）",
    getArgumentCompletions: (prefix: string) => {
      // Offer today and the previous few days as suggestions.
      const items: Array<{ value: string; label: string }> = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const value = localDateString(d);
        const label = i === 0 ? `${value}（今天）` : i === 1 ? `${value}（昨天）` : value;
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
          `无法识别日期 "${args.trim()}"，请使用 /daily YYYY-MM-DD 格式（如 /daily 2026-07-08）。`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus("daily-journal", `扫描 ${config.inputDir} 中 ${targetDate} 的会话…`);

      let sessions: SessionDigest[];
      try {
        sessions = await findSessionsForDate(config.inputDir, targetDate, ctx.cwd);
      } catch (err) {
        ctx.ui.setStatus("daily-journal", "");
        ctx.ui.notify(
          `扫描会话失败: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus("daily-journal", "");

      if (sessions.length === 0) {
        ctx.ui.notify(
          `没有找到 ${targetDate}（本地日期）的会话（已排除当前日记目录）。`,
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
        `找到 ${sessions.length} 个会话、${totalTurns} 段对话，正在生成日记…`,
        "info",
      );

      const prompt = [
        `请根据下面从 ${targetDate} 这一天所有 pi 编码会话中抽取的精简对话记录，`,
        `写一篇自然、连贯的中文工作日记，保存到文件：\n\`${outputFile}\``,
        ``,
        `要求：`,
        `1. 用第一人称，像日记一样叙述这一天做了哪些事、遇到什么问题、如何解决。`,
        `2. 按项目/会话分组，突出重点，不要逐条罗列对话。`,
        `3. 顶部写一个 Markdown 一级标题：\`# ${targetDate}\`，并在其后简要概述这一天。`,
        `4. 使用 write 工具把最终内容写入上面的文件路径（覆盖）。`,
        existing
          ? `5. 该文件已存在以下内容，如果其中有用户手写的笔记，请尽量保留融合：\n\n<existing>\n${existing}\n</existing>`
          : ``,
        ``,
        `以下是该日各会话的精简记录：`,
        digest,
      ]
        .filter(Boolean)
        .join("\n");

      pi.sendUserMessage(prompt);
    },
  });
}
