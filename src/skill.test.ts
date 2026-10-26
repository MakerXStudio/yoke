import { describe, expect, it } from 'vitest'

import { ownerMarker, renderSkill } from './skill'

const skill = { name: 'demo', description: 'Demo skill', body: 'Do the thing.' }

describe('renderSkill', () => {
  it('makes a skill user-invoked only by default', () => {
    expect(renderSkill(skill)).toMatch(/^disable-model-invocation: true$/m)
  })

  it('lets the model invoke a skill that opts in', () => {
    expect(renderSkill({ ...skill, modelInvocable: true })).not.toContain('disable-model-invocation')
  })

  it('marks the skill as owned by yoke', () => {
    expect(renderSkill(skill)).toContain(ownerMarker)
  })
})
