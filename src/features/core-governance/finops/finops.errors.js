'use strict';

const { govError } = require('../governance.errors');

/** Erros do FinOps (M9-D860 §4): códigos GOV_FINOPS_*, mensagens em português. */
const amountInvalid = () => govError(422, 'GOV_FINOPS_AMOUNT_INVALID', 'O valor do custo não pode ser negativo.');
const lineInvalid = (message, details) => govError(422, 'GOV_FINOPS_LINE_INVALID', message, details);
const periodOpen = () => govError(422, 'GOV_FINOPS_PERIOD_OPEN', 'A fatura só pode ser importada para um período já fechado.');
const invoiceInvalid = (message, details) => govError(422, 'GOV_FINOPS_INVOICE_INVALID', message, details);
const collectorFailed = (collector, cause) => govError(500, 'GOV_FINOPS_COLLECTOR_FAILED', `O coletor de custo "${collector}" falhou; nenhum valor foi gravado e o último sucesso continua exibido.`, { collector, cause: cause && cause.message ? String(cause.message).slice(0, 300) : undefined });

module.exports = { amountInvalid, lineInvalid, periodOpen, invoiceInvalid, collectorFailed };
