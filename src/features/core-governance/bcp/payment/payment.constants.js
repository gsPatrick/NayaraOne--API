'use strict';

/** Constantes do pagamento manual emergencial (M9-D833). */
const ACTION = 'EMERGENCY_PAYMENT';
const ROLE = Object.freeze({ CHECKER_1: 'CHECKER_1', CHECKER_2: 'CHECKER_2' });
const APPROVE = 'governance:bcp:approve';
const EVENT_CHECKED = 'bcp.payment.checked';
const PENDING = Object.freeze({ OPEN: 'OPEN', MATCHED: 'MATCHED', CANCELED: 'CANCELED' });
const PAYMENT_REFUSALS = Object.freeze(['GOV_BCP_PAYMENT_DOUBLE_CHECK', 'GOV_BCP_PAYMENT_SAME_PERSON']);

module.exports = { ACTION, ROLE, APPROVE, EVENT_CHECKED, PENDING, PAYMENT_REFUSALS };
