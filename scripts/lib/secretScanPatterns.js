'use strict';

/**
 * Padrões da varredura estática de segredo (M9-D246 3.2.2). Cada padrão tem nome estável, que é a chave da
 * allowlist (scripts/secretScan.allowlist.json).
 */
const PATTERNS = [
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private_key_pem', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'stripe_live_key', re: /sk_live_[A-Za-z0-9]+/ },
  { name: 'slack_token', re: /xox[baprs]-[A-Za-z0-9-]{8,}/ },
  { name: 'github_token', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/ },
  { name: 'bearer_token', re: /Bearer [A-Za-z0-9._-]{20,}/ },
  { name: 'connection_string_with_password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@'"`/$]{3,}@[^\s'"`]+/i },
];

module.exports = { PATTERNS };
