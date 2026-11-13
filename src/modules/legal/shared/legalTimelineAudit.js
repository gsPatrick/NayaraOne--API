'use strict';

const { label, formatDate, money, quote } = require('./legalTimelineText');

/**
 * Resumo em português de cada linha da trilha de auditoria (audit.audit_log) que entra na linha do tempo do processo.
 * O `reason` da auditoria é técnico (traz ids e códigos): aqui o texto é montado a partir da ação e do antes/depois,
 * com rótulos e nomes. Os valores crus vão em `details` (estruturado, para tela e integração).
 */
const userName = (ctx, id) => (id ? ctx.users.get(String(id)) || 'usuário não identificado' : 'ninguém');
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, obj[k]]));

function caseChange(log, ctx) {
  const before = log.beforeJson || {};
  const after = log.afterJson || {};
  switch (log.action) {
    case 'legal.case.phase_change':
      return { summary: `Fase do processo alterada de ${label('phase', before.phase)} para ${label('phase', after.phase)}.`, details: { from: before.phase || null, to: after.phase || null } };
    case 'legal.case.legal_hold_set':
      return { summary: `Retenção legal (legal hold) ativada${after.legalHoldReason ? `: ${quote(after.legalHoldReason)}` : ''}.`, details: pick(after, ['legalHold', 'legalHoldReason', 'legalHoldSetAt']) };
    case 'legal.case.legal_hold_cleared':
      return { summary: 'Retenção legal (legal hold) removida.', details: pick(after, ['legalHold', 'legalHoldSetAt']) };
    case 'legal.case.document_link':
      return { summary: `Documento vinculado ao processo: ${quote(after.fileName || 'arquivo')} (${label('purpose', after.purpose)}).`, details: pick(after, ['fileLinkId', 'fileId', 'purpose', 'fileName', 'checksumSha256']) };
    case 'legal.case.receivable_link':
      return { summary: `Valor confirmado de ${money(after.amount)} vinculado ao Financeiro (${label('basis', after.basis)}: ${quote(after.basisReference || '')}).`, details: pick(after, ['financialEntryId', 'basis', 'basisReference', 'amount']) };
    default: {
      const changes = [];
      if (before.status !== after.status) changes.push(`situação de ${label('caseStatus', before.status)} para ${label('caseStatus', after.status)}`);
      if (before.responsibleUserId !== after.responsibleUserId) changes.push(`responsável de ${userName(ctx, before.responsibleUserId)} para ${userName(ctx, after.responsibleUserId)}`);
      if (before.escalationUserId !== after.escalationUserId) changes.push(`escalonamento de ${userName(ctx, before.escalationUserId)} para ${userName(ctx, after.escalationUserId)}`);
      if (String(before.estimatedAmount) !== String(after.estimatedAmount)) changes.push(`valor estimado de ${money(before.estimatedAmount)} para ${money(after.estimatedAmount)}`);
      if (String(before.confirmedAmount) !== String(after.confirmedAmount)) changes.push(`valor confirmado de ${money(before.confirmedAmount)} para ${money(after.confirmedAmount)}`);
      if (before.summary !== after.summary) changes.push('resumo');
      return {
        summary: changes.length ? `Processo atualizado: ${changes.join('; ')}.` : 'Processo atualizado.',
        details: { before: pick(before, ['status', 'phase', 'responsibleUserId', 'escalationUserId', 'estimatedAmount', 'confirmedAmount']), after: pick(after, ['status', 'phase', 'responsibleUserId', 'escalationUserId', 'estimatedAmount', 'confirmedAmount']) },
      };
    }
  }
}

function deadlineChange(log, ctx) {
  const before = log.beforeJson || {};
  const after = log.afterJson || {};
  const deadline = ctx.deadlines.get(String(log.entityId));
  const name = quote((deadline && deadline.description) || after.description || 'prazo');
  if (log.action === 'legal.deadline.job_alert') {
    return { summary: `Alerta automático do prazo ${name}: ${label('severity', after.severity)}.`, details: pick(after, ['severity', 'dueAt', 'firstOverdueAlertedAt']) };
  }
  if (log.action === 'legal.deadline.job_escalation') {
    return { summary: `Prazo ${name} escalado para ${userName(ctx, after.escalationUserId)} (vencido há mais de 24 horas sem ação).`, details: pick(after, ['escalatedAt', 'escalationUserId']) };
  }
  const parts = [];
  if (before.status !== after.status) {
    if (after.status === 'DONE') parts.push(`concluído${after.conclusionNote ? ` (${quote(after.conclusionNote)})` : ''}`);
    else if (after.status === 'CANCELLED') parts.push(`cancelado${after.cancelReason ? `: ${quote(after.cancelReason)}` : ''}`);
    else if (after.status === 'PENDING') parts.push('reaberto');
  }
  if (before.dueAt && after.dueAt && new Date(before.dueAt).getTime() !== new Date(after.dueAt).getTime()) {
    parts.push(`remarcado de ${formatDate(before.dueAt)} para ${formatDate(after.dueAt)}${log.reason ? ` — motivo: ${quote(log.reason)}` : ''}`);
  }
  if ((before.responsibleUserId || null) !== (after.responsibleUserId || null)) parts.push(`responsável de ${userName(ctx, before.responsibleUserId)} para ${userName(ctx, after.responsibleUserId)}`);
  if (before.criticality !== after.criticality) parts.push(`criticidade de ${label('criticality', before.criticality)} para ${label('criticality', after.criticality)}`);
  return {
    summary: parts.length ? `Prazo ${name}: ${parts.join('; ')}.` : `Prazo ${name} atualizado.`,
    details: { before: pick(before, ['status', 'dueAt', 'responsibleUserId', 'criticality']), after: pick(after, ['status', 'dueAt', 'responsibleUserId', 'criticality', 'conclusionNote', 'cancelReason']), changeReason: log.reason || null },
  };
}

/** Coleta os ids de usuário citados no antes/depois (para trocar id por nome). */
function userIdsOf(logs) {
  const ids = new Set();
  for (const log of logs) for (const j of [log.beforeJson, log.afterJson]) for (const k of ['responsibleUserId', 'escalationUserId']) if (j && j[k]) ids.add(String(j[k]));
  return ids;
}

module.exports = { caseChange, deadlineChange, userIdsOf };
