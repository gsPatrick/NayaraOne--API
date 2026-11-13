'use strict';

const { Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Escopo de carteira (livro do Marco 3 §18 "Corretor visualizar carteira alheia — Escopo conforme política de equipe";
 * CRM-TS-012). Gestor (`crm:opportunities:read:all`) vê tudo; corretor (`crm:opportunities:read:own`) só a própria carteira;
 * sem nenhuma das duas (papel antigo), ALL, sem regressão. Antes o escopo valia só na listagem: o corretor abria, editava,
 * via a linha do tempo e as tarefas de oportunidade de outro corretor pelo id. A guarda vale para toda rota com o id da
 * oportunidade e responde 404 (não revela que a oportunidade existe).
 */
function resolveOpportunityOwnerScope(auth) {
  const permissions = (auth && auth.permissions) || [];
  if (permissions.includes('crm:opportunities:read:all')) return { mode: 'ALL' };
  if (permissions.includes('crm:opportunities:read:own')) return { mode: 'OWN', userId: auth.userId };
  return { mode: 'ALL' };
}

function requireOpportunityInScope(req, res, next) {
  const scope = resolveOpportunityOwnerScope(req.auth);
  if (scope.mode !== 'OWN') return next();
  return req
    .withTenantTransaction((transaction) => Opportunity.findByPk(req.params.id, { attributes: ['id', 'ownerUserId'], transaction }))
    .then((opportunity) => {
      if (opportunity && opportunity.ownerUserId !== scope.userId) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
      return next();
    })
    .catch(next);
}

module.exports = { resolveOpportunityOwnerScope, requireOpportunityInScope };
