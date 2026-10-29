'use strict';

const logger = require('../../utils/logger');
const { reconcilePayments } = require('../../features/core-governance/bcp/payment/payment.job');
const { runForEachCompany } = require('./calendarJobRunner');

/**
 * bcpPaymentReconciliationJob (M9-D833 §3.3) — casa os pagamentos emergenciais do BCP com o extrato bancário e alerta (CRÍTICO, uma vez por dia) o que passou do prazo em dias úteis.
 * Roda a cada 30 minutos; por empresa, só se o módulo BCP estiver ligado. Desligar no processo: BCP_PAYMENT_RECONCILIATION_JOB_DISABLED=true.
 */
const TICK_MS = 30 * 60 * 1000;

const runBcpPaymentReconciliationJob = (now = new Date()) => runForEachCompany('bcpPaymentReconciliationJob', (tenant, transaction) => reconcilePayments({ tenant, now, transaction }), 'bcp');

function startBcpPaymentReconciliationJob({ intervalMs = TICK_MS } = {}) {
  const tick = () => runBcpPaymentReconciliationJob().catch((err) => logger.error({ err: err.message }, 'bcpPaymentReconciliationJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runBcpPaymentReconciliationJob, startBcpPaymentReconciliationJob };
