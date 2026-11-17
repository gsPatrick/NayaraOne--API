'use strict';

const AppError = require('../../../../utils/AppError');
const { registerEventConsumer } = require('../../../../engines/events/consumers');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const financialEntryService = require('./financial-entry.service'); // pela referência do módulo: o drill de falha substitui a função
const { getOrCreateDefaultCostCenter } = require('./cost-centers.service');
const { KEYS: DUE_KEYS, generatedDueAt } = require('./generated-entry-due-settings');
const { measurementPayableDescription } = require('./measurement-payable.description');

/**
 * Consumidor do Financeiro para `measurement.approved` (Caderno Obras §7: "APPROVED gera measurement.approved; consumidor
 * Financeiro cria payable com source_event_id UNIQUE"; Guia §6: "Financeiro usa sourceEventId UNIQUE"). Verificação
 * independente do Marco 6, M6-21.
 *
 * A conta a pagar nasce do EVENTO: valor, obra, centro de custo e etapa vêm do payload gravado no outbox na aprovação.
 * Idempotente: o mesmo evento (source_event_id = id do evento no outbox, índice único no banco) nunca cria segunda
 * obrigação; a conta de medição criada antes deste consumidor (chave measurement.payable:<medição>) também é
 * reconhecida. Centro de custo: o da medição/obra que veio no evento; sem ele, o padrão de medições de obra
 * (createFinancialEntry exige centro de custo para despesa). Vencimento: dia da aprovação (instante do evento no outbox) + o prazo do parâmetro
 * financeiro.vencimento.medicao_aprovada_dias (padrão 30; generated-entry-due-settings.js). Descrição legível (obra, etapa, % medido e dia
 * da aprovação; measurement-payable.description.js), sem o id da medição: o vínculo é idempotencyKey + sourceEventId. Devolve a conta (nova ou já existente).
 */
const EVENT_TYPE = 'measurement.approved';
const CONSUMER_NAME = 'finance.contas-a-pagar.medicao-aprovada';
const MEASUREMENT_COST_CENTER_CODE = 'OBRAS-MEDICOES';

async function onMeasurementApproved(event, transaction) {
  const payload = event.payloadJson || event.payload || {};
  const existing = await entries.findBySourceEventId(event.id, transaction);
  if (existing) return existing;
  const legacy = payload.id ? await entries.findByIdempotencyKeyInCompany(`measurement.payable:${payload.id}`, event.companyId, transaction) : null;
  if (legacy) return legacy;

  const amount = Number(payload.totalAmount);
  if (!payload.id || !payload.projectId || !Number.isFinite(amount) || amount <= 0) {
    throw AppError.unprocessable('Evento measurement.approved sem medição, obra ou valor: a conta a pagar não pode ser criada.', 'FINANCE_MEASUREMENT_EVENT_INVALID', { eventId: event.id });
  }
  let costCenterId = payload.costCenterId || null;
  if (!costCenterId) {
    const fallback = await getOrCreateDefaultCostCenter(event.groupId, event.companyId, MEASUREMENT_COST_CENTER_CODE, 'Obras — medições', transaction);
    costCenterId = fallback.id;
  }
  const tenant = { groupId: event.groupId, companyId: event.companyId };
  const approvedAt = payload.approvedAt || event.occurredAt || event.createdAt || event.created_at;
  const dueAt = await generatedDueAt(DUE_KEYS.measurement, tenant, approvedAt, transaction);
  return financialEntryService.createFinancialEntry(
    {
      groupId: event.groupId,
      companyId: event.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: payload.totalAmount,
      description: measurementPayableDescription(payload, approvedAt),
      idempotencyKey: `measurement.payable:${payload.id}`,
      sourceEventId: event.id,
      constructionProjectId: payload.projectId,
      costCenterId,
      dueAt,
    },
    payload.approvedByUserId || null,
    transaction
  );
}

registerEventConsumer(EVENT_TYPE, CONSUMER_NAME, onMeasurementApproved);

module.exports = { EVENT_TYPE, CONSUMER_NAME, onMeasurementApproved };
