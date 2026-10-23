# Contributing to yoke

yoke stays small on purpose. Before adding a skill, check it is a baseline must-have for MakerX AI-assisted delivery, not a personal preference: those belong in your own `~/.claude/skills`.

## Setup

```bash
npm install
npm test          # vitest
npm run verify    # lint, format, types, unused code, complexity, comments, workflows
npm run build     # bundles src/cli.ts to dist/cli.js
```

Run the local build against a scratch repo with `node /path/to/yoke/dist/cli.js sync`.

CI runs `verify` and the tests on every PR to `main`.

## Releasing

There is no manual release step. Every push to `main` runs `verify` and the tests, then semantic-release reads the commits since the last tag, bumps the version, updates `CHANGELOG.md`, commits it as `chore(release): <version>`, creates a GitHub release and publishes `@makerx/yoke` to npm via trusted publishing. Use [conventional commits](https://www.conventionalcommits.org/): `fix:` releases a patch, `feat:` a minor, and `feat!:` or a `BREAKING CHANGE:` footer a major. Other types (`chore:`, `docs:`, `test:`) don't release.

## Layout

```
skills/<name>/SKILL.md   skill sources, copied verbatim by `yoke sync`
src/cli.ts               commander entry point; registers every command
src/sync.ts              `yoke sync`
src/<name>/              one folder per skill's CLI commands, with tests beside the code
```

## Adding a skill

1. Create `skills/<name>/SKILL.md`. The frontmatter must include:

   ```yaml
   ---
   name: <name>
   description: <one line>
   disable-model-invocation: true
   metadata:
     owner: "@makerx/yoke"
   ---
   ```

   `disable-model-invocation: true` keeps the skill user-invoked; the owner marker lets `sync` tell yoke's skills from the user's. `src/sync.test.ts` fails if either is missing.

2. Keep the prompt short. Anything that can be checked mechanically (formats, lengths, required sections) goes in a CLI command the skill calls, not in prose the model has to remember.

3. Call the CLI as `npx @makerx/yoke <command>` so the skill works whether or not the repo has yoke installed.

4. Add the skill to the table in the README.

## Adding a CLI command

1. Put the logic in `src/<skill>/<command>.ts` as plain functions that take their inputs and return results or throw. Inject anything that touches the outside world (like `gh`) as a parameter with a real default, so tests can pass a fake. See `src/pr/raise.ts`.

2. Register the command in `src/cli.ts`. Keep the action thin: parse options, call the function, print the result, and set `process.exitCode = 1` on an expected failure rather than throwing.

3. Add `src/<skill>/<command>.test.ts` covering each rule or branch. Error messages should name the rule that failed so the skill can fix it.

4. Run `npm run verify` and `npm test` before raising a PR, and raise it with `/pr`.
