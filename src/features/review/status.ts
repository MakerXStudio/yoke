import { styleText } from 'node:util'

import { createLogUpdate } from 'log-update'

type Log = (line: string) => void

type StepStatus = { update: (activity: string) => void; succeed: (text: string) => void; fail: (text: string) => void }

export type StatusUi = { log: Log; track: (label: string) => StepStatus; stop: () => void }

export async function timed<T>(ui: StatusUi, label: string, work: () => T | Promise<T>): Promise<T> {
  const started = Date.now()
  const status = ui.track(label)
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`
  try {
    const result = await work()
    status.succeed(`${label} (${elapsed()})`)
    return result
  } catch (error) {
    status.fail(`${label} failed after ${elapsed()}`)
    throw error
  }
}

export function lineUi(log: Log): StatusUi {
  return {
    log,
    track: (label) => {
      log(`${label}…`)
      return { update: (activity) => log(`${label}: ${activity}`), succeed: log, fail: log }
    },
    stop: () => {},
  }
}

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const tickMs = 80

type Entry = { label: string; text: string }

export function spinnerUi(stream: NodeJS.WritableStream): StatusUi {
  const update = createLogUpdate(stream)
  const running: Entry[] = []
  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const paint = (colour: 'cyan' | 'green' | 'red', text: string) => styleText(colour, text, { stream })
  const render = () => update(running.map((entry) => `${paint('cyan', frames[frame] ?? '')} ${entry.text}`).join('\n'))
  const persist = (line: string) => {
    update.clear()
    update.persist(line)
    render()
  }
  const settle = (entry: Entry, line: string) => {
    running.splice(running.indexOf(entry), 1)
    persist(line)
    if (running.length || !timer) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    log: persist,
    track: (label) => {
      const entry = { label, text: label }
      running.push(entry)
      timer ??= setInterval(() => {
        frame = (frame + 1) % frames.length
        render()
      }, tickMs)
      render()
      return {
        update: (activity) => (entry.text = `${label} — ${activity}`),
        succeed: (text) => settle(entry, `${paint('green', '✓')} ${text}`),
        fail: (text) => settle(entry, `${paint('red', '✗')} ${text}`),
      }
    },
    stop: () => {
      if (timer) clearInterval(timer)
      update.done()
    },
  }
}
