import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Instruction, readInstructions, rootInstructions } from './instructions'

let base: string
let root: string
let outside: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'yoke-instructions-test-')))
  root = join(base, 'repo')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function write(path: string, content = path) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function link(path: string, target: string) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  symlinkSync(target, full)
}

const names = (instructions: Instruction[]) => instructions.map((instruction) => instruction.path.slice(root.length + 1))

const contents = (instructions: Instruction[]) => instructions.map((instruction) => instruction.content)

const atRoot = (loaded = new Set<string>()) => names(rootInstructions(root, loaded))

const onRead = (file: string, loaded = new Set<string>()) => names(readInstructions(root, join(root, file), loaded))

describe('the per-directory chain', () => {
  it('loads CLAUDE.md, .claude/CLAUDE.md, rules, then CLAUDE.local.md, ignoring AGENTS files', () => {
    write('CLAUDE.md')
    write('.claude/CLAUDE.md')
    write('.claude/rules/a.md')
    write('CLAUDE.local.md')
    write('AGENTS.md')
    write('AGENTS.local.md')
    expect(atRoot()).toEqual(['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/a.md', 'CLAUDE.local.md'])
  })

  it('takes the CLAUDE side when only CLAUDE.local.md exists', () => {
    write('CLAUDE.local.md')
    write('AGENTS.md')
    expect(atRoot()).toEqual(['CLAUDE.local.md'])
  })

  it('takes the CLAUDE side when only .claude/CLAUDE.md exists', () => {
    write('.claude/CLAUDE.md')
    write('AGENTS.md')
    expect(atRoot()).toEqual(['.claude/CLAUDE.md'])
  })

  it('loads AGENTS.md, rules, then AGENTS.local.md when no CLAUDE file exists', () => {
    write('AGENTS.md')
    write('.claude/rules/a.md')
    write('AGENTS.local.md')
    expect(atRoot()).toEqual(['AGENTS.md', '.claude/rules/a.md', 'AGENTS.local.md'])
  })

  it('loads AGENTS.local.md alone when AGENTS.md is missing', () => {
    write('AGENTS.local.md')
    expect(atRoot()).toEqual(['AGENTS.local.md'])
  })

  it('loads AGENTS.md alone', () => {
    write('AGENTS.md')
    expect(atRoot()).toEqual(['AGENTS.md'])
  })

  it('loads the rules of a folder with no chain files', () => {
    write('.claude/rules/a.md')
    expect(atRoot()).toEqual(['.claude/rules/a.md'])
  })

  it('decides the AGENTS fallback per directory', () => {
    write('CLAUDE.md')
    write('AGENTS.md')
    write('agents/AGENTS.md')
    write('claude/CLAUDE.md')
    write('claude/AGENTS.md')
    write('agents/x.ts')
    write('claude/x.ts')
    const loaded = new Set<string>()
    expect(atRoot(loaded)).toEqual(['CLAUDE.md'])
    expect(onRead('agents/x.ts', loaded)).toEqual(['agents/AGENTS.md'])
    expect(onRead('claude/x.ts', loaded)).toEqual(['claude/CLAUDE.md'])
  })

  it('returns the file content', () => {
    write('CLAUDE.md', 'be terse')
    expect(contents(rootInstructions(root, new Set()))).toEqual(['be terse'])
  })

  it('loads nothing above the cwd', () => {
    writeFileSync(join(base, 'CLAUDE.md'), 'parent')
    write('sub/x.ts')
    expect(atRoot()).toEqual([])
    expect(onRead('sub/x.ts')).toEqual([])
  })

  it('adds each loaded realpath to loaded', () => {
    write('CLAUDE.md')
    const loaded = new Set<string>()
    atRoot(loaded)
    expect([...loaded]).toEqual([join(root, 'CLAUDE.md')])
  })
})

