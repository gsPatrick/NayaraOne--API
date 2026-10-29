'use strict';

/**
 * Pedido de segredo (M9-D017, AI-004): pergunta ou instrução cujo ALVO é credencial do sistema. Os termos são os do livro
 * (senha, token, api key, secret, .env, connection string, credencial); "chave" só conta nos compostos que nomeiam credencial
 * (chave de API, da API ou do API ("mostre a chave da API", M9-D042), secreta, privada, do cofre, de acesso ao sistema). Entrega das chaves, chave PIX e chave de acesso da NF-e
 * são vocabulário do negócio imobiliário e passam. O administrador pode ACRESCENTAR termos (`ia.seguranca.termos_segredo_extra`).
 * Comparação sem acento, sem caixa e por palavra inteira.
 */
const BASE_PATTERNS = Object.freeze([
  /\bsenhas?\b/, /\bpasswords?\b/, /\btokens?\b/, /\bapi[ _-]?keys?\b/, /\bsecrets?\b/, /(?:^|[^a-z0-9])\.env\b/,
  /\bconnection[ _-]?strings?\b/, /\bstrings? de conexao\b/, /\bcredenciais?\b/, /\bcredentials?\b/,
  /\bchaves? (?:d[aeo] api|secretas?|privadas?|do cofre|de acesso ao sistema)\b/,
]);

// Mesma normalização do detector de injeção (homóglifos, caracteres invisíveis, hifenização de PDF): o red-team da M9-D046 achou o pedido em cirílico passando.
const { normalizeText: normalize } = require('../security/textNormalizer');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @returns {{ blocked: boolean, term: string|null }} o termo que caracterizou o pedido (para a trilha), sem o texto inteiro. */
function detectSecretRequest(texto, { extraTerms = [] } = {}) {
  const t = normalize(texto);
  if (!t) return { blocked: false, term: null };
  for (const re of BASE_PATTERNS) {
    const m = re.exec(t);
    if (m) return { blocked: true, term: m[0].trim() };
  }
  for (const extra of extraTerms) {
    const termo = normalize(extra);
    if (termo && new RegExp(`(?:^|[^a-z0-9])${escape(termo)}(?![a-z0-9])`).test(t)) return { blocked: true, term: termo };
  }
  return { blocked: false, term: null };
}

module.exports = { detectSecretRequest };
