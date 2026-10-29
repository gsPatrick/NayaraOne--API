'use strict';

const { rx, luhnValid, cpfValid, cnpjValid } = require('./patterns');
const { redactText } = require('./text');

const REMOVED = '[removido]';

/** Cada regra: [padrão, validador]. O que bate é REMOVIDO do texto (não mascarado): o fornecedor nunca vê o dado pessoal. */
const REMOVAL_RULES = [
  ['cnpjFormatted', null],
  ['cnpjBare', cnpjValid],
  ['cpfFormatted', null],
  ['cpfBare', cpfValid],
  ['cardCandidate', luhnValid],
  ['email', null],
  ['phone', null],
  ['localPhone', null],
];

/**
 * redactFreeText(texto) — perfil de TEXTO LIVRE ENVIADO A FORNECEDOR (M9-D219 regra 4, M9-D231 regra 3): segredos viram
 * `[REDACTED]` e CPF, CNPJ, cartão, e-mail e telefone são removidos (`[removido]`). Sem detecção própria: só os padrões
 * de ./patterns. Texto que não é string volta como veio.
 */
function redactFreeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = redactText(text, { secretsOnly: true });
  for (const [name, validate] of REMOVAL_RULES) {
    out = out.replace(rx(name), (match) => (validate && !validate(match) ? match : REMOVED));
  }
  return out;
}

module.exports = { redactFreeText, REMOVED };
