import { shellQuote } from './shellQuote'

export type EntraAuth = { clientId: string; environment?: string }

const githubOidcIssuer = 'https://token.actions.githubusercontent.com'

const entraTokenExchangeAudience = 'api://AzureADTokenExchange'

type FederatedCredential = { issuer: string; audience: string; subject: string }

export function federatedCredential(repo: string, environment?: string): FederatedCredential {
  return {
    issuer: githubOidcIssuer,
    audience: entraTokenExchangeAudience,
    subject: environment ? `repo:${repo}:environment:${environment}` : `repo:${repo}:pull_request`,
  }
}

function federatedCredentialCommand(clientId: string, credential: FederatedCredential): string {
  const parameters = JSON.stringify({
    name: 'yoke-review-ci',
    issuer: credential.issuer,
    subject: credential.subject,
    audiences: [credential.audience],
  })
  return `az ad app federated-credential create --id ${shellQuote(clientId)} --parameters ${shellQuote(parameters)}`
}

export function entraSetup({ clientId, environment }: EntraAuth, repo: string): string[] {
  const credential = federatedCredential(repo, environment)
  return [
    '',
    `Instead of REVIEW_CI_API_KEY, the job signs in to Foundry as Entra app ${clientId} with its GitHub OIDC token. On that app, create a federated credential with:`,
    `  issuer:   ${credential.issuer}`,
    `  audience: ${credential.audience}`,
    `  subject:  ${credential.subject}`,
    'for example with:',
    `  ${federatedCredentialCommand(clientId, credential)}`,
    'and give the app the Cognitive Services User role on the Foundry resource.',
    ...(environment ? [`The job runs in the ${environment} environment; create it on the repo if it does not exist.`] : []),
  ]
}
