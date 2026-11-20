import { describe, expect, it } from 'vitest'

import { gitArgv, refusedArg } from './piGit'

const config = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=false',
  '-c',
  'gpg.x509.program=false',
  '-c',
  'gpg.ssh.program=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'diff.external=',
]

describe('gitArgv', () => {
  it('runs log, show and diff with config pinned and external diff and textconv off', () => {
    for (const subcommand of ['log', 'show', 'diff']) {
      expect(gitArgv(subcommand, ['-n', '1'])).toEqual([...config, subcommand, '--no-ext-diff', '--no-textconv', '-n', '1'])
    }
  })

  it('runs blame with textconv off and merge-base with no forced flags', () => {
    expect(gitArgv('blame', ['a.txt'])).toEqual([...config, 'blame', '--no-textconv', 'a.txt'])
    expect(gitArgv('merge-base', ['main', 'HEAD'])).toEqual([...config, 'merge-base', 'main', 'HEAD'])
  })

  it('keeps the forced flags ahead of a -- in args', () => {
    expect(gitArgv('diff', ['--', 'src']).slice(config.length)).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--', 'src'])
  })

  it.each(['push', 'config', 'checkout', '-c', '--git-dir=x', undefined])('refuses subcommand %s', (subcommand) => {
    expect(() => gitArgv(subcommand, [])).toThrow('git subcommand must be one of log, show, blame, diff, merge-base')
  })

  it('refuses args that are not an array of strings', () => {
    expect(() => gitArgv('log', '-n 1')).toThrow('git args must be an array of strings')
    expect(() => gitArgv('log', [1])).toThrow('git args must be an array of strings')
  })

  it.each([
    '--output=/tmp/x',
    '--output-indicator-new=x',
    '--ext-diff',
    '--textconv',
    '--show-signature',
    '--remerge-diff',
    '--diff-merges=remerge',
    '--format=%G?',
    '--pretty=format:%GS',
    '--format=%+G?',
    '--format=%-G?',
    '--format=% G?',
    '--ext-di',
    '--ext',
    '--textcon',
    '--textconv-x',
    '--show-sig',
    '--remerge',
    '--diff-m=remerge',
    '--out=/tmp/x',
    '--orderfile=/dev/zero',
    '--orderf',
    '-O/dev/zero',
    '-O',
    '-pO/dev/zero',
  ])('refuses %s', (arg) => {
    expect(refusedArg('log', arg)).toBeDefined()
    expect(() => gitArgv('log', ['-n', '1', arg])).toThrow(arg)
  })

  it.each(['-S', '-Sfile', '-lSfile', '--ignore-revs-file=x', '--ignore-revs', '-O/dev/zero', '--textcon'])('refuses blame %s', (arg) => {
    expect(() => gitArgv('blame', [arg, 'a.txt'])).toThrow(arg)
  })

  it.each([
    ['log', '-S'],
    ['log', '-Sneedle'],
    ['log', '-SOAuth'],
    ['log', '-pGOAuth'],
    ['log', '--text'],
    ['log', '--no-ext-diff'],
    ['log', '--no-textconv'],
    ['log', '--'],
    ['diff', '-'],
    ['blame', '--ignore-rev=HEAD'],
    ['blame', '-L:Ofunc'],
  ] as const)('allows %s %s', (subcommand, arg) => {
    expect(refusedArg(subcommand, arg)).toBeUndefined()
  })

  it('allows copy detection and combined-diff flags after the subcommand', () => {
    expect(gitArgv('log', ['-C', '-c', '--format=%H %s']).slice(-3)).toEqual(['-C', '-c', '--format=%H %s'])
  })
})
