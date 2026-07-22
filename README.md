# pi-daily-journal

A [pi](https://pi.dev) extension that turns your day's pi coding sessions into a natural-language diary entry.

It scans all of pi's stored sessions, finds the ones from a given day, extracts a **token-efficient** digest (only your prompts and the assistant's text replies — no thinking blocks, tool-call args, tool results, or images), and asks the current agent to write a clean Markdown diary into your chosen output folder.

Great for keeping an Obsidian-style daily journal of what you worked on.

## Features

- 🗓️ Summarize **today** (`/daily`) or **any specific day** (`/daily 2026-07-08`).
- 🔎 Scans every session folder under pi's sessions directory automatically.
- 💰 **Token-efficient**: streams each `.jsonl` line-by-line and keeps only user/assistant text, dropping reasoning, tool calls, tool results, and images. Per-session caps keep the digest small.
- 🚫 Excludes sessions whose working directory **is your journal folder itself**, so the diary doesn't summarize its own generation.
- 🌏 Matches days by your **local** date (session filenames are UTC timestamps and are converted before comparison).
- ⚙️ Simple config: input dir, output dir, and journal language.
- 🌐 Write your journal in any language (`English`, `中文`, …) via the `language` option.
- ⌨️ Argument autocompletion suggests the last 7 days.

## Install

```bash
# From GitHub (replace with your repo if you fork it)
pi install git:github.com/daviddong/pi-daily-journal

# Or try it for a single run without installing
pi -e git:github.com/daviddong/pi-daily-journal

# Or from a local checkout
pi install /path/to/pi-daily-journal
```

To remove:

```bash
pi remove git:github.com/daviddong/pi-daily-journal
```

## Usage

Open pi in the folder where you keep your journal (for example an Obsidian daily notes folder), then run:

```
/daily                # summarize today
/daily 2026-07-08     # summarize a specific day (YYYY-MM-DD)
```

The extension gathers the day's sessions, builds a compact digest, and hands it to the current agent with instructions to write `<outputDir>/<date>.md`. The file is **overwritten** on each run; if the file already exists, its contents are passed to the agent so any manual notes you added can be preserved.

Typing `/daily ` and triggering completion will suggest the last 7 days.

## Configuration

Configuration is intentionally minimal — three fields:

| Field       | Meaning                                                        | Default                       |
| ----------- | ------------------------------------------------------------- | ----------------------------- |
| `inputDir`  | Directory containing pi session folders (each with `.jsonl`). | `~/.pi/agent/sessions`        |
| `outputDir` | Where the daily `YYYY-MM-DD.md` files are written.            | current working directory     |
| `language`  | Language the journal is written in (e.g. `English`, `中文`).   | `English`                     |

`~` is expanded to your home directory. A relative `outputDir` is resolved against the current working directory; an empty `outputDir` means "write into the current working directory".

Config is read from (later overrides earlier):

1. Built-in defaults
2. `~/.pi/agent/daily-journal.json` (global)
3. `<cwd>/.pi/daily-journal.json` (project-local, only when the project is trusted)

Example `~/.pi/agent/daily-journal.json`:

```json
{
  "inputDir": "~/.pi/agent/sessions",
  "outputDir": "~/Documents/daily",
  "language": "中文"
}
```

Leaving `outputDir` empty writes the diary into whatever folder you launched pi in.

## How it works

Each pi session is stored as `~/.pi/agent/sessions/<encoded-cwd>/<UTC-timestamp>_<uuid>.jsonl`. This extension:

1. Iterates over every session folder in `inputDir`.
2. Parses the UTC timestamp from each filename and converts it to your local date; keeps files matching the target day.
3. Streams each matching file line-by-line, reading the first `session` entry for its `cwd` and collecting only `user`/`assistant` **text** blocks (capped per session).
4. Skips any session whose `cwd` equals your current journal folder.
5. Renders a compact grouped digest and sends it to the agent with a prompt to write the diary file.

## License

MIT
