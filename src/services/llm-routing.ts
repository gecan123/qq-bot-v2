export function llmGatewayProviderUrl(gatewayUrl: string, providerName: string): string {
  const base = gatewayUrl.replace(/\/+$/, '')
  return `${base}/provider/${encodeURIComponent(providerName)}`
}
