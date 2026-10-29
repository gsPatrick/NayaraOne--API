'use strict';

const { dueFromDateValue } = require('./time');
const { lifecycle, ownerOf } = require('./lifecycle');
const { SOURCE, RENEWAL_KIND } = require('./sources.constants');

/** Fontes LEGAL_DEADLINE e RENEWAL (renovação de apólice e de contrato) — M9-D802 §3.1.1. O prazo é a data às 23:59:59 de Brasília. */
const deadline = lifecycle(SOURCE.LEGAL_DEADLINE, (p, ctx) => {
  const dueAt = dueFromDateValue(p.dueAt);
  return dueAt && { title: p.description || 'Prazo jurídico', dueAt, deepLink: `/painel/juridico/prazos/${p.id}`, ...ownerOf(p.responsibleUserId, SOURCE.LEGAL_DEADLINE, ctx) };
});

const insuranceRenewal = lifecycle('RENEWAL', (p, ctx) => {
  const dueAt = dueFromDateValue(p.dueDate);
  return dueAt && {
    sourceKind: RENEWAL_KIND.INSURANCE,
    title: `Renovação da apólice ${p.policyNumber || ''}`,
    dueAt,
    deepLink: `/painel/seguros/renovacoes/${p.id}`,
    ...ownerOf(p.assignedToUserId, 'RENEWAL', ctx),
  };
});

const contractRenewal = lifecycle('RENEWAL', (p, ctx) => {
  const dueAt = dueFromDateValue(p.endsAt);
  return dueAt && {
    sourceKind: RENEWAL_KIND.CONTRACT,
    title: `Renovação do contrato ${p.contractNumber || ''}`,
    dueAt,
    deepLink: `/painel/contratos/${p.id}`,
    ...ownerOf(p.ownerUserId, 'RENEWAL', ctx),
  };
});

const EVENT_MAPPERS = {
  'legal.deadline.created': deadline.upsert,
  'legal.deadline.updated': deadline.upsert,
  'legal.deadline.completed': deadline.done,
  'legal.deadline.cancelled': deadline.cancelled,
  'legal.deadline.reopened': deadline.reopen,
  'insurance.renewal_task.upserted': insuranceRenewal.upsert,
  'insurance.renewal_task.completed': insuranceRenewal.done,
  'insurance.renewal_task.cancelled': insuranceRenewal.cancelled,
  'contract.renewal.upserted': contractRenewal.upsert,
  'contract.renewal.completed': contractRenewal.done,
  'contract.renewal.cancelled': contractRenewal.cancelled,
};

module.exports = { EVENT_MAPPERS };
