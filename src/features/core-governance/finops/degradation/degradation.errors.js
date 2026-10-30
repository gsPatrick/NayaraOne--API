'use strict';

const { govError } = require('../../governance.errors');

/** Erros da degradação por custo (M9-D863 §4): códigos GOV_FINOPS_*, mensagens em português. */
const prodProtected = (details) => govError(403, 'GOV_FINOPS_PROD_PROTECTED', 'O ambiente de produção não pode ser desligado por custo.', details);
const criticalNotDegradable = (details) => govError(422, 'GOV_FINOPS_CRITICAL_NOT_DEGRADABLE', 'Esta função é crítica e não pode ser degradada.', details);
const policyInvalid = (message, details) => govError(422, 'GOV_FINOPS_POLICY_INVALID', message, details);
const budgetNotFound = () => govError(404, 'GOV_BUDGET_NOT_FOUND', 'Orçamento não encontrado.');

module.exports = { prodProtected, criticalNotDegradable, policyInvalid, budgetNotFound };
