'use strict';

const { Op } = require('sequelize');
const { BankStatementEntry, IntegrationDispatch, PaymentIntent } = require('../../../../../models');
const { registrarAuditoria } = require('../../../../../engines/audit/auditLog.service');
const { tenantTx } = require('../../../../../features/integrations/dispatch/worker/tenantTx');
const { readBankParams } = require('./bank.params');
const { PAYMENT_AGGREGATE } = require('./bank.constants');
const { toCents } = require('./bank.money');
const { recordAmountMismatch } = require('./bank.mismatch');

const DAY_MS = 86400000;
const BATCH = 500;
const normalName = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** O envio casa com a entrada pelo id externo do pagamento (o valor decide conciliado ou divergente) ou por (valor, favorecido, data dentro da tolerância). */
function matchEntry(entry, candidatos, tolerancia) {
  const cents = toCents(entry.amount);
  if (entry.externalPaymentId) {
    const porId = candidatos.find((d) => d.externalResourceId && d.externalResourceId === entry.externalPaymentId);
    if (porId) return { dispatch: porId, how: 'EXTERNAL_ID', equal: toCents(porId.payloadSnapshot.amount) === cents };
  }
  const nome = normalName(entry.payeeName);
  const dia = new Date(entry.bookedAt).getTime();
  const porValor = candidatos.find((d) => toCents(d.payloadSnapshot.amount) === cents && nome && normalName(d.payloadSnapshot.payee && d.payloadSnapshot.payee.name) === nome
    && Math.abs(dia - new Date(d.created_at || d.createdAt).getTime()) <= (tolerancia + 1) * DAY_MS);
  return porValor ? { dispatch: porValor, how: 'AMOUNT_PAYEE_DATE', equal: true } : null;
}

async function markReconciled(ctx, entry, dispatch, how, transaction) {
  const agora = new Date();
  await entry.update({ reconciliationStatus: 'RECONCILED', paymentIntentId: dispatch.aggregateId, reconciledAt: agora }, { transaction });
  const intent = await PaymentIntent.findByPk(dispatch.aggregateId, { transaction, lock: transaction.LOCK.UPDATE });
  if (intent) {
    await intent.update({ reconciledAt: agora, reconciledEntryId: entry.id }, { transaction });
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'finance.payment_intent.reconciled_with_statement', entityType: 'PaymentIntent', entityId: intent.id,
      beforeJson: { reconciledAt: null }, afterJson: { reconciledAt: agora, entryId: entry.entryId, how, dispatchStatus: dispatch.status }, reason: 'A saída do extrato do banco confere com o pagamento: conciliado (o estado do pagamento não muda).',
    }, transaction);
  }
}

/**
 * Concilia o extrato com os pagamentos (M9-D237 3.3 item 3): as saídas ainda PENDING contra os envios de pagamento SUBMITTED, UNKNOWN ou CONFIRMED que ainda não foram
 * conciliados. Valor igual em centavos: a entrada vira RECONCILED e a intenção fica "conciliada" no Financeiro; o envio NÃO muda de estado (conciliar não confirma). Valor
 * diferente quando o id externo casa: a entrada vira MISMATCH e abre o erro CRITICAL INTEGRATION_BANK_AMOUNT_MISMATCH (revisão humana). Devolve { reconciled, mismatched }.
 */
async function reconcileStatements({ group, company }) {
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  return tenantTx(ctx, async (transaction) => {
    const { dateToleranceDays } = await readBankParams(ctx, transaction);
    const entradas = await BankStatementEntry.findAll({ where: { reconciliationStatus: 'PENDING', direction: 'OUT' }, order: [['bookedAt', 'ASC']], limit: BATCH, transaction, lock: transaction.LOCK.UPDATE });
    const resultado = { reconciled: 0, mismatched: 0 };
    if (!entradas.length) return resultado;
    const pendentes = await PaymentIntent.findAll({ where: { reconciledAt: null, status: { [Op.in]: ['EXECUTING', 'CONFIRMED'] } }, attributes: ['id'], transaction });
    if (!pendentes.length) return resultado;
    let candidatos = await IntegrationDispatch.findAll({
      where: { companyId: ctx.companyId, aggregateType: PAYMENT_AGGREGATE, status: { [Op.in]: ['SUBMITTED', 'UNKNOWN', 'CONFIRMED'] }, aggregateId: { [Op.in]: pendentes.map((p) => p.id) } }, order: [['created_at', 'ASC']], transaction,
    });
    for (const entrada of entradas) {
      const achado = matchEntry(entrada, candidatos, dateToleranceDays);
      if (!achado) continue;
      candidatos = candidatos.filter((d) => d.id !== achado.dispatch.id);
      if (achado.equal) {
        // eslint-disable-next-line no-await-in-loop
        await markReconciled(ctx, entrada, achado.dispatch, achado.how, transaction);
        resultado.reconciled += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await entrada.update({ reconciliationStatus: 'MISMATCH', paymentIntentId: achado.dispatch.aggregateId }, { transaction });
        // eslint-disable-next-line no-await-in-loop
        const intent = await PaymentIntent.findByPk(achado.dispatch.aggregateId, { transaction });
        // eslint-disable-next-line no-await-in-loop
        await recordAmountMismatch(intent, achado.dispatch, { source: 'SYNC', informedCents: toCents(entrada.amount), origin: 'STATEMENT' }, transaction);
        resultado.mismatched += 1;
      }
    }
    return resultado;
  });
}

module.exports = { reconcileStatements, matchEntry };
