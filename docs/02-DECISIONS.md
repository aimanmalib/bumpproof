# Decisions

Technical decisions taken while building Bumpproof, newest last. Each entry says what was chosen, why, and how to undo it.

## 1. TypeScript 5.9 with type stripping for tests (21 Nov 2026)

- **Chosen:** TypeScript 5.9.3 (`strict`, ESM, `erasableSyntaxOnly`). Source files import each other with `.ts` extensions;
  `rewriteRelativeImportExtensions` turns them into `.js` in `dist/`. Tests are `.ts` files run directly by `node --test`,
  which strips types natively on Node 22.18 and later. No test runner or loader is installed.
- **Why:** zero extra dev tools, and the tests exercise the same source the build compiles. TypeScript 7 (native) was available
  but is new; 5.9 is the line every editor and CI image already handles.
- **Users on Node 20:** they run the compiled `dist/`. CI builds and runs it on Node 20 in a separate job.
- **Undo:** switch tests to compiled output (`tsc` to a test folder, then `node --test` on it).

## 2. Runtime dependencies (21 Nov 2026)

- **Chosen:** none yet. The only runtime dependency allowed is `fflate`, added when evidence packs are read.
- **Why:** less to audit; the CLI runs on code pulled from other people's pull requests, so a small surface matters.

## 3. Values live in config, text lives in locales (21 Nov 2026)

- **Chosen:** every number, path, command name and list the code needs is in `config/defaults.json`; a project can override any
  key in `.bumpproof/config.json` (objects merge key by key, arrays replace). All text shown to people is in `locales/en.json`
  and `locales/ms.json`; English is the default, Malay with `--lang ms` or `BUMPPROOF_LANG=ms`. A test fails when the two files
  have different keys or different `{placeholders}`.
- **Undo:** `"enabled": false` in `.bumpproof/config.json` turns every command into a no-op.

## 4. `doctor` runs its checks in parallel and never prints identities (21 Nov 2026)

- **Chosen:** each check is a separate process with a timeout (`doctor.timeout_ms`), run side by side.
- **Why:** measured on the build host, Kane CLI 0.10.7 takes 16 to 20 s to answer even `--version`, with almost no CPU use.
  Run one after another, `doctor` took over a minute; in parallel it takes about 10 s.
- **Privacy:** `kane-cli whoami` and `gh auth status` print the account name or e-mail. `doctor` only reads their exit code and
  shows "logged in" or "not logged in".

## 5. Chrome for Kane CLI (21 Nov 2026)

- **Chosen:** look in this order: `KANE_CLI_CHROME_PATH`, config `kane.chrome_path`, a Chrome for Testing install under
  `kane.chrome_dir` (default `~/.local/share/bumpproof/chrome`, installed with
  `npx @puppeteer/browsers install chrome@stable --path ~/.local/share/bumpproof/chrome`), then the names Kane CLI itself
  looks for on `PATH`.
- **Why:** the build host has no system Chrome. Chrome for Testing is a pinned, unpacked build that needs no package manager.
