import { describe, expect, it } from 'vitest'

import { approverRejection } from './approver'
import type { GateContext } from './gate'

function context(sender?: string): GateContext {
  return {
    repo: 'o/r',
    runId: '900',
    runNumber: 10,
    serverUrl: 'https://github.com',
    eventName: 'pull_request_target',
    event: {
      action: 'labeled',
      label: { name: 'review' },
      ...(sender ? { sender: { login: sender } } : {}),
      pull_request: { number: 5, head: { ref: 'feature', sha: 'abcdef123', repo: { full_name: 'fork/r' } }, user: { type: 'User' } },
    },
  }
}

function permissionOf(permission: string, role_name?: string) {
  const paths: string[] = []
  const get = async (path: string) => {
    paths.push(path)
    return { permission, role_name }
  }
  return { paths, get }
}

describe('approverRejection', () => {
  it.each([
    ['admin', 'admin'],
    ['write', 'maintain'],
    ['write', 'write'],
  ])('accepts a label from a user with %s permission (%s role)', async (permission, role) => {
    const { paths, get } = permissionOf(permission, role)
    expect(await approverRejection(context('alice'), get)).toBeUndefined()
    expect(paths).toEqual(['repos/o/r/collaborators/alice/permission'])
  })

  it.each([
    ['read', 'triage'],
    ['read', 'read'],
    ['none', 'none'],
  ])('rejects a label from a user with %s permission (%s role)', async (permission, role) => {
    expect(await approverRejection(context('alice'), permissionOf(permission, role).get)).toBe(
      `was not run: alice added the label with ${role} access; approving needs write, maintain or admin`,
    )
  })

  it('names the permission when the API names no role', async () => {
    expect(await approverRejection(context('alice'), permissionOf('read').get)).toContain('with read access')
  })

  it('rejects an event without a sender', async () => {
    expect(await approverRejection(context(), permissionOf('admin', 'admin').get)).toBe(
      'was not run: the label event names no sender to check',
    )
  })
})
