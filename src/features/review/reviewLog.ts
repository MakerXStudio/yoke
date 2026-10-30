import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { StatusUi } from './status'

type Log = (line: string) => void

export type ReviewLog = { append: Log; attach: (reviewDir: string) => void }

export function reviewLog(command: string[] = process.argv.slice(2), now = () => new Date()): ReviewLog {
  let path: string | undefined
  let buffered: string[] = []
  return {
    append: (line) => {
      if (path) appendFileSync(path, `${line}\n`)
      else buffered.push(line)
    },
    attach: (reviewDir) => {
      mkdirSync(reviewDir, { recursive: true })
      path = join(reviewDir, 'review.log')
      appendFileSync(path, `${['', `=== ${now().toISOString()} ===`, `$ yoke ${command.join(' ')}`, ...buffered].join('\n')}\n`)
      buffered = []
    },
  }
}

export function logged(ui: StatusUi, append: Log): StatusUi {
  const both = (show: Log) => (line: string) => {
    append(line)
    show(line)
  }
  return {
    log: both(ui.log),
    track: (label) => {
      append(`${label}…`)
      const status = ui.track(label)
      return {
        update: (activity) => {
          append(`${label}: ${activity}`)
          status.update(activity)
        },
        succeed: both(status.succeed),
        fail: both(status.fail),
      }
    },
    stop: ui.stop,
  }
}
