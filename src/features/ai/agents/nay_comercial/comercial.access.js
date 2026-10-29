'use strict';

const AppError = require('../../../../utils/AppError');
const { CODE, DENIED_MESSAGE } = require('./comercial.policy');

const isMine = (ruleInput) => String(ruleInput.agentCode || '').toUpperCase() === CODE;

/** O ator precisa de TODAS as permissões (livro: ai:use + crm:read + radar:read; o código real das leituras do CRM é crm:opportunities:read). */
function assertCan(ruleInput, ...permissions) {
  const mine = Array.isArray(ruleInput.permissions) ? ruleInput.permissions : [];
  const missing = permissions.filter((p) => !mine.includes(p));
  if (missing.length) throw new AppError(DENIED_MESSAGE, 403, 'AI_PERMISSION_DENIED', { permission: missing[0] });
}

const nowOf = (ruleInput) => (ruleInput.now instanceof Date ? ruleInput.now : new Date());

module.exports = { isMine, assertCan, nowOf };
