# notion-font-customizer Agent Guidance

## Project context

- This is a Node.js ESM CLI for patching the macOS Notion desktop app.
- The main source is `src/index.ts`.
- The shipped CLI entrypoint is `dist/index.js`; update it with `npm run build` whenever `src/index.ts` changes.
- Tests import from `dist/index.js`, so stale build output can hide source/build drift.

## Verification

- Run `npm test` after behavior changes.
- Run `./node_modules/.bin/tsc --noEmit` after TypeScript changes.
- Run `git diff --check` before committing or opening a pull request.
- For changes that affect macOS signing or the Notion app bundle, also verify the relevant generated `codesign` arguments in tests.

## Review guidelines

- Treat stale `dist/index.js` after `src/index.ts` changes as a P1 issue.
- Treat signing changes as high risk. Re-signing must not preserve Apple Developer entitlements, runtime flags, old requirements, or other metadata that can prevent the locally signed Notion app from launching.
- Treat backup, restore, `app.asar`, `Info.plist`, and `/Applications/Notion.app` mutation logic as launch-breaking or data-loss sensitive.
- Gist style source support is read-only unless a PR explicitly changes that contract. It must validate `contentHash`, must not require `githubToken`, and must not log or cache tokens.
- Documentation examples must not include real API keys, GitHub tokens, certificates, private local paths that expose secrets, or `.env` content.