describe('containment', () => {
  beforeEach(() => {
    writeFileSync(join(outside, 'secret.md'), 'secret')
    mkdirSync(join(outside, 'rules'))
    writeFileSync(join(outside, 'rules', 'r.md'), 'secret')
    mkdirSync(join(outside, 'dotclaude'))
    writeFileSync(join(outside, 'dotclaude', 'CLAUDE.md'), 'secret')
  })

  it('skips a chain file that links outside the cwd', () => {
    link('CLAUDE.md', join(outside, 'secret.md'))
    write('AGENTS.md')
    expect(atRoot()).toEqual(['AGENTS.md'])
  })

  it('skips a .claude folder that links outside the cwd', () => {
    link('.claude', join(outside, 'dotclaude'))
    expect(atRoot()).toEqual([])
  })

  it('skips a .claude/rules folder that links outside the cwd', () => {
    link('.claude/rules', join(outside, 'rules'))
    expect(atRoot()).toEqual([])
  })

  it('skips a rule entry that links outside the cwd', () => {
    link('.claude/rules/r.md', join(outside, 'secret.md'))
    link('.claude/rules/dir', join(outside, 'rules'))
    write('.claude/rules/ok.md')
    expect(atRoot()).toEqual(['.claude/rules/ok.md'])
  })

  it('follows a rule link that stays inside the cwd', () => {
    write('docs/shared.md')
    link('.claude/rules/shared.md', join(root, 'docs/shared.md'))
    expect(atRoot()).toEqual(['.claude/rules/shared.md'])
  })

  it('ends on a directory symlink cycle', () => {
    write('.claude/rules/a/r.md')
    link('.claude/rules/a/loop', join(root, '.claude/rules'))
    expect(atRoot()).toEqual(['.claude/rules/a/r.md'])
  })

  it('treats a chain file that is a directory as missing', () => {
    mkdirSync(join(root, 'CLAUDE.md'))
    write('AGENTS.md')
    expect(atRoot()).toEqual(['AGENTS.md'])
  })

  it.skipIf(process.getuid?.() === 0)('skips an unreadable file', () => {
    write('CLAUDE.md')
    write('.claude/CLAUDE.md')
    chmodSync(join(root, 'CLAUDE.md'), 0)
    expect(atRoot()).toEqual(['.claude/CLAUDE.md'])
  })

  it('returns nothing for a missing cwd', () => {
    expect(rootInstructions(join(base, 'missing'), new Set())).toEqual([])
    expect(readInstructions(join(base, 'missing'), join(base, 'missing', 'x.ts'), new Set())).toEqual([])
  })
})

describe('reads', () => {
  it('loads nested directories shallowest first', () => {
    write('CLAUDE.md')
    write('a/CLAUDE.md')
    write('a/b/AGENTS.md')
    write('a/b/c/x.ts')
    expect(onRead('a/b/c/x.ts')).toEqual(['CLAUDE.md', 'a/CLAUDE.md', 'a/b/AGENTS.md'])
  })

  it('skips files already loaded at the start', () => {
    write('CLAUDE.md')
    write('a/CLAUDE.md')
    write('a/x.ts')
    const loaded = new Set<string>()
    atRoot(loaded)
    expect(onRead('a/x.ts', loaded)).toEqual(['a/CLAUDE.md'])
  })

  it('loads a folder once across two reads in it', () => {
    write('a/CLAUDE.md')
    write('a/x.ts')
    write('a/y.ts')
    const loaded = new Set<string>()
    expect(onRead('a/x.ts', loaded)).toEqual(['a/CLAUDE.md'])
    expect(onRead('a/y.ts', loaded)).toEqual([])
  })

  it('cuts a file at 40,000 characters with a note to read the rest', () => {
    write('a/CLAUDE.md', 'x'.repeat(40_001))
    write('a/x.ts')
    const [instruction] = readInstructions(root, join(root, 'a/x.ts'), new Set())
    expect(instruction?.content).toBe(
      `${'x'.repeat(40_000)}\n\n[Cut at 40,000 characters. Read ${join(root, 'a/CLAUDE.md')} for the rest.]`,
    )
  })

  it('does not cut a file of exactly 40,000 characters, nor root files', () => {
    write('CLAUDE.md', 'x'.repeat(50_000))
    write('a/CLAUDE.md', 'y'.repeat(40_000))
    write('a/x.ts')
    expect(contents(rootInstructions(root, new Set()))[0]).toHaveLength(50_000)
    expect(contents(readInstructions(root, join(root, 'a/x.ts'), new Set()))[1]).toHaveLength(40_000)
  })

  it('triggers nothing for a read outside the cwd', () => {
    write('CLAUDE.md')
    writeFileSync(join(outside, 'x.ts'), '')
    writeFileSync(join(outside, 'CLAUDE.md'), 'secret')
    expect(readInstructions(root, join(outside, 'x.ts'), new Set())).toEqual([])
  })

  it('triggers nothing for a link that resolves outside the cwd', () => {
    writeFileSync(join(outside, 'x.ts'), '')
    write('CLAUDE.md')
    link('x.ts', join(outside, 'x.ts'))
    expect(onRead('x.ts')).toEqual([])
  })

  it('triggers nothing for a missing file', () => {
    write('CLAUDE.md')
    expect(onRead('missing.ts')).toEqual([])
  })
})

