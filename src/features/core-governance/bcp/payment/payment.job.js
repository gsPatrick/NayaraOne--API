'use strict';

const normalize = require('../import/normalize');
const repository = require('./pending.repository');
const { alertKey, notifyUnreconciled } = require('./payment.alert');

/**
 * Passada de conciliação do pagamento emergencial numa empresa (M9-D833 §3.3), na transação do tenant. Para cada pendência aberta: procura a linha de saída do extrato (valor
 * igual em centavos, dia entre a data da operação e o prazo, ainda livre) e casa; sem linha e com o prazo vencido (hoje de Brasília depois do `deadlineOn`), alerta CRÍTICO uma vez por
 * dia. Devolve { open, matched, alerted }.
 */
async function reconcilePayments({ tenant, now = new Date(), transaction }) {
  const today = normalize.day(now);
  const summary = { open: 0, matched: 0, alerted: 0 };
  for (const pending of await repository.lockOpen(tenant.companyId, transaction)) {
    summary.open += 1;
    const line = await repository.findLine({ companyId: tenant.companyId, amountCents: pending.amountCents, from: pending.occurredOn, to: pending.deadlineOn }, transaction);
    if (line && (await repository.markMatched(tenant.companyId, pending.id, line, transaction))) { summary.matched += 1; continue; }
    const key = alertKey(pending.manualReference, today);
    if (today > pending.deadlineOn && pending.lastAlertKey !== key) {
      await notifyUnreconciled(tenant, pending, today, transaction);
      await repository.markAlerted(tenant.companyId, pending.id, key, transaction);
      summary.alerted += 1;
    }
  }
  return summary;
}

module.exports = { reconcilePayments };
