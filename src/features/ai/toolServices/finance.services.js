'use strict';

// Os números financeiros vêm do relatório do sistema (read model determinístico); a NAY nunca calcula (M9-D026).
const { getWeeklyHealthReport } = require('../../../modules/finance/application/services/finance-health.service');
const paymentIntents = require('../../../modules/finance/application/services/payment.service');
const { toPlain } = require('./plain');

const ZERO = { count: 0, total: 0 };

function financeHealth(transaction) {
  return {
    getWeekly: async () => toPlain(await getWeeklyHealthReport(transaction)),
    async getDelinquency() {
      const r = await getWeeklyHealthReport(transaction);
      return {
        generatedAt: r.generatedAt,
        overdueReceivable: r.overdue.receivable || ZERO,
        overduePayable: r.overdue.payable || ZERO,
        overdueTotal: r.overdue.total,
        delinquencyRatio: r.delinquencyRatio,
      };
    },
  };
}

/** Escrita (proposta aprovada): cria a intenção de pagamento; pagar/submeter ao banco continua em fluxo próprio com MFA. */
function financePayments(transaction, { userId }) {
  return {
    async proposeIntent(financialEntryId) {
      const intent = toPlain(await paymentIntents.createPaymentIntent({ financialEntryId }, userId, transaction));
      return { id: intent.id, status: intent.status, financialEntryId: intent.financialEntryId };
    },
  };
}

module.exports = { financeHealth, financePayments };
