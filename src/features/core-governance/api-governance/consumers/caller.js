'use strict';

const { identify, isExternal } = require('../standards/rateLimit.identity');
const consumersRepo = require('./consumers.repository');
const { ensureWebConsumer } = require('./consumers.service');
const { inTenantTx } = require('./tenantTx');
const { contextFor } = require('./context');
const { peekClientClaims } = require('../clients/token');

/**
 * Quem chama (M9-D841 §3.1), para os cabeçalhos de deprecação e para o rastro de uso. Usuário logado (JWT válido) = a empresa do token; credencial externa (/api-external com X-Client-Id)
 * = a empresa do consumidor cujo client_id é esse. Sem credencial: null (deprecação é da empresa, então chamada anônima não recebe cabeçalho nem entra no catálogo).
 * O consumidor só é rastreado se identificado: X-Client-App com o valor semeado (INTERNAL/APP) ou client_id cadastrado; valor desconhecido não é rastreado.
 */
async function resolveCaller(req) {
  const identity = identify(req);
  if (!isExternal(req) && identity.kind === 'internal') {
    const ctx = await contextFor(identity.tenant);
    return { tenant: identity.tenant, ctx, consumer: await webConsumerOf(req, ctx) };
  }
  const clientId = isExternal(req) ? externalClientId(req) : null;
  if (clientId) {
    const consumer = await consumersRepo.findByClientId(clientId);
    if (!consumer) return null;
    const tenant = { groupId: consumer.groupId, companyId: consumer.companyId };
    return { tenant, ctx: await contextFor(tenant), consumer };
  }
  return null;
}

/** A credencial de quem chama /api-external: o client_id do token de cliente válido; sem ele, o cabeçalho X-Client-Id; na emissão do token, o client_id do corpo (só conta se a resposta for < 400). */
function externalClientId(req) {
  const claims = peekClientClaims(req);
  if (claims) return claims.client_id;
  const header = req.get('x-client-id');
  if (header) return header;
  const body = req.body && typeof req.body === 'object' ? req.body.client_id : null;
  return /\/api-external\/oauth\/token\/?$/.test(req.originalUrl || '') && typeof body === 'string' ? body : null;
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
