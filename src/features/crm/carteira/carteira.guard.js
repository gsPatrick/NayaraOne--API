'use strict';

const AppError = require('../../../utils/AppError');
const { KINDS, carteiraOf, isOutOfScope, isOpportunityOutOfScope } = require('./carteira.scope');

/**
 * Guardas de rota da carteira (livro do Marco 3 §18, CRM-TS-012). Valem antes do handler, na transação de tenant da requisição; fora da
 * carteira, a resposta é o MESMO 404 do registro inexistente (não revela que existe). Gestor e papel antigo passam direto.
 */
const run = (req, next, fn) => req.withTenantTransaction((transaction) => fn(transaction)).then(() => next()).catch(next);

/** `/<recurso>/:param` — o registro do caminho precisa estar na carteira. */
function requireRecordInScope(kind, param = 'id') {
  const [message, code] = KINDS[kind].notFound;
  return (req, res, next) => run(req, next, async (transaction) => {
    const carteira = await carteiraOf(req.auth, transaction);
    if (await isOutOfScope(kind, req.params[param], carteira, transaction)) throw AppError.notFound(message, code);
  });
}

/** Criação com `opportunityId` no corpo (visita, mensagem, proposta, radar, ocorrência): a oportunidade precisa ser da carteira. */
function requireBodyOpportunityInScope(req, res, next) {
  const opportunityId = req.body && req.body.opportunityId;
  if (!opportunityId) return next();
  return run(req, next, async (transaction) => {
    const carteira = await carteiraOf(req.auth, transaction);
    if (await isOpportunityOutOfScope(opportunityId, carteira, transaction)) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  });
}

/** Filtro `opportunityId` na query de uma listagem: oportunidade alheia responde 404 (em vez de uma lista vazia que confirmaria a existência). */
function requireQueryOpportunityInScope(req, res, next) {
  const opportunityId = req.query && req.query.opportunityId;
  if (!opportunityId) return next();
  return run(req, next, async (transaction) => {
    const carteira = await carteiraOf(req.auth, transaction);
    if (await isOpportunityOutOfScope(String(opportunityId), carteira, transaction)) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  });
}

/** Painel do CRM: o corretor de escopo próprio vê só os números da própria carteira (o filtro de responsável vira ele mesmo). */
function scopeDashboardToCarteira(req, res, next) {
  return run(req, next, async (transaction) => {
    const carteira = await carteiraOf(req.auth, transaction);
    if (carteira) req.query.ownerUserId = carteira.userId || '00000000-0000-0000-0000-000000000000';
  });
}

/** Deixa o escopo da carteira em `req.carteira` para a listagem somar ao seu `where` (null = sem filtro). */
function attachCarteira(req, res, next) {
  return run(req, next, async (transaction) => {
    req.carteira = await carteiraOf(req.auth, transaction);
  });
}

module.exports = { requireRecordInScope, requireBodyOpportunityInScope, requireQueryOpportunityInScope, scopeDashboardToCarteira, attachCarteira };
