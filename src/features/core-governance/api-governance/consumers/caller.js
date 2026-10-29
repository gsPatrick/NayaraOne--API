'use strict';

const { identify, isExternal } = require('../standards/rateLimit.identity');
const consumersRepo = require('./consumers.repository');
const { ensureWebConsumer } = require('./consumers.service');
const { inTenantTx } = require('./tenantTx');
const { contextFor } = require('./context');

/**
 * Quem chama (M9-D841 §3.1), para os cabeçalhos de deprecação e para o rastro de uso. Usuário logado (JWT válido) = a empresa do token; credencial externa (/api-external com X-Client-Id)
 * = a empresa do consumidor cujo client_id é esse. Sem credencial: null (deprecação é da empresa, então chamada anônima não recebe cabeçalho nem entra no catálogo).
 * O consumidor só é rastreado se identificado: X-Client-App com o valor semeado (INTERNAL/APP) ou client_id cadastrado; valor desconhecido não é rastreado.
 */
async function resolveCaller(req) {
  const identity = identify(req);
  if (identity.kind === 'internal') {
    const ctx = await contextFor(identity.tenant);
    return { tenant: identity.tenant, ctx, consumer: await webConsumerOf(req, ctx) };
  }
  const clientId = req.get('x-client-id');
  if (identity.kind === 'external' && isExternal(req) && clientId) {
    const consumer = await consumersRepo.findByClientId(clientId);
    if (!consumer) return null;
    const tenant = { groupId: consumer.groupId, companyId: consumer.companyId };
    return { tenant, ctx: await contextFor(tenant), consumer };
  }
  return null;
}

async function webConsumerOf(req, ctx) {
  const appKey = req.get('x-client-app');
  if (!appKey) return null;
  if (ctx.consumers.has(appKey)) return ctx.consumers.get(appKey);
  const found = await inTenantTx(ctx.tenant, async (transaction) => {
    const existing = await consumersRepo.findByAppKey(ctx.tenant.companyId, appKey, transaction);
    if (existing || appKey !== ctx.webAppKey) return existing;
    return ensureWebConsumer({ tenant: ctx.tenant, appKey, transaction });
  });
  ctx.consumers.set(appKey, found || null);
  return found || null;
}

module.exports = { resolveCaller };
