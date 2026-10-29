'use strict';

// M9-D034 — capacidade 2: sugerir a próxima ação. Regra de código primeiro (nextActionRules); sem regra, devolve null e um modelo
// pequeno redige a sugestão a partir dos fatos. A sugestão é TEXTO e uma recomendação NEXT_ACTION (risco LOW, sem ação proposta).
const { nextActionRules } = require('./comercial.rules');
const { dateBR, plural } = require('./comercial.format');

const REASON = Object.freeze({
  RETOMAR_CONTATO: (d) => `Sem contato há ${d.days} ${plural(d.days, 'dia', 'dias')} (o alerta é a partir de ${d.limit} ${plural(d.limit, 'dia', 'dias')}).`,
  FOLLOW_UP_PROPOSTA: (d) => `${d.count > 1 ? `${d.count} propostas enviadas` : 'Proposta enviada'} sem resposta, a mais antiga há ${d.days} ${plural(d.days, 'dia', 'dias')} (o alerta é a partir de ${d.limit} ${plural(d.limit, 'dia', 'dias')}).`,
  COBRAR_DOCUMENTOS: (d) => `Documentos pendentes: ${d.documents.join(', ')}.`,
});

function nextActionResult(facts, params) {
  const verdict = nextActionRules(facts, params);
  if (!verdict) return null;
  const base = {
    snapshotAt: facts.asOf,
    sources: [{
      sourceType: 'READ_MODEL', sourceRef: `crm.opportunities:${facts.opportunityId}`, title: 'crm.opportunities', retrievedAt: facts.asOf,
      text: `Oportunidade ${facts.opportunityId}. Etapa ${facts.stage}. Última interação: ${facts.lastInteractionAt ? dateBR(facts.lastInteractionAt) : 'nenhuma'}. Dias sem contato: ${facts.daysWithoutContact}. Documentos pendentes: ${facts.pendingDocuments.join(', ') || 'nenhum'}.`,
    }],
  };
  if (verdict.title === null) {
    return { ...base, answer: `A oportunidade está encerrada (etapa ${facts.stage}); não há próxima ação a sugerir [1].`, meta: { rule: verdict.rule, opportunityId: facts.opportunityId, recommend: false } };
  }
  const reasons = verdict.all.map((m) => REASON[m.rule](m.detail));
  const outras = verdict.all.slice(1).map((m) => m.title);
  const answer = [`Próxima ação sugerida: ${verdict.title} [1].`, reasons[0], outras.length ? `Também vale: ${outras.join('; ')}.` : null].filter(Boolean).join(' ');
  return {
    ...base,
    answer,
    meta: { rule: verdict.rule, matched: verdict.matched, title: verdict.title, rationale: reasons.join(' '), opportunityId: facts.opportunityId, recommend: true },
  };
}

module.exports = { nextActionResult };
