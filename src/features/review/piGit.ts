export const gitSubcommands = ['log', 'show', 'blame', 'diff', 'merge-base'] as const

export type GitSubcommand = (typeof gitSubcommands)[number]

const gitConfig = [
  'core.fsmonitor=false',
  'log.showSignature=false',
  'gpg.program=false',
  'gpg.x509.program=false',
  'gpg.ssh.program=false',
  'protocol.allow=never',
  'diff.external=',
].flatMap((setting) => ['-c', setting])

const noExternalDiff = ['--no-ext-diff', '--no-textconv']

const forcedFlags: Record<GitSubcommand, string[]> = {
  log: noExternalDiff,
  show: noExternalDiff,
  diff: noExternalDiff,
  blame: ['--no-textconv'],
  'merge-base': [],
}

const refusedLong = ['--output', '--ext-diff', '--textconv', '--show-signature', '--remerge-diff', '--diff-merges', '--orderfile']

// Blame's -S and --ignore-revs-file read a file, like -O and --orderfile; on log, -S is the pickaxe.
const refusedForSubcommand: Record<GitSubcommand, { long: string[]; short: string }> = {
  log: { long: refusedLong, short: 'O' },
  show: { long: refusedLong, short: 'O' },
  diff: { long: refusedLong, short: 'O' },
  blame: { long: [...refusedLong, '--ignore-revs-file'], short: 'OS' },
  'merge-base': { long: refusedLong, short: 'O' },
}

// Git accepts an unambiguous prefix of a long option, so a prefix of a refused option is refused too, unless it is
// itself an option.
const optionsPrefixingRefused = ['--text', '--ignore-rev']

// Short options whose value is the rest of a bundled arg such as -pSfoo; any other letter may bundle with -O or -S.
const shortWithValue: Record<GitSubcommand, string> = {
  log: 'BCGILMSUXln',
  show: 'BCGILMSUXln',
  diff: 'BCGILMSUXln',
  blame: 'CLM',
  'merge-base': '',
}

function refusedLongOption(arg: string, refused: string[]): string | undefined {
  if (!arg.startsWith('--') || arg === '--') return undefined
  const name = arg.split('=', 1)[0] ?? arg
  if (optionsPrefixingRefused.includes(name)) return undefined
  return refused.find((option) => name.startsWith(option) || option.startsWith(name))
}

function refusedShortOption(arg: string, refused: string, withValue: string): string | undefined {
  if (!/^-[^-]/.test(arg)) return undefined
  for (const letter of arg.slice(1)) {
    if (refused.includes(letter)) return `-${letter}`
    if (withValue.includes(letter)) return undefined
  }
  return undefined
}

export function refusedArg(subcommand: GitSubcommand, arg: string): string | undefined {
  const refused = refusedForSubcommand[subcommand]
  const option = refusedLongOption(arg, refused.long) ?? refusedShortOption(arg, refused.short, shortWithValue[subcommand])
  if (option) return `git ${subcommand} refuses ${option}`
  if (/%[-+ ]?G/.test(arg)) return 'git refuses %G placeholders, which verify signatures'
  return undefined
}

function isSubcommand(value: unknown): value is GitSubcommand {
  return (gitSubcommands as readonly unknown[]).includes(value)
}

export function gitArgv(subcommand: unknown, args: unknown = []): string[] {
  if (!isSubcommand(subcommand)) throw new Error(`git subcommand must be one of ${gitSubcommands.join(', ')}`)
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('git args must be an array of strings')
  for (const arg of args) {
    const reason = refusedArg(subcommand, arg)
    if (reason) throw new Error(`${reason}: ${arg}`)
  }
  return [...gitConfig, subcommand, ...forcedFlags[subcommand], ...args]
}
