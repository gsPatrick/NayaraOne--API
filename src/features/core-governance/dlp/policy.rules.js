'use strict';

const { FLOOR_CLASSES, FLOOR_ACTION } = require('./dlp.constants');
const errors = require('./dlp.errors');

/**
 * Piso do livro (M9-D820 §3.3 item 2): EXPORT de HIGH e RESTRICTED mantém justificativa, MFA, auditoria e expiração. Recusa com 422 GOV_DLP_FLOOR_VIOLATION
 * a política resultante que desligue qualquer uma; endurecer (por exemplo negar a ação) é sempre permitido. A marca d'água nunca é piso (o livro: opcional).
 */
function assertFloor(next) {
  if (!FLOOR_CLASSES.includes(next.classification) || next.action !== FLOOR_ACTION || next.allowed === false) return;
  const broken = [];
  if (!next.requireJustification) broken.push('requireJustification');
  if (!next.requireMfa) broken.push('requireMfa');
  if (!next.requireAudit) broken.push('requireAudit');
  if (!(Number.isInteger(next.maxExpiryHours) && next.maxExpiryHours > 0)) broken.push('maxExpiryHours');
  if (broken.length) throw errors.floorViolation({ classification: next.classification, action: next.action, fields: broken });
}

/**
 * Relação entre a política AI da classe e o `ai_allowed` do campo (M9-D820 §3.4): a política é o TETO e `ai_allowed` a trava por campo; a IA só recebe o campo
 * se a classe permitir E o campo estiver marcado `true` (ausente ou qualquer outro valor = não).
 */
function allowsAi(policy, aiAllowedFlag) {
  return Boolean(policy && policy.allowed === true && aiAllowedFlag === true);
}

module.exports = { assertFloor, allowsAi };