describe('imports', () => {
  it('loads a relative import right after the importing file', () => {
    write('CLAUDE.md', 'see @docs/a.md please')
    write('docs/a.md', 'A')
    write('.claude/CLAUDE.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'docs/a.md', '.claude/CLAUDE.md'])
  })

  it('resolves an import relative to the importing file', () => {
    write('CLAUDE.md', '@docs/a.md')
    write('docs/a.md', '@./b.md')
    write('docs/b.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'docs/a.md', 'docs/b.md'])
  })

  it('loads @AGENTS.md from CLAUDE.md', () => {
    write('CLAUDE.md', '@AGENTS.md')
    write('AGENTS.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'AGENTS.md'])
  })

  it('loads each file once through a cycle', () => {
    write('CLAUDE.md', '@a.md @b.md')
    write('a.md', '@b.md @CLAUDE.md')
    write('b.md', '@a.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'a.md', 'b.md'])
  })

  it('skips missing, binary and directory imports', () => {
    write('CLAUDE.md', '@missing.md @bin.md @dir @ok.md')
    write('bin.md', 'a\u0000b')
    mkdirSync(join(root, 'dir'))
    write('ok.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'ok.md'])
  })

  it('skips a file over 4 MiB', () => {
    write('CLAUDE.md', '@big.md')
    write('big.md', 'x'.repeat(4 * 1024 * 1024 + 1))
    expect(atRoot()).toEqual(['CLAUDE.md'])
  })

  it('skips imports in code spans, fenced blocks and HTML comments', () => {
    write(
      'CLAUDE.md',
      ['`@span.md` and ``@double.md``', '```', '@fenced.md', '```', '~~~md', '@tilde.md', '~~~', '<!-- @comment.md', '-->', '@ok.md'].join(
        '\n',
      ),
    )
    for (const name of ['span', 'double', 'fenced', 'tilde', 'comment', 'ok']) write(`${name}.md`)
    expect(atRoot()).toEqual(['CLAUDE.md', 'ok.md'])
  })

  it('needs @ at the start or after whitespace', () => {
    write('CLAUDE.md', 'mail me@a.md or @b.md')
    write('a.md')
    write('me@a.md')
    write('b.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'b.md'])
  })

  it('strips a #fragment and unescapes spaces', () => {
    write('CLAUDE.md', '@a.md#section @my\\ notes.md')
    write('a.md')
    write('my notes.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'a.md', 'my notes.md'])
  })

  it('follows absolute imports inside the cwd only', () => {
    writeFileSync(join(outside, 'secret.md'), 'secret')
    write('CLAUDE.md', `@${join(outside, 'secret.md')} @../outside/secret.md @${join(root, 'in.md')}`)
    write('in.md')
    expect(atRoot()).toEqual(['CLAUDE.md', 'in.md'])
  })

  it('skips an import that links outside the cwd', () => {
    writeFileSync(join(outside, 'secret.md'), 'secret')
    write('CLAUDE.md', '@escape.md')
    link('escape.md', join(outside, 'secret.md'))
    expect(atRoot()).toEqual(['CLAUDE.md'])
  })

  it('follows at most four hops', () => {
    write('CLAUDE.md', '@1.md')
    write('1.md', '@2.md')
    write('2.md', '@3.md')
    write('3.md', '@4.md')
    write('4.md', '@5.md')
    write('5.md')
    expect(atRoot()).toEqual(['CLAUDE.md', '1.md', '2.md', '3.md', '4.md'])
  })
})

describe('.claude/rules', () => {
  it('loads rules recursively in sorted path order', () => {
    write('.claude/rules/b.md')
    write('.claude/rules/a/z.md')
    write('.claude/rules/a.md')
    write('.claude/rules/notes.txt')
    expect(atRoot()).toEqual(['.claude/rules/a.md', '.claude/rules/a/z.md', '.claude/rules/b.md'])
  })

  it('strips the frontmatter', () => {
    write('.claude/rules/a.md', '---\ndescription: x\n---\nbody')
    expect(contents(rootInstructions(root, new Set()))).toEqual(['body'])
  })

  it('treats bad YAML, empty paths and ** as unconditional', () => {
    write('.claude/rules/a.md', '---\npaths: [unclosed\n---\nbad')
    write('.claude/rules/b.md', '---\npaths: []\n---\nempty')
    write('.claude/rules/c.md', '---\npaths:\n  - "**"\n---\nall')
    write('.claude/rules/d.md', '---\n---\nnone')
    expect(contents(rootInstructions(root, new Set()))).toEqual(['bad', 'empty', 'all', 'none'])
  })

  it('loads a path-scoped rule only on a matching read', () => {
    write('.claude/rules/ts.md', '---\npaths:\n  - "src/**/*.ts"\n---\nts rule')
    write('src/a/x.ts')
    write('src/a/x.md')
    const loaded = new Set<string>()
    expect(atRoot(loaded)).toEqual([])
    expect(onRead('src/a/x.md', loaded)).toEqual([])
    expect(onRead('src/a/x.ts', loaded)).toEqual(['.claude/rules/ts.md'])
    expect(onRead('src/a/x.ts', loaded)).toEqual([])
  })

  it('splits a string of paths outside braces and expands braces', () => {
    write('.claude/rules/r.md', '---\npaths: "src/{a,b}/*.ts, lib/**"\n---\nrule')
    for (const file of ['src/a/x.ts', 'src/b/x.ts', 'src/c/x.ts', 'lib/deep/x.md']) write(file)
    expect(onRead('src/c/x.ts')).toEqual([])
    expect(onRead('src/a/x.ts')).toEqual(['.claude/rules/r.md'])
    expect(onRead('src/b/x.ts')).toEqual(['.claude/rules/r.md'])
    expect(onRead('lib/deep/x.md')).toEqual(['.claude/rules/r.md'])
  })

  it('expands nested braces', () => {
    write('.claude/rules/r.md', '---\npaths: ["src/{a,b{1,2}}.ts"]\n---\nrule')
    for (const file of ['src/a.ts', 'src/b1.ts', 'src/b2.ts', 'src/b.ts']) write(file)
    expect(onRead('src/b.ts')).toEqual([])
    expect(onRead('src/b2.ts')).toEqual(['.claude/rules/r.md'])
  })

  it('matches a scoped rule relative to the folder holding .claude', () => {
    write('pkg/CLAUDE.md')
    write('pkg/.claude/rules/r.md', '---\npaths: ["src/*.ts"]\n---\nrule')
    write('pkg/src/x.ts')
    write('src/x.ts')
    expect(onRead('src/x.ts')).toEqual([])
    expect(onRead('pkg/src/x.ts')).toEqual(['pkg/CLAUDE.md', 'pkg/.claude/rules/r.md'])
  })

  it('loads imports in a scoped rule with the rule', () => {
    write('.claude/rules/r.md', '---\npaths: ["*.ts"]\n---\n@../../docs/ts.md')
    write('docs/ts.md')
    write('x.ts')
    const loaded = new Set<string>()
    expect(atRoot(loaded)).toEqual([])
    expect(onRead('x.ts', loaded)).toEqual(['.claude/rules/r.md', 'docs/ts.md'])
  })

  it('caps brace expansion at 1,000 patterns', () => {
    const alternatives = Array.from({ length: 1100 }, (_, i) => `f${i}`).join(',')
    write('.claude/rules/r.md', `---\npaths: ["{${alternatives}}.ts"]\n---\nrule`)
    write('f999.ts')
    write('f1000.ts')
    expect(onRead('f1000.ts')).toEqual([])
    expect(onRead('f999.ts')).toEqual(['.claude/rules/r.md'])
  })
})
