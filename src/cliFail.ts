import type { ConfigError } from './features/config/userConfig'
import type { ReviewError } from './features/review/pr'

export function fail(error: unknown, ...expected: (typeof ReviewError | typeof ConfigError)[]): void {
  if (!expected.some((type) => error instanceof type) || !(error instanceof Error)) throw error
  console.error(error.message)
  process.exitCode = 1
}
