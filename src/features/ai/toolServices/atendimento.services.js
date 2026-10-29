'use strict';

// Serviços da NAY Atendimento (M9-D041) que as tools do canal chamam: status público do contato, anúncios públicos e encaminhamento
// a uma pessoa. Nunca recebem id de contato do modelo: o contato é o do contexto (`scope.externalContactId`, definido pelo servidor).
const opportunityService = require('../../crm/opportunity.service');
const personService = require('../../people/person.service');
const recommendations = require('../recommendations');
const support = require('../readmodels/atendimentoSupport.readmodel');
const { loadAtendimentoParams } = require('../agents/nay_atendimento/atendimento.params');

const AGENT_CODE = 'NAY_ATENDIMENTO';
const TOPIC_LABEL = Object.freeze({
  FORA_DA_POLITICA: 'pedido fora da política', CANAL_EXTERNO: 'envio por canal externo', SOLICITACAO_HUMANA: 'pedido de atendente', OUTRO: 'outro assunto',
});
const brl = (valor) => `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tenantOf = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId });

/** Status do contato do canal: só contagens por etapa, nunca dado pessoal. Contato desconhecido (ou de outra empresa) é "não identificado". */
function contactStatus(transaction, scope) {
  return {
    async get() {
      const id = scope.externalContactId;
      if (!id) return { known: false, opportunities: 0, byStage: {} };
      try { await personService.getPerson(id, transaction); } catch (err) { return { known: false, opportunities: 0, byStage: {} }; }
      const lista = await opportunityService.listOpportunities(transaction, { personId: id });
      const byStage = {};
      for (const o of lista) byStage[o.stage] = (byStage[o.stage] || 0) + 1;
      return { known: true, opportunities: lista.length, byStage };
    },
  };
}

/** Anúncios públicos (read model público do M9-D231), no máximo `ia.atendimento.max_anuncios`. Preço já formatado: é o texto que a resposta repete. */
function publicListings(transaction, scope) {
  return {
    async list(limit) {
      const params = await loadAtendimentoParams(tenantOf(scope), transaction);
      const teto = Math.min(Number.isInteger(limit) ? limit : params.maxAnuncios, params.maxAnuncios);
      const rows = await support.listPublicListings(scope.companyId, teto, transaction);
      return {
        total: rows.length,
        items: rows.map((r) => ({
          code: r.public_code, title: r.title, purpose: r.purpose, type: r.type, price: brl(r.price_public), neighborhood: r.neighborhood, city: r.city, bedrooms: r.bedrooms,
        })),
      };
    },
  };
}

/**
 * Encaminhamento a uma pessoa. Quem chama é a identidade de serviço (só leitura, D017): em vez de tarefa, vira recomendação informativa
 * HANDOFF, sem `proposed_action`, dirigida ao responsável do papel `ia.atendimento.papel_handoff`; ele a marca como vista e abre a
 * tarefa pelas rotas normais do CRM. Quando uma pessoa interna aprova a tool (D019), o efeito é o mesmo registro.
 */
function handoff(transaction, scope) {
  return {
    async create({ topic, summary }) {
      const params = await loadAtendimentoParams(tenantOf(scope), transaction);
      const responsible = await support.findHandoffResponsible(scope.companyId, params.papelHandoff, transaction);
      const contact = scope.externalContactId;
      // Um encaminhamento por conversa: a entidade é o run (a deduplicação da recomendação é por agente + entidade + tipo + dia, e dois pedidos do mesmo contato no dia são dois encaminhamentos).
      const entityId = scope.runId || scope.userId;
      const ctx = { groupId: scope.groupId, companyId: scope.companyId, userId: scope.userId || null, serviceIdentity: !scope.userId };
      const { recommendation, replayed } = await recommendations.createRecommendation(ctx, {
        agentCode: AGENT_CODE, aiRunId: scope.runId || undefined, relatedEntityType: scope.runId ? 'AiRun' : 'User', relatedEntityId: entityId, recommendationType: 'HANDOFF',
        title: `Atendimento: ${TOPIC_LABEL[topic] || TOPIC_LABEL.OUTRO}`, rationale: summary, riskLevel: 'MEDIUM', proposedAction: null,
        payload: { topic, contactIdentified: Boolean(contact), ...(contact ? { contactId: contact } : {}) }, targetUserId: responsible || undefined,
      }, transaction);
      return { recommendationId: recommendation.id, status: recommendation.status, replayed, assigned: Boolean(responsible) };
    },
  };
}

module.exports = { contactStatus, publicListings, handoff, AGENT_CODE, TOPIC_LABEL, brl };
