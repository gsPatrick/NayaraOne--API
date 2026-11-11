'use strict';

/**
 * Textos em português da linha do tempo do processo (legalCaseTimeline.service.js). O resumo (`summary`) é para gente:
 * rótulos no lugar de códigos, nomes no lugar de ids, data "dd/mm/aaaa hh:mm" no horário de Brasília e a origem do prazo
 * descrita pelo arquivo ou pelo evento. Os dados crus (códigos, ids, ISO) ficam à parte, em `details` de cada item.
 */
const LABELS = {
  caseType: { LITIGATION: 'contencioso', CONSULTATIVE: 'consultivo', COLLECTION: 'cobrança' },
  caseStatus: { OPEN: 'aberto', CLOSED: 'encerrado', ARCHIVED: 'arquivado', SUSPENDED: 'suspenso', CANCELLED: 'cancelado' },
  phase: { INITIAL_PETITION: 'petição inicial', DISCOVERY: 'instrução', TRIAL: 'julgamento', APPEAL: 'recurso', CLOSED: 'encerrado' },
  partyRole: { PLAINTIFF: 'autor', DEFENDANT: 'réu', WITNESS: 'testemunha', THIRD_PARTY: 'terceiro interessado' },
  criticality: { LOW: 'baixa', MEDIUM: 'média', HIGH: 'alta', CRITICAL: 'crítica' },
  deadlineStatus: { PENDING: 'pendente', DONE: 'concluído', CANCELLED: 'cancelado' },
  severity: { OVERDUE: 'vencido', DUE_SOON: 'vence em até 48 horas', NORMAL: 'no prazo' },
  channel: { EMAIL: 'e-mail', WHATSAPP: 'WhatsApp', POSTAL_MAIL: 'correio', IN_PERSON: 'em mãos', OTHER: 'outro canal' },
  noticeStatus: { DRAFT: 'rascunho', PENDING_REVIEW: 'em revisão', APPROVED: 'aprovada', SENT: 'enviada', DELIVERED: 'entregue', REJECTED: 'rejeitada' },
  purpose: { DOCUMENT: 'documento', EVIDENCE: 'prova', PETITION: 'petição', DECISION: 'decisão', NOTICE: 'notificação', OTHER: 'outro' },
  basis: { SETTLEMENT: 'acordo homologado', FINAL_JUDGMENT: 'sentença transitada em julgado' },
  event: {
    'legal.case.created': 'abertura do processo', 'legal.deadline.created': 'cadastro de prazo', 'legal.deadline.overdue': 'prazo vencido',
    'legal.notice.sent': 'envio de notificação', 'evidence.package.created': 'geração de dossiê', 'legal.case.create': 'abertura do processo',
    'legal.case.phase_change': 'mudança de fase', 'legal.case.document_link': 'vínculo de documento', 'legal.case.update': 'atualização do processo',
  },
};

const label = (group, value) => (value === null || value === undefined ? 'não informado' : LABELS[group][value] || 'não catalogado');

/** "03/11/2026 17:00" no horário de Brasília (America/Sao_Paulo). */
function formatDate(value) {
  if (!value) return 'data não informada';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'data não informada';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

const money = (value) => (value === null || value === undefined ? 'não informado' : Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const quote = (text) => `“${text}”`;

/** Origem do prazo descrita para gente: arquivo (nome), evento (o que foi e quando) ou o texto legado. */
function describeOrigin(deadline, ctx) {
  if (deadline.sourceFileId) {
    const file = ctx.files.get(String(deadline.sourceFileId));
    return file ? `arquivo ${quote(file.fileName)}` : 'arquivo da empresa';
  }
  if (deadline.sourceEventId) {
    const event = ctx.events.get(String(deadline.sourceEventId));
    return event ? `evento do sistema (${LABELS.event[event.kind] || 'registro do sistema'} em ${formatDate(event.at)})` : 'evento do sistema';
  }
  const text = deadline.sourceDocument || deadline.sourceEvent;
  return text ? quote(text) : 'não informada';
}

module.exports = { LABELS, label, formatDate, money, quote, describeOrigin };
