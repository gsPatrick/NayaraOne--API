'use strict';

/**
 * Regras de código da próxima ação (M9-D034, AI-014: onde o código resolve, o modelo não decide). Ordem do livro:
 *  1. sem contato há mais de `daysWithoutContact` dias -> "Retomar contato";
 *  2. proposta enviada sem resposta há mais de `daysProposalNoReply` dias -> "Fazer follow-up da proposta";
 *  3. documentos pendentes -> "Cobrar documentos X".
 * Oportunidade encerrada não tem próxima ação. Devolve a primeira regra que vale (`rule`, `title`) e todas as que valem (`matched`),
 * ou `null` quando nenhuma vale (aí um modelo pequeno redige a sugestão a partir dos fatos).
 * `facts`: { closed, daysWithoutContact, proposals: [{ daysSinceSent, unanswered }], pendingDocuments: [texto] }.
 */
const RULES = Object.freeze({
  CLOSED: 'OPORTUNIDADE_ENCERRADA',
  NO_CONTACT: 'RETOMAR_CONTATO',
  PROPOSAL: 'FOLLOW_UP_PROPOSTA',
  DOCUMENTS: 'COBRAR_DOCUMENTOS',
});

function nextActionRules(facts, params) {
  if (facts.closed) return { rule: RULES.CLOSED, title: null, matched: [RULES.CLOSED], detail: { stage: facts.stage } };
  const matched = [];
  if (Number.isInteger(facts.daysWithoutContact) && facts.daysWithoutContact > params.daysWithoutContact) {
    matched.push({ rule: RULES.NO_CONTACT, title: 'Retomar contato', detail: { days: facts.daysWithoutContact, limit: params.daysWithoutContact } });
  }
  const stale = (facts.proposals || []).filter((p) => p.unanswered && Number.isInteger(p.daysSinceSent) && p.daysSinceSent > params.daysProposalNoReply);
  if (stale.length) {
    const oldest = Math.max(...stale.map((p) => p.daysSinceSent));
    matched.push({ rule: RULES.PROPOSAL, title: 'Fazer follow-up da proposta', detail: { days: oldest, limit: params.daysProposalNoReply, count: stale.length } });
  }
  if ((facts.pendingDocuments || []).length) {
    matched.push({ rule: RULES.DOCUMENTS, title: `Cobrar documentos ${facts.pendingDocuments.join(', ')}`, detail: { documents: facts.pendingDocuments } });
  }
  if (!matched.length) return null;
  return { rule: matched[0].rule, title: matched[0].title, detail: matched[0].detail, matched: matched.map((m) => m.rule), all: matched };
}

module.exports = { nextActionRules, RULES };
