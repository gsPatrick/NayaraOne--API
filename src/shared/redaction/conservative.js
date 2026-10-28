'use strict';

/**
 * Padrões conservadores de credencial (poucos falsos positivos), usados pelas guardas da NAY (M9-D005, M9-D008) para recusar
 * ou mascarar texto que carregue uma credencial. Mesma biblioteca, perfil mais estrito que o do logger.
 */
const CONSERVATIVE_SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\b(?:senha|password|passwd|secret|segredo|token|api[_-]?key|chave[_ -]?de[_ -]?api|access[_-]?key)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
]);

module.exports = { CONSERVATIVE_SECRET_PATTERNS };
