import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { forgetUsedModel, modelsFooter, readUsedModels, recordUsedModel } from './usedModels'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yoke-models-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('recordUsedModel', () => {
  it('records each step, without any provider or routing prefix', () => {
    recordUsedModel(dir, 'claude', 'claude', 'claude-opus-4-1')
    recordUsedModel(dir, 'codex', 'codex', 'azure/gpt-6.1-sol')
    expect(readUsedModels(dir)).toEqual({ claude: 'claude-opus-4-1', codex: 'gpt-6.1-sol' })
  })

  it("names the harness default when the model isn't known", () => {
    recordUsedModel(dir, 'codex', 'codex', undefined)
    expect(readUsedModels(dir)).toEqual({ codex: 'codex default' })
  })

  it('forgets a step that failed', () => {
    recordUsedModel(dir, 'codex', 'codex', 'gpt-5')
    forgetUsedModel(dir, 'codex')
    expect(readUsedModels(dir)).toEqual({})
  })
})

describe('modelsFooter', () => {
  it('links yoke and names the reviewer and synthesis models', () => {
    expect(modelsFooter({ claude: 'claude-opus-4-1', codex: 'gpt-6.1-sol', synthesis: 'claude-opus-4-1' })).toBe(
      '---\n_Adversarial review by [yoke](https://github.com/MakerXStudio/yoke): reviewed with claude-opus-4-1 and gpt-6.1-sol; combined with claude-opus-4-1._',
    )
  })

  it('names only the reviewers that ran', () => {
    expect(modelsFooter({ codex: 'gpt-5', synthesis: 'gpt-5' })).toContain(': reviewed with gpt-5; combined with gpt-5._')
  })

  it('still links yoke when no models were recorded', () => {
    expect(modelsFooter({})).toBe('---\n_Adversarial review by [yoke](https://github.com/MakerXStudio/yoke)._')
  })
})
