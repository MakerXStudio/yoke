import { z } from 'zod'

import type { GateContext } from './gate'

const permissionSchema = z.object({ permission: z.string(), role_name: z.string().optional() })

const approverPermissions = new Set(['admin', 'write'])

export async function approverRejection(
  { repo, event }: GateContext,
  get: (path: string) => Promise<unknown>,
): Promise<string | undefined> {
  const login = event.sender?.login
  if (!login) return 'was not run: the label event names no sender to check'
  const { permission, role_name } = permissionSchema.parse(await get(`repos/${repo}/collaborators/${login}/permission`))
  if (approverPermissions.has(permission)) return undefined
  return `was not run: ${login} added the label with ${role_name ?? permission} access; approving needs write, maintain or admin`
}
