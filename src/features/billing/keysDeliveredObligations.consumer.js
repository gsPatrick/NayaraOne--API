'use strict';

const { Contract, KeyDelivery, UtilityObligation, OwnershipTransferTask } = require('../../models');
const { registerEventConsumer } = require('../../engines/events/consumers');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getSetting } = require('../settings/settings.service');
const { nextDueDate } = require('./leaseObligationSchedule');

/**
 * Fechamento M5 (Caderno §10 "Evento keys.delivered inicia pós-chaves/cadências e obrigações"; M5-D103).
 * O pós-chaves e a cadência de relacionamento já são iniciados pelo Marketing (seeds/posChaves.js). Este consumidor
 * inicia as OBRIGAÇÕES da locação: cada obrigação do contrato ganha início (data da entrega, em São Paulo) e o
 * próximo vencimento pela periodicidade; cada troca de titularidade pendente ganha prazo = entrega +
 * `locacao.titularidade.prazo_dias` (o livro não fixa: padrão 30, o prazo que o job de vencidas já usava).
 * Idempotente: só preenche o que ainda está vazio — reentrega do evento não muda nada.
 */
const DEFAULT_TRANSFER_DAYS = 30;

function dateSaoPaulo(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function startLeaseObligationsOnKeysDelivered(event, transaction) {
  const payload = event.payload || event.payloadJson || {};
  const { isLeaseLikeContractType } = require('../legal/contracts.service');
  const contract = payload.contractId ? await Contract.findByPk(payload.contractId, { transaction }) : null;
  if (!contract || !isLeaseLikeContractType(contract.contractType)) return { started: 0, deadlines: 0, skipped: true };
  const delivery = payload.id ? await KeyDelivery.findByPk(payload.id, { transaction }) : null;
  const startsOn = dateSaoPaulo((delivery && delivery.deliveredAt) || event.occurredAt || new Date());
  const tenant = { groupId: contract.groupId, companyId: contract.companyId };
  const configured = Number(await getSetting('locacao.titularidade.prazo_dias', tenant, transaction, DEFAULT_TRANSFER_DAYS));
  const transferDays = Number.isInteger(configured) && configured >= 1 && configured <= 90 ? configured : DEFAULT_TRANSFER_DAYS;
  const origin = `keys.delivered:${payload.id}`;
  let started = 0;
  let deadlines = 0;
  const obligations = await UtilityObligation.findAll({ where: { contractId: contract.id }, transaction });
  for (const obligation of obligations) {
    if (!obligation.startsOn) {
      const before = { startsOn: null, nextDueOn: obligation.nextDueOn };
      obligation.startsOn = startsOn;
      obligation.nextDueOn = nextDueDate(startsOn, obligation.periodicity || 'MONTHLY', obligation.dueDay);
      await obligation.save({ transaction });
      started += 1;
      await registrarAuditoria({ ...tenant, actorUserId: null, action: 'billing.lease_obligation.start', entityType: 'UtilityObligation', entityId: obligation.id, beforeJson: before, afterJson: { startsOn: obligation.startsOn, nextDueOn: obligation.nextDueOn, origem: origin }, reason: `Obrigação iniciada pela entrega das chaves (${origin}).` }, transaction);
    }
    const tasks = await OwnershipTransferTask.findAll({ where: { utilityObligationId: obligation.id, status: 'PENDING', dueDate: null }, transaction });
    for (const task of tasks) {
      task.dueDate = addDays(startsOn, transferDays);
      await task.save({ transaction });
      deadlines += 1;
      await registrarAuditoria({ ...tenant, actorUserId: null, action: 'billing.ownership_transfer.deadline', entityType: 'OwnershipTransferTask', entityId: task.id, beforeJson: { dueDate: null }, afterJson: { dueDate: task.dueDate, prazoDias: transferDays, origem: origin }, reason: `Prazo da troca de titularidade contado da entrega das chaves (${transferDays} dias).` }, transaction);
    }
  }
  return { started, deadlines, startsOn, transferDays };
}

registerEventConsumer('keys.delivered', 'locacao.obrigacoes', startLeaseObligationsOnKeysDelivered);

module.exports = { startLeaseObligationsOnKeysDelivered, DEFAULT_TRANSFER_DAYS };
