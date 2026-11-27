import { matchesGlob } from 'node:path'

const lockFiles = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'packages.lock.json',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]

function lockFileGlobs(globs: string[]): string[] {
  return globs.filter((glob) => lockFiles.some((name) => matchesGlob(name, glob) || matchesGlob(`a/${name}`, glob)))
}

export function lockFileProblem(globs: string[]): string | undefined {
  const matched = lockFileGlobs(globs)
  if (!matched.length) return undefined
  const list = matched.map((glob) => `\`${glob}\``).join(', ')
  return `lists lock files in \`alwaysHuman\` (${list}); no one reviews a lock file by hand, so remove them.`
}
