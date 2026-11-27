import { z } from 'zod'

import type { GateApi } from './ciGate'
import type { Check, OwnedRepo } from './ciRiskCheck'
import { ReviewError } from './pr'

const namesSchema = z.object({ variables: z.array(z.object({ name: z.string() })) })
const secretNamesSchema = z.object({ secrets: z.array(z.object({ name: z.string() })) })
const orgEntrySchema = z.object({ visibility: z.string() })

async function readable(api: GateApi, path: string): Promise<unknown> {
  try {
    return await api.get(path)
  } catch (error) {
    if (error instanceof ReviewError && /\(HTTP 40[34]\)/.test(error.message)) return undefined
    throw error
  }
}

type Kind = { label: string; path: 'variables' | 'secrets'; listed: (body: unknown) => string[] }

export const variableKind: Kind = {
  label: 'Org variable',
  path: 'variables',
  listed: (body) => namesSchema.parse(body).variables.map(({ name }) => name),
}

export const secretKind: Kind = {
  label: 'Org secret',
  path: 'secrets',
  listed: (body) => secretNamesSchema.parse(body).secrets.map(({ name }) => name),
}

async function reachesRepo(api: GateApi, repo: OwnedRepo, kind: Kind, name: string): Promise<boolean> {
  if ((await readable(api, `repos/${repo.full_name}/actions/${kind.path}/${name}`)) !== undefined) return true
  const shared = await readable(api, `repos/${repo.full_name}/actions/organization-${kind.path}?per_page=100`)
  return shared !== undefined && kind.listed(shared).includes(name)
}

export async function orgCheck(api: GateApi, repo: OwnedRepo, kind: Kind, name: string | undefined): Promise<Check> {
  if (!name) return { name: kind.label, passed: true, detail: `The caller doesn't read the App's client ID from a variable.` }
  const pass = (detail: string): Check => ({ name: kind.label, passed: true, detail })
  if (await reachesRepo(api, repo, kind, name)) return pass(`${name} reaches ${repo.full_name}.`)
  if (repo.owner.type !== 'Organization')
    return pass(`${name} isn't visible to your gh user; the App check below shows whether it reaches CI.`)
  const org = repo.owner.login
  const entry = await readable(api, `orgs/${org}/actions/${kind.path}/${name}`)
  const visibility = entry === undefined ? undefined : orgEntrySchema.parse(entry).visibility
  const excluded = visibility === 'selected' || (visibility === 'private' && !repo.private)
  if (!excluded) return pass(`${name} isn't visible to your gh user; the App check below shows whether it reaches CI.`)
  const settings = `https://github.com/organizations/${org}/settings/${kind.path}/actions/${name}`
  return {
    name: kind.label,
    passed: false,
    detail: `${org} shares ${name} only with ${visibility === 'selected' ? 'selected repos' : 'private repos'}, which excludes ${repo.full_name}. An org owner can add it at ${settings}`,
  }
}
