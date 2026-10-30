'use strict';

const { govError } = require('../../governance.errors');

/** Erros dos orçamentos (M9-D861 §4): códigos GOV_BUDGET_*, mensagens em português. */
const amountInvalid = () => govError(422, 'GOV_BUDGET_AMOUNT_INVALID', 'O orçamento deve ser maior que zero.');
const duplicate = () => govError(409, 'GOV_BUDGET_DUPLICATE', 'Já existe orçamento para este escopo.');
const ownerRequired = () => govError(422, 'GOV_BUDGET_OWNER_REQUIRED', 'Informe o responsável pelo orçamento.');
const ownerInvalid = () => govError(422, 'GOV_BUDGET_OWNER_INVALID', 'O responsável deve ser uma pessoa ativa desta empresa.');
const scopeInvalid = (message, details) => govError(422, 'GOV_BUDGET_SCOPE_INVALID', message, details);
const notFound = () => govError(404, 'GOV_BUDGET_NOT_FOUND', 'Orçamento não encontrado.');

module.exports = { amountInvalid, duplicate, ownerRequired, ownerInvalid, scopeInvalid, notFound };
