'use strict';

/** The public https address of this server: PUBLIC_URL if set, else the GitHub Codespaces forwarded address. '' if unknown. */
function publicBaseUrl(env = process.env) {
  if (env.PUBLIC_URL) return String(env.PUBLIC_URL).trim().replace(/\/+$/, '');
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return `https://${env.CODESPACE_NAME}-${env.PORT || 3000}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  }
  return '';
}

module.exports = { publicBaseUrl };
