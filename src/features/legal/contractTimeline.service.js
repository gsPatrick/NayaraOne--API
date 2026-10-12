'use strict';

const { Contract, ContractAmendment, Notice, CollectionCase, Inspection, InspectionItem, AuditLog } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * contractTimeline.service.js — FIX AUD-017 (auditoria externa Nayara, 11/10/2026, JUR-012
 * "Timeline consolidada com aditivos, notificações, inadimplência e reparos — Não encontrada
 * como timeline unificada"): cada fonte vivia isolada (aditivos em ContractAmendment,
 * notificações em Notice, inadimplência em CollectionCase, reparo/dano em InspectionItem) —
 * quem olhava o contrato precisava abrir 4 telas pra reconstruir a história dele.
 *
 * Mesma decisão de engenharia já usada em crm/opportunityTimeline.service.js (M3-19):
 * timeline DERIVADA na leitura, não uma tabela nova de eventos — nada a sincronizar, nenhum
 * risco de divergir das entidades de origem, RLS de cada tabela de origem continua valendo
 * (um contrato de outra empresa nem é encontrado).
 */

const TYPES = {
  AMENDMENT: 'AMENDMENT',
  NOTICE: 'NOTICE',
  DELINQUENCY: 'DELINQUENCY',
  REPAIR: 'REPAIR',
  STATUS_CHANGE: 'STATUS_CHANGE',
};

function createdAtOf(record) {
  return record.createdAt || record.get('created_at') || null;
}

function toTime(value) {
  return value ? new Date(value).getTime() : 0;
}

async function getContractTimeline(contractId, transaction) {
  if (!contractId) {
    throw AppError.badRequest('O campo "contractId" é obrigatório.', 'LEGAL_CONTRACT_TIMELINE_VALIDATION');
  }
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) {
    throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  }

  const items = [];

  // Aditivos.
  const amendments = await ContractAmendment.findAll({ where: { contractId }, transaction });
  for (const amendment of amendments) {
    items.push({
      type: TYPES.AMENDMENT,
      occurredAt: createdAtOf(amendment),
      referenceId: amendment.id,
      summary: `Aditivo nº ${amendment.amendmentNumber} (${amendment.status}): ${amendment.reason}`,
    });
  }

  // Notificações (extrajudiciais, avisos de inadimplência, comunicações formais).
  const notices = await Notice.findAll({ where: { contractId }, transaction });
  for (const notice of notices) {
    items.push({
      type: TYPES.NOTICE,
      occurredAt: notice.sentAt || createdAtOf(notice),
      referenceId: notice.id,
      summary: `Notificação (${notice.channel}, status ${notice.status})${notice.isLegallySensitive ? ' — sensível' : ''}`,
    });
  }

  // Inadimplência (fila de cobrança em atraso).
  const collectionCases = await CollectionCase.findAll({ where: { contractId }, transaction });
  for (const collectionCase of collectionCases) {
    items.push({
      type: TYPES.DELINQUENCY,
      occurredAt: collectionCase.overdueSince || createdAtOf(collectionCase),
      referenceId: collectionCase.id,
      summary: `Inadimplência (${collectionCase.status}): saldo em atraso de ${collectionCase.currentBalance}, desde ${collectionCase.overdueSince}`,
    });
  }

  // Reparos (dano identificado em vistoria vinculada ao contrato).
  const inspections = await Inspection.findAll({ where: { contractId }, transaction });
  for (const inspection of inspections) {
    const damagedItems = await InspectionItem.findAll({ where: { inspectionId: inspection.id, condition: 'DAMAGED' }, transaction });
    for (const item of damagedItems) {
      items.push({
        type: TYPES.REPAIR,
        occurredAt: createdAtOf(item),
        referenceId: item.id,
        summary: `Dano em "${item.itemName}" (vistoria ${inspection.inspectionType}): ${item.damageDescription || 'sem descrição'}${item.estimatedBudget ? `, orçamento estimado ${item.estimatedBudget}` : ''}`,
      });
    }
  }

  // Mudanças de status do próprio contrato (vêm do audit log, registro permanente append-only).
  const statusChanges = await AuditLog.findAll({
    where: { entityType: 'Contract', entityId: contractId, action: 'legal.contract.status_change' },
    transaction,
  });
  for (const log of statusChanges) {
    const before = log.beforeJson && log.beforeJson.status;
    const after = log.afterJson && log.afterJson.status;
    items.push({
      type: TYPES.STATUS_CHANGE,
      occurredAt: log.occurredAt || createdAtOf(log),
      referenceId: log.id,
      summary: `Status mudou de "${before}" para "${after}"`,
    });
  }

  items.sort((a, b) => toTime(a.occurredAt) - toTime(b.occurredAt));

  return { contractId, items };
}

module.exports = {
  TYPES,
  getContractTimeline,
};
