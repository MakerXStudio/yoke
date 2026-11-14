const maxErrorChars = 300

const credentialShapes: [RegExp, string][] = [
  [/Bearer\s+\S+/gi, '[redacted]'],
  [/\bsk-[^\s"',}]+/g, '[redacted]'],
  [/\beyJ[\w-]+(?:\.[\w-]+)*/g, '[redacted]'],
  [/(Hash\s*\(Token\)\s*=\s*)[^\s"',}]+/gi, '$1[redacted]'],
  [/(key["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[redacted]'],
]

export function sanitizeError(text: string, secrets: (string | undefined)[] = []): string {
  let safe = text
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]')
  for (const [shape, replacement] of credentialShapes) safe = safe.replace(shape, replacement)
  return safe.slice(0, maxErrorChars)
}
