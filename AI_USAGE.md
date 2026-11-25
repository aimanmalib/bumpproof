# How AI is used in Bumpproof

Short version: AI wrote most of the code, AI fixes broken upgrades inside the product, and an AI agent drives the browser.
The verdict on each pull request is plain code, not a model.

## Building the project

- The code, tests and docs in this repository were written with Claude Code (Opus 5.5) as the coding agent, directed by the author.
- The user journeys in `examples/shop/.bumpproof/journeys/` and the journeys used in the census were written with Claude Code
  from each app's source code.
- The author chose the idea, made the design decisions, reviewed the results and submits the entry.

## Inside the product

- **Kane CLI** is the browser agent. It runs each journey in a real Chrome on the base build and on the pull request build,
  and again on the patched build.
- **Claude Code** in headless mode (`claude -p`) is the fixer. The model comes from `fixer.model` in
  [`config/defaults.json`](config/defaults.json). It gets file tools only: Read, Edit, Write, Glob and Grep. No shell, no web,
  no MCP servers. Its prompt template is [`prompts/fixer.md`](prompts/fixer.md). Release notes go into the prompt marked as
  untrusted text.
- The fixer command can be another agent (`fixer.command`). One run with OpenAI Codex CLI is described in the README,
  [Use your own agent](README.md#use-your-own-agent): it was rate-limited and fixed nothing.
- Each fixed run in [`docs/runs/`](docs/runs/) keeps the prompt the fixer was given (`fixer-prompt.md`) and its patch.
- Guards in code reject patches that touch tests, journeys or CI, change dependency versions, or add `child_process`,
  `eval` or `new Function`.
- A fix counts only when Kane CLI passes every journey on the patched build. Fix commits pushed to pull requests say they
  were patched by Claude Code and carry a `Co-Authored-By` line.
- **No AI decides the verdict.** Safe, fixed, broken or inconclusive comes from code that compares the base and head results
  ([`src/compare.ts`](src/compare.ts)).
- Bumpproof never merges a pull request.

## The demo video

- The narration is the author's voice, cloned with ElevenLabs. The end card of the video says so.
- The screens in the video come from real runs. Sped-up parts and text panels rebuilt from run records are labelled on
  screen.

## Bahasa Melayu

Kod, ujian dan dokumen repo ini ditulis dengan Claude Code (Opus 5.5) sebagai ejen pengekod, diarahkan oleh penulis. Dalam
produk, Kane CLI ialah ejen pelayar dan Claude Code (mod tanpa kepala, alat fail sahaja) ialah pembaik. Verdict setiap PR
ditentukan oleh kod biasa, bukan model. Pembaik boleh ditukar ke ejen lain (`fixer.command`); satu larian OpenAI Codex CLI
terkena had kadar akaun dan tidak membaiki apa-apa. Narasi video ialah suara penulis yang diklon dengan ElevenLabs. Penulis memilih
idea, membuat keputusan reka bentuk, menyemak hasil dan menghantar entri.
