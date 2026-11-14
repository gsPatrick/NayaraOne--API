'use strict';

const { Op } = require('sequelize');
const { AuditLog, LegalDeadline, LegalCaseParty, EvidencePackage, Notice, User, Person, File, OutboxEvent } = require('../../../models');
const { label, formatDate, quote, describeOrigin } = require('../shared/legalTimelineText');
const { caseChange, deadlineChange, userIdsOf } = require('../shared/legalTimelineAudit');
const { getLegalCase } = require('./legal-case.service');

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
 * `summary` é o texto para gente (português, rótulos, nomes, data de Brasília — legalTimelineText.js); os dados crus
 * (códigos, ids, datas ISO) ficam em `details`.
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

const createdAtOf = (record) => (record.get ? record.get('created_at') || record.get('createdAt') : record.createdAt || record.created_at) || null;
const toTime = (value) => (value ? new Date(value).getTime() : 0);
const iso = (value) => (value ? new Date(value).toISOString() : null);

function fromAudit(log, type, text) {
  return { type, occurredAt: iso(log.occurredAt || createdAtOf(log)), referenceId: log.entityId, auditId: log.id, action: log.action, actorUserId: log.userId || null, summary: text.summary, details: text.details };
}

/** Nomes, arquivos e eventos citados, para o resumo em português (uma consulta por tipo; RLS vale). */
async function loadContext(deadlines, parties, logs, transaction) {
  const userIds = userIdsOf(logs);
  deadlines.forEach((d) => d.responsibleUserId && userIds.add(String(d.responsibleUserId)));
  const fileIds = deadlines.map((d) => d.sourceFileId).filter(Boolean);
  const outboxIds = deadlines.filter((d) => d.sourceEventType === 'OUTBOX_EVENT').map((d) => d.sourceEventId);
  const auditIds = deadlines.filter((d) => d.sourceEventType === 'AUDIT_LOG').map((d) => d.sourceEventId);
  const [users, people, files, outbox, audits] = await Promise.all([
    userIds.size ? User.findAll({ where: { id: [...userIds] }, attributes: ['id', 'name'], transaction }) : [],
    parties.length ? Person.findAll({ where: { id: parties.map((p) => p.personId) }, attributes: ['id', 'legalName'], transaction }) : [],
    fileIds.length ? File.findAll({ where: { id: fileIds }, attributes: ['id', 'fileName'], transaction }) : [],
    outboxIds.length ? OutboxEvent.findAll({ where: { id: outboxIds }, transaction }) : [],
    auditIds.length ? AuditLog.findAll({ where: { id: auditIds }, transaction }) : [],
  ]);
  const events = new Map([
    ...outbox.map((e) => [String(e.id), { kind: e.eventType, at: createdAtOf(e) }]),
    ...audits.map((e) => [String(e.id), { kind: e.action, at: e.occurredAt || createdAtOf(e) }]),
  ]);
  return {
    users: new Map(users.map((u) => [String(u.id), u.name])),
    people: new Map(people.map((p) => [String(p.id), p.legalName])),
    files: new Map(files.map((f) => [String(f.id), f])),
    events,
    deadlines: new Map(deadlines.map((d) => [String(d.id), d])),
  };
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
  const allDeadlineLogs = deadlineIds.length ? await AuditLog.findAll({ where: { entityType: 'LegalDeadline', entityId: { [Op.in]: deadlineIds } }, transaction }) : [];
  const deadlineLogs = allDeadlineLogs.filter((log) => log.action !== 'legal.deadline.create');
  // "Prazo cadastrado" mostra o prazo como nasceu (retrato da auditoria de criação); as mudanças vêm nas linhas seguintes.
  const created = new Map(allDeadlineLogs.filter((log) => log.action === 'legal.deadline.create').map((log) => [String(log.entityId), log.afterJson || {}]));
  const asCreated = (d) => ({ ...d.toJSON(), ...(created.get(String(d.id)) || {}) });
  const ctx = await loadContext(deadlines.map(asCreated), parties, [...caseLogs, ...allDeadlineLogs], transaction);
  ctx.deadlines = new Map(deadlines.map((d) => [String(d.id), d]));

  const items = [
    {
      type: TYPES.CASE_OPENED, occurredAt: iso(createdAtOf(legalCase)), referenceId: legalCase.id,
      summary: `Processo aberto (${label('caseType', legalCase.caseType)})${legalCase.caseNumber ? ` nº ${legalCase.caseNumber}` : ''}.`,
      details: { caseType: legalCase.caseType, caseNumber: legalCase.caseNumber || null },
    },
    ...caseLogs.map((log) => fromAudit(log, TYPES.CASE_CHANGE, caseChange(log, ctx))),
    ...parties.map((p) => ({
      type: TYPES.PARTY, occurredAt: iso(createdAtOf(p)), referenceId: p.id,
      summary: `Parte incluída: ${ctx.people.get(String(p.personId)) || 'pessoa não identificada'} como ${label('partyRole', p.partyRole)}.`,
      details: { personId: p.personId, partyRole: p.partyRole },
    })),
    ...deadlines.map(asCreated).map((d) => ({
      type: TYPES.DEADLINE, occurredAt: iso(createdAtOf(d)), referenceId: d.id,
      summary: `Prazo cadastrado: ${quote(d.description)} — vence em ${formatDate(d.dueAt)} (horário de Brasília), criticidade ${label('criticality', d.criticality)}, `
        + `responsável ${ctx.users.get(String(d.responsibleUserId || legalCase.responsibleUserId)) || 'o do processo'}, origem: ${describeOrigin(d, ctx)}.`,
      details: { dueAt: iso(d.dueAt), criticality: d.criticality, status: d.status, responsibleUserId: d.responsibleUserId || null, sourceFileId: d.sourceFileId || null, sourceEventId: d.sourceEventId || null, sourceEventType: d.sourceEventType || null, sourceDocument: d.sourceDocument || null, sourceEvent: d.sourceEvent || null, taskId: d.taskId || null },
    })),
    ...deadlineLogs.map((log) => fromAudit(log, TYPES.DEADLINE_CHANGE, deadlineChange(log, ctx))),
    ...packages.map((p) => ({
      type: TYPES.EVIDENCE_PACKAGE, occurredAt: iso(createdAtOf(p)), referenceId: p.id,
      summary: `Dossiê de provas gerado com ${Array.isArray(p.manifestJson) ? p.manifestJson.length : 0} item(ns) e hash de integridade.`,
      details: { packageHash: p.packageHash, itemCount: Array.isArray(p.manifestJson) ? p.manifestJson.length : 0 },
    })),
    ...notices.map((n) => ({
      type: TYPES.NOTICE, occurredAt: iso(n.sentAt || createdAtOf(n)), referenceId: n.id,
      summary: `Notificação por ${label('channel', n.channel)} — ${label('noticeStatus', n.status)}${n.sentAt ? ` em ${formatDate(n.sentAt)}` : ''}.`,
      details: { channel: n.channel, status: n.status, sentAt: iso(n.sentAt), currentVersion: n.currentVersion },
    })),
  ];
  items.sort((a, b) => toTime(a.occurredAt) - toTime(b.occurredAt));
  return { legalCaseId: legalCase.id, items };
}

module.exports = { TYPES, getLegalCaseTimeline };
