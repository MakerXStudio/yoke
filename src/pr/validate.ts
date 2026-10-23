export type Violation = { rule: string; message: string }

export const limits = {
  title: 70,
  body: 600,
  sections: { What: 300, Why: 200, How: 250 },
} as const

type SectionName = keyof typeof limits.sections

const sectionOrder: SectionName[] = ['What', 'Why', 'How']
const requiredSections: SectionName[] = ['What', 'Why']
const perFileListThreshold = 2

const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const closesPattern = /^(closes|fixes|resolves)\s+\S*#\d+\s*$/i
const listItemPattern = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const filePathPattern = /`[^`\s]*[/.][^`\s]*`|(?:^|\s)[\w.-]+\/[\w./-]+/

export function validateTitle(title: string): Violation[] {
  const trimmed = title.trim()
  if (!trimmed) return [{ rule: 'title-required', message: 'Title is empty.' }]
  const violations: Violation[] = []
  if (/[\r\n]/.test(trimmed)) violations.push({ rule: 'title-single-line', message: 'Title must be a single line.' })
  if (trimmed.length > limits.title)
    violations.push({ rule: 'title-length', message: `Title is ${trimmed.length} characters; the cap is ${limits.title}.` })
  return violations
}

type Section = { name: string; level: number; content: string }

function parseBody(body: string): { preamble: string; sections: Section[] } {
  const preamble: string[] = []
  const sections: Section[] = []
  for (const line of body.split(/\r?\n/)) {
    const heading = headingPattern.exec(line)
    if (heading?.[1] && heading[2]) {
      sections.push({ name: heading[2], level: heading[1].length, content: '' })
      continue
    }
    const current = sections.at(-1)
    if (current) current.content += `${line}\n`
    else preamble.push(line)
  }
  for (const section of sections) section.content = section.content.trim()
  return { preamble: preamble.join('\n').trim(), sections }
}

function isKnownSection(section: Section): section is Section & { name: SectionName } {
  return section.level === 2 && (sectionOrder as string[]).includes(section.name)
}

function checkPreamble(preamble: string): Violation[] {
  const stray = preamble.split('\n').filter((line) => line.trim() && !closesPattern.test(line.trim()))
  if (!stray.length) return []
  return [{ rule: 'preamble', message: 'Only `Closes #<issue>` lines may come before `## What`.' }]
}

function checkStructure(sections: Section[]): Violation[] {
  const violations: Violation[] = []
  for (const section of sections.filter((s) => !isKnownSection(s)))
    violations.push({
      rule: 'unknown-section',
      message: `Heading "${'#'.repeat(section.level)} ${section.name}" is not allowed; use only ## What, ## Why and optionally ## How.`,
    })

  const known = sections.filter(isKnownSection)
  for (const name of requiredSections)
    if (!known.find((s) => s.name === name)?.content)
      violations.push({ rule: `${name.toLowerCase()}-required`, message: `Body needs a non-empty "## ${name}" section.` })

  const names = known.map((s) => s.name)
  const duplicates = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))]
  for (const name of duplicates) violations.push({ rule: 'duplicate-section', message: `"## ${name}" appears more than once.` })

  const indexes = names.map((name) => sectionOrder.indexOf(name))
  if (!duplicates.length && indexes.some((index, i) => i > 0 && index < (indexes[i - 1] ?? 0)))
    violations.push({ rule: 'section-order', message: 'Sections must be in the order What, Why, How.' })
  return violations
}

function checkLengths(sections: Section[]): Violation[] {
  const violations: Violation[] = []
  let total = 0
  for (const section of sections) {
    total += section.content.length
    if (!isKnownSection(section)) continue
    const cap = limits.sections[section.name]
    if (section.content.length > cap)
      violations.push({
        rule: 'section-length',
        message: `"## ${section.name}" is ${section.content.length} characters; the cap is ${cap}.`,
      })
  }
  if (total > limits.body)
    violations.push({ rule: 'body-length', message: `Body sections total ${total} characters; the cap is ${limits.body}.` })
  return violations
}

function checkPerFileList(body: string): Violation[] {
  const fileItems = body
    .split(/\r?\n/)
    .map((line) => listItemPattern.exec(line)?.[1])
    .filter((item): item is string => item !== undefined && filePathPattern.test(item))
  if (fileItems.length < perFileListThreshold) return []
  return [{ rule: 'per-file-list', message: 'Body lists changes per file; the diff already shows that. Describe the change instead.' }]
}

export function validateBody(body: string): Violation[] {
  const { preamble, sections } = parseBody(body)
  return [...checkPreamble(preamble), ...checkStructure(sections), ...checkLengths(sections), ...checkPerFileList(body)]
}

export function validatePr(title: string, body: string): Violation[] {
  return [...validateTitle(title), ...validateBody(body)]
}
