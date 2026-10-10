# ScriptCraft Studio help

ScriptCraft Studio is a place to write and run scripts and programs in Python, JavaScript/TypeScript, HTML/CSS, SQL, PowerShell and more, with an AI assistant. Everything runs on your computer; projects live in the `projects` folder next to the studio.

## Getting started

1. **Project.** The project name button in the header → "New project" (or the "Script wizard" for ready-made starters).
2. **Files.** The explorer on the left: "New file", drag files and folders from your PC, a `.zip` is unpacked.
3. **The main file** is marked ★ — "Run" (`Ctrl+Enter`) runs it. `Ctrl+Shift+Enter` runs the open file.
4. Everything saves by itself ("✓ saved" in the header). Each file's version history — the clock icon next to it.

## Running programs

- Output appears in the "Terminal" tab at the bottom. When a program waits for input (`input()`), an input box shows up.
- **Run settings** (the sliders icon in the header): command-line arguments and environment variables, e.g. tokens. They never go to the AI or to Git.
- **HTML/CSS** open in the "Preview" tab, **SQL** runs in a built-in database and shows tables.
- **Packages** (the box icon on the left): `pip` and `npm` install libraries into the project folder, not into the system.
- **Build .exe**: "Export" → "Build .exe" turns a Python project into one Windows program.

> **Safety.** Programs run with your rights. When code deletes folders, changes the registry, downloads and runs files, reads browser passwords and so on, the studio shows what it found and asks once more. Run other people's code only if you trust it.

## Editor

- Completions and go to definition (`F12`), rename across the project (`F2`), quick fixes (`Ctrl+.`).
- Checks and formatting: **Ruff** for Python, **ESLint** and **Prettier** for JavaScript (`Shift+Alt+F`).
- Split editor (`Ctrl+\`), project search (`Ctrl+Shift+F`), go to file (`Ctrl+P`).
- Snippets — the `{}` icon in the header; Emmet in HTML/CSS.
- Markdown: preview with formulas (`$x^2$`) and Mermaid diagrams, export to HTML.
- **Keyboard shortcuts** can be changed: the keyboard icon in the header → click a shortcut.

## Debugging

`F5` starts debugging (Python and JavaScript). Breakpoints — click left of a line number; right-click for a condition or a logpoint (prints a message without stopping). `F10` step, `F11` step into, `Shift+F11` step out, `Shift+F5` stop. While paused you see the variables, can add watch expressions and hover a variable in the code.

## Tests

The "Tests" tab: `test_*.py` files run with **pytest**, `*.test.js` / `*.spec.ts` with `node --test`. A failed test opens at the failing line. The **"Coverage"** checkbox shows which lines the tests ran: a green bar next to the line number — ran, red — did not.

## Jupyter notebooks

`.ipynb` files open as notebooks: code and text cells, `Shift+Enter` runs a cell. matplotlib charts show right under the cell. "Interrupt" stops a long cell, "Restart" clears the variables. **"Variables"** lists everything the notebook holds (name, type, size, value); **"Export"** saves it as a `.py` script (`# %%` cells) or an `.html` page with the results and charts.

## Git

The branch icon on the left (`Ctrl+Shift+G`): changes, commits, branches, merging with conflict resolution, file history, pushing to GitHub. "Publish to GitHub" creates a repository through the GitHub CLI.

## AI assistant

The panel on the right. The Gemini key — the chip icon in the header → "AI models"; a local **Ollama** model or your own server can be added there too.

- **Chat** answers questions; "Create files" moves code from an answer into the project.
- **Agent** (the switch in the chat) edits files and runs code itself, but **asks before every action**; it shows a plan for bigger tasks.
- "Fix with AI" appears after a failed run.

> **What goes to the AI.** Your question and, with the "File" or "Project" context on, the contents of the project files are sent to the chosen model. The `.env` file, run settings and keys are never sent. With Ollama everything stays on your computer.

## Disassembler

Add an `.exe` / `.dll` (or ELF / Mach-O) with "Add files from PC" or drag it into the explorer — it opens in the disassembler right away (later — from the file list at the bottom of the explorer): headers, sections, imports and assembly code. Search instructions, follow `jmp`/`call` targets, patch bytes and **rewrite an instruction in assembly** (double-click a line: `nop`, `jmp 0x401020`, `mov eax, 1` — the studio shows the bytes, pads a shorter instruction with `nop` and warns when a longer one overwrites the next ones). The original file is kept as `.bak`.

## Programs on this PC

The window icon in the header: installed programs (search, check, "Repair", open folder), updates through **winget**, the "Startup" tab — turn programs that start with Windows on and off.

## Backups

Once a day the studio copies all projects to `Documents\ScriptCraft Studio Backups` (settings: the project name button in the header → "Backups"). Deleted files are in "History" (the clock icon on the left).

## Updates and problems

The "i" icon in the header:

- **Updates** — set the GitHub repository with the releases; an installed studio updates itself, projects and keys stay.
- **Report a problem** — a report with the version, system and error log; keys and your user name are removed. Logs are in the `logs` folder.

## Keyboard shortcuts (defaults)

| Action | Keys |
|---|---|
| Run | `Ctrl+Enter` |
| Run the open file | `Ctrl+Shift+Enter` |
| Go to file | `Ctrl+P` |
| Search the project | `Ctrl+Shift+F` |
| Git | `Ctrl+Shift+G` |
| Terminal | ``Ctrl+` `` |
| Debug | `F5` |
| Format | `Shift+Alt+F` |
| Command palette | `F1` |
