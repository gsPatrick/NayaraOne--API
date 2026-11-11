'use strict';

const { Op } = require('sequelize');
const { AuditLog, LegalDeadline, LegalCaseParty, EvidencePackage, Notice } = require('../../models');
const { getLegalCase } = require('./legalCases.service');

/**
 * Linha do tempo do processo (Caderno M5 §14 "Movimentação relevante gera timeline"). Mesma
 * decisão da timeline do contrato (contractTimeline.service.js, AUD-017): DERIVADA na leitura, a
 * partir das próprias entidades e da trilha de auditoria append-only (core.audit_logs) — nada a
 * sincronizar e o RLS de cada tabela de origem continua valendo (processo de outra empresa = 404).
 *
 * Entra: abertura do processo; toda alteração auditada do processo (status, fase, responsável,
 * legal hold, documento vinculado); partes; prazos (criação e cada alteração auditada: conclusão,
 * remarcação com o motivo, troca de responsável, escalonamento e ocorrência do job); dossiês;
 * notificações ligadas ao processo.
 */
const TYPES = {
  CASE_OPENED: 'CASE_OPENED',
  CASE_CHANGE: 'CASE_CHANGE',
  PARTY: 'PARTY',
  DEADLINE: 'DEADLINE',
  DEADLINE_CHANGE: 'DEADLINE_CHANGE',
  EVIDENCE_PACKAGE: 'EVIDENCE_PACKAGE',
  NOTICE: 'NOTICE',
};

const createdAtOf = (record) => (record.get ? record.get('created_at') || record.get('createdAt') : record.createdAt) || null;
const toTime = (value) => (value ? new Date(value).getTime() : 0);

function fromAudit(log, type) {
  return { type, occurredAt: log.occurredAt || createdAtOf(log), referenceId: log.entityId, auditId: log.id, action: log.action, actorUserId: log.userId || null, summary: log.reason || log.action };
}

async function getLegalCaseTimeline(legalCaseId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const [parties, deadlines, packages, notices, caseLogs] = await Promise.all([
    LegalCaseParty.findAll({ where: { legalCaseId: legalCase.id }, transaction }),
    LegalDeadline.findAll({ where: { legalCaseId: legalCase.id }, transaction }),
    EvidencePackage.findAll({ where: { legalCaseId: legalCase.id }, transaction }),
    Notice.findAll({ where: { legalCaseId: legalCase.id }, transaction }),
    AuditLog.findAll({ where: { entityType: 'LegalCase', entityId: legalCase.id, action: { [Op.ne]: 'legal.case.create' } }, transaction }),
  ]);
  const deadlineIds = deadlines.map((d) => d.id);
  const deadlineLogs = deadlineIds.length
    ? await AuditLog.findAll({ where: { entityType: 'LegalDeadline', entityId: { [Op.in]: deadlineIds }, action: { [Op.ne]: 'legal.deadline.create' } }, transaction })
    : [];

  const items = [
    { type: TYPES.CASE_OPENED, occurredAt: createdAtOf(legalCase), referenceId: legalCase.id, summary: `Processo aberto (${legalCase.caseType})${legalCase.caseNumber ? ` nº ${legalCase.caseNumber}` : ''}.` },
    ...caseLogs.map((log) => fromAudit(log, TYPES.CASE_CHANGE)),
    ...parties.map((p) => ({ type: TYPES.PARTY, occurredAt: createdAtOf(p), referenceId: p.id, summary: `Parte ${p.partyRole} incluída (pessoa ${p.personId}).` })),
    ...deadlines.map((d) => ({
      type: TYPES.DEADLINE,
      occurredAt: createdAtOf(d),
      referenceId: d.id,
      summary: `Prazo cadastrado: ${d.description} (vence ${new Date(d.dueAt).toISOString()}, criticidade ${d.criticality}, origem ${d.sourceDocument || d.sourceEvent}).`,
    })),
    ...deadlineLogs.map((log) => fromAudit(log, TYPES.DEADLINE_CHANGE)),
    ...packages.map((p) => ({ type: TYPES.EVIDENCE_PACKAGE, occurredAt: createdAtOf(p), referenceId: p.id, summary: `Dossiê gerado com ${Array.isArray(p.manifestJson) ? p.manifestJson.length : 0} item(ns), hash ${p.packageHash}.` })),
    ...notices.map((n) => ({ type: TYPES.NOTICE, occurredAt: n.sentAt || createdAtOf(n), referenceId: n.id, summary: `Notificação (${n.channel}, status ${n.status}).` })),
  ];
  items.sort((a, b) => toTime(a.occurredAt) - toTime(b.occurredAt));
  return { legalCaseId: legalCase.id, items };
}

module.exports = { TYPES, getLegalCaseTimeline };
