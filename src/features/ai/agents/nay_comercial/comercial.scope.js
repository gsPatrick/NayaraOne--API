'use strict';

// Livro do Marco 3 §18: "IA acessar outro cliente — Permission-aware retrieval/RLS" e "Corretor visualizar carteira alheia — Escopo".
// Toda leitura de oportunidade da NAY Comercial (resolvedores RULE, tools, capacidades novas e a rotina de lead esquecido) passa por
// aqui: quem tem `crm:opportunities:read:own` sem `:all` só obtém a oportunidade de que é responsável (`ownerUserId`); fora disso, a
// mesma resposta de "não encontrado" da outra empresa (não revela que a oportunidade existe). A regra é a do CRM
// (`resolveOpportunityOwnerScope`, opportunityScope.guard.js); aqui só se aplica.
const AppError = require('../../../../utils/AppError');
const { resolveOpportunityOwnerScope } = require('../../../crm/opportunityScope.guard');

const ALL = Object.freeze({ mode: 'ALL' });

const notFound = () => new AppError('Dado não encontrado.', 404, 'AI_CROSS_COMPANY_BLOCKED');

/** Escopo de carteira de quem pede pela NAY (`ruleInput` do roteador: { userId, permissions }). */
const scopeOfActor = (actor) => (actor ? resolveOpportunityOwnerScope({ permissions: actor.permissions || [], userId: actor.userId }) : ALL);

/**
 * Escopo no contexto de uma tool (toolCallPipeline): as permissões efetivas da tool são só os códigos da allowlist, então o escopo de
 * carteira vem das permissões do ATOR inteiro (`userPermissions`). Rotina do servidor (sem pessoa) não restringe por carteira.
 */
function scopeOfToolScope(scope = {}) {
  if (!scope.userId) return ALL;
  const permissions = Array.isArray(scope.userPermissions) ? scope.userPermissions : (scope.permissions || []);
  return resolveOpportunityOwnerScope({ permissions, userId: scope.userId });
}

const visible = (opportunity, scope) => !scope || scope.mode !== 'OWN' || (opportunity && opportunity.ownerUserId === scope.userId);

/** Oportunidade fora da carteira de quem pede: 404 igual ao de inexistente. */
function assertVisible(opportunity, scope) {
  if (!visible(opportunity, scope)) throw notFound();
  return opportunity;
}

/** Filtro `where` de oportunidades para o escopo (OWN acrescenta o responsável). */
const ownerWhere = (scope) => (scope && scope.mode === 'OWN' ? { ownerUserId: scope.userId } : {});

module.exports = { ALL, scopeOfActor, scopeOfToolScope, assertVisible, visible, ownerWhere, notFound };
