'use strict';

const { FinancialEntry } = require('../../../../../models');
const { createFinancialEntry, cancelPendingFinancialEntry } = require('../../../../../modules/finance/application/services/financial-entry.service');
const { resolveRef } = require('../refs');
const normalize = require('../normalize');
const { openPending } = require('../../payment/payment.pending');
const { cancelByOperation } = require('../../payment/pending.repository');

/** Chave de idempotência do lançamento: `bcp:<empresa>:<número>` (a empresa entra porque a chave do lançamento é única na plataforma e o número do papel só na empresa; DI-D832-3). */
const keyOf = (tenant, reference) => `bcp:${tenant.companyId}:${reference}`;

/** O favorecido e o documento ficam no INÍCIO da descrição (limite de 255 caracteres do lançamento), em formato fixo, e a conferência lê o que foi gravado. */
const describe = (operation, payload) => `BCP ${operation.manualReference} | Doc: ${normalize.digits(payload.documento)} | Favorecido: ${payload.favorecido} | Pagamento: ${payload.contaOuChavePix} | Motivo: ${payload.motivoUrgencia}`.slice(0, 255);
const documentOf = (description) => (/\| Doc: (\d+) \|/.exec(description || '') || [])[1] || '';

/**
 * EMERGENCY_PAYMENT: o pagamento do papel vira um lançamento A PAGAR (PENDING) pelo serviço normal do Financeiro, no centro de custo informado, com vencimento na data da
 * ocorrência. Nenhum dinheiro sai aqui: a saída bancária segue o fluxo normal (aprovação, intenção de pagamento e confirmação do banco). Confere valor, data e documento do favorecido.
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const costCenter = await resolveRef('costCenter', payload.centroCusto, tenant, transaction);
  const entry = await createFinancialEntry({
    groupId: tenant.groupId, companyId: tenant.companyId, costCenterId: costCenter.id, entryType: 'DEBIT', nature: 'PAYABLE', amount: payload.valorCentavos / 100,
    description: describe(operation, payload), dueAt: operation.occurredAt, idempotencyKey: keyOf(tenant, operation.manualReference), originRef: `bcp:${operation.manualReference}`,
  }, actorUserId, transaction);
  const saved = await FinancialEntry.findByPk(entry.id, { transaction });
  await openPending({ tenant, actorUserId, operation, amountCents: payload.valorCentavos, transaction }); // a conciliação com o extrato passa a ser cobrada (M9-D833)
  return {
    commandRef: `FinancialEntry:${saved.id}`,
    undo: { entryId: saved.id },
    comparisons: [
      { field: 'valorCentavos', label: 'Valor (centavos)', paper: normalize.cents(payload.valorCentavos), command: normalize.cents(saved.amount, { fromDecimal: true }), kind: 'cents' },
      { field: 'data', label: 'Data do pagamento', paper: normalize.day(operation.occurredAt), command: normalize.day(saved.dueAt), kind: 'date' },
      { field: 'documento', label: 'Documento do favorecido', paper: normalize.digits(payload.documento), command: normalize.digits(documentOf(saved.description)), kind: 'digits' },
    ],
  };
}

/** Estorno: o lançamento ainda não liquidado é cancelado pelo serviço normal (motivo registrado); se já foi pago, o serviço recusa e a recusa (422) segue como está. */
async function reverse({ actorUserId, effect, operation, transaction }) {
  await cancelPendingFinancialEntry(effect.entryId, `Estorno da operação manual ${operation.manualReference} (BCP)`, actorUserId, transaction);
  await cancelByOperation(operation.companyId, operation.id, transaction);
}

module.exports = { action: 'EMERGENCY_PAYMENT', execute, reverse, keyOf };
