'use strict';

/** Pagamento bancário sobre o registro de integração (Marco 9, M9-D237): constantes compartilhadas. */
const MISMATCH_CODE = 'INTEGRATION_BANK_AMOUNT_MISMATCH';
const MISMATCH_MESSAGE = 'O valor confirmado pelo banco difere do valor aprovado.';
/** Decisão humana que leva o envio de valor divergente a FAILED (resolução do erro, M9-D207). */
const DECISION_REJECT_PAYMENT = 'REJECT_PAYMENT';
/** Configuração do Financeiro -> código do fornecedor no catálogo. */
const PROVIDER_CODES = Object.freeze({ sandbox: 'bank-sandbox', santander: 'bank-santander' });
/** Status que o banco usa para "pago" (o Financeiro os trata todos como CONFIRMED). */
const PAID_STATUSES = Object.freeze(['CONFIRMED', 'PAID', 'SETTLED', 'COMPLETED']);
const STREAM = 'bank.statement';
const PAYMENT_AGGREGATE = 'PaymentIntent';
const CENTS_RE = /^-?\d+(\.\d{1,2})?$/;

const providerCodeOf = (key) => PROVIDER_CODES[String(key || 'sandbox').toLowerCase()] || null;
const isPaidStatus = (status) => PAID_STATUSES.includes(String(status || '').trim().toUpperCase());

module.exports = { MISMATCH_CODE, MISMATCH_MESSAGE, DECISION_REJECT_PAYMENT, PROVIDER_CODES, PAID_STATUSES, STREAM, PAYMENT_AGGREGATE, CENTS_RE, providerCodeOf, isPaidStatus };
