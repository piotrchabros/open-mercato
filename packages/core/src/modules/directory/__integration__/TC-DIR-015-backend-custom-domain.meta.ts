export const integrationMeta = {
  dependsOnModules: ['directory', 'customer_accounts'],
  // Backend custom domains are opt-in per deployment and refuse to start
  // without a trusted-proxy assertion, so this spec only runs where the
  // operator has configured them. It is skipped in the default suite by
  // design — the default-off behavior is covered by unit tests instead.
  requiredEnvVars: ['BACKEND_CUSTOM_DOMAINS_ENABLED', 'TRUSTED_PROXY_CIDRS'],
}
