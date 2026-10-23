import type { Skill } from '../skill'

export const prSkill: Skill = {
  name: 'pr',
  description: 'Raise a PR with a concise What/Why/(How) description',
  body: `
# Raise a PR

Compose a short PR in the format below, get the user's approval in the terminal, push, then create it as a draft with \`yoke pr raise\`, which rejects a title or body that breaks the rules.

## Preconditions

- \`yoke\` is on PATH. If not, stop and tell the user to run \`npm i -g @makerx/yoke\`.
- Working tree clean, every change committed. If not, stop and say what is uncommitted.
- Branch is not the default branch.
- \`gh pr view\` reports no PR for the branch. If one exists, do not create another: propose edits to the existing title and body and apply them with \`gh pr edit\` after the same approval step.

## Body

Use exactly these sections, in this order, with these headings. Never add a section and never rename one: no \`## Summary\`, no \`## Changes\`, no \`## Test plan\`.

\`\`\`
Closes #<issue number>

## What

<2–3 sentences>

## Why

<1–2 sentences>
\`\`\`

Then, only if earned: \`## How\` (1–2 sentences).

**Closes line.** If the session or branch name gives an issue number, make it the first line, written \`Closes #123\` for a same-repo issue or \`Closes owner/repo#123\` for a cross-repo one. One \`Closes\` per issue. Nothing else goes above \`## What\`.

**One section, one question.**

| Section | Answers | Never contains |
|---|---|---|
| What | What is observably different for a user or caller | Function, file or component names; how it is built |
| Why | The problem that made the change worth doing | Mechanism |
| How | A non-obvious decision the diff cannot explain: a trade-off, a workaround, a rejected obvious approach | A walkthrough of the diff; a restatement of What |

Litmus for mechanism: a sentence with "by …ing", "so that it can", "because the X uses", or the name of an internal component, function or file belongs in How, and probably does not belong at all.

**Brevity budget.** Hard caps enforced by \`yoke pr raise\`: What 300 characters, Why 200, How 250, and 600 across all sections. Ceilings, not targets. Prefer deleting a sentence to shortening it.

**No per-file lists.** Never list changes file by file; the diff already shows that.

**Register.** Write like a commit message. Short declarative sentences, present tense, active voice. Cut "this change", "in order to", "it is worth noting", hedges and adverbs.

\`\`\`
Wordy: This change introduces a confirmation step so that users are able to cancel before their results are reset.
Terse: Retake asks for confirmation before resetting results.
\`\`\`

Prose, not bullets. Bullets only for 3 or more genuinely parallel items, and never in What.

Backticks around symbols, commands and flags.

The title and body never mention Claude, AI assistance or attribution. No \`Co-Authored-By\` or "Generated with" anywhere.

## Title

One line, at most 70 characters, conventional-commit prefix as the repo uses (\`fix(scope): …\`, \`feat(scope): …\`, \`chore: …\`). Says what changed for the user, not what files moved.

## Approval

Mandatory in every permission mode, including auto-accept and bypass. Write the full title and body verbatim in your visible reply. Then call \`AskUserQuestion\` with an approve option whose \`preview\` holds the complete title and body, plus a revise option. Approval covers the push as well as the create. On revise, redraft and ask again.

## Create

\`\`\`bash
git push -u origin HEAD
yoke pr raise --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
\`\`\`

Always a draft; the user marks it ready for review themselves. If \`yoke pr raise\` rejects the description, it names each rule that failed: fix those, show the revised description, and get approval again before rerunning. On success it prints the PR URL; report it.
`,
}
