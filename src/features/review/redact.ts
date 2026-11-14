const maxErrorChars = 300

const credentialShapes: [RegExp, string][] = [
  [/Bearer\s+\S+/gi, '[redacted]'],
  [/\bsk-[^\s"',}]+/g, '[redacted]'],
  [/\beyJ[\w-]+(?:\.[\w-]+)*/g, '[redacted]'],
  [/(Hash\s*\(Token\)\s*=\s*)[^\s"',}]+/gi, '$1[redacted]'],
  [/(key["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[redacted]'],
]

// Redacts before truncating so a secret is never cut in half and leaked. `keep: 'end'` keeps the last characters, where a
// process's output usually holds the cause.
export function sanitizeError(
  text: string,
  secrets: (string | undefined)[] = [],
  { keep = 'start' }: { keep?: 'start' | 'end' } = {},
): string {
  let safe = text
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]')
  for (const [shape, replacement] of credentialShapes) safe = safe.replace(shape, replacement)
  return keep === 'end' ? safe.slice(-maxErrorChars) : safe.slice(0, maxErrorChars)
}
