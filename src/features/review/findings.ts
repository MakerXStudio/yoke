const severities = ['blocker', 'major', 'minor', 'nit'] as const
const sources = ['confirmed', 'disputed', 'reviewer1-only', 'reviewer2-only', 'already-raised'] as const

type Severity = (typeof severities)[number]
type Source = (typeof sources)[number]

export type Finding = {
  title: string
  severity: Severity | null
  source: Source | null
  file: string | null
  line: number | null
  impact: string
  recommendation: string
}

const aiRiskLevels = ['low', 'medium', 'high'] as const

export type AiRisk = { level: (typeof aiRiskLevels)[number]; reason: string }

export type Synthesis = { summary: string; findings: Finding[]; risk?: AiRisk | null }

function oneOf<T extends string>(values: readonly T[], raw: string): T | null {
  const value = raw.toLowerCase()
  return values.find((v) => v === value) ?? null
}

function field(block: string, name: string): string {
  return block.match(new RegExp(`^-\\s+${name}:\\s*(.*)$`, 'im'))?.[1]?.trim() ?? ''
}

function parseLocation(raw: string): Pick<Finding, 'file' | 'line'> {
  const location = raw.replace(/^`+|`+$/g, '').trim()
  if (!location || location.toLowerCase() === 'n/a') return { file: null, line: null }
  const match = location.match(/^(.+?):(\d+)(?:-\d+)?$/)
  if (!match?.[1] || !match[2]) return { file: location, line: null }
  return { file: match[1], line: Number(match[2]) }
}

function parseFinding(block: string): Finding {
  const [heading = '', ...rest] = block.split('\n')
  const body = rest.join('\n')
  return {
    title: heading.trim(),
    severity: oneOf(severities, field(body, 'Severity')),
    source: oneOf(sources, field(body, 'Source')),
    ...parseLocation(field(body, 'Location')),
    impact: field(body, 'Impact'),
    recommendation: field(body, 'Recommendation'),
  }
}

function section(markdown: string, heading: string): string | null {
  return markdown.match(new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'))?.[1]?.trim() ?? null
}

function parseRisk(markdown: string): AiRisk | null {
  const block = section(markdown, 'Risk')
  if (block === null) return null
  const level = oneOf(aiRiskLevels, field(block, 'Rating'))
  const reason = field(block, 'Reason')
  return level && reason ? { level, reason } : null
}

function rank(finding: Finding): number {
  const severity = finding.severity ? severities.indexOf(finding.severity) : severities.length
  const source = finding.source ? sources.indexOf(finding.source) : sources.length
  return severity * (sources.length + 1) + source
}

export function parseSynthesis(markdown: string): Synthesis {
  const findings = markdown
    .split(/^###\s+Finding:\s*/m)
    .slice(1)
    .map(parseFinding)
  return {
    summary: section(markdown, 'Summary') ?? '',
    findings: findings.toSorted((a, b) => rank(a) - rank(b)),
    risk: parseRisk(markdown),
  }
}

export function formatLocation({ file, line }: Pick<Finding, 'file' | 'line'>): string {
  if (!file) return 'no location'
  return line === null ? file : `${file}:${line}`
}

export function formatSynthesis({ summary, findings, risk }: Synthesis): string {
  const lines = [summary || 'No summary.', '']
  if (risk) lines.push(`Risk: ${risk.level} — ${risk.reason}`, '')
  if (!findings.length) lines.push('No findings.')
  for (const finding of findings) {
    lines.push(`[${finding.severity ?? 'unrated'}] ${formatLocation(finding)} — ${finding.title}`)
    if (finding.source) lines.push(`  Source: ${finding.source}`)
    if (finding.impact) lines.push(`  Impact: ${finding.impact}`)
    if (finding.recommendation) lines.push(`  Recommendation: ${finding.recommendation}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
