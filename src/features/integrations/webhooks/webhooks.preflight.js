'use strict';

const { IntegrationConnection } = require('../../../models');
const catchAsync = require('../../../utils/catchAsync');
const { checkWebhookRate, enforceCompanyLimit } = require('./webhooks.rateLimit');
const { resolveChannel, noteUnknownChannel, withTenant } = require('./webhooks.resolve');
const { readWebhookParams, platformBodyCeiling } = require('./webhooks.params');
const { bodyLimitFor } = require('./intake/intake.limits');
const { unknownChannel } = require('./webhooks.errors');

/**
 * Primeiro passo da rota pública, ANTES de ler o corpo (M9-D211 passos 2 e 3, M9-D213 3.2): limite por IP e fornecedor, connection do canal, parâmetros da empresa
 * e a política do fornecedor, que dão o limite de leitura do corpo. Canal desconhecido responde 404 sem ter lido nenhum byte do corpo. Deixa em `req.webhookIntake`
 * o que o resto da rota reaproveita e em `req.webhookBodyLimit` o teto desta chamada (a leitura é cortada nele e o Content-Length maior é recusado antes de ler).
 */
const webhookPreflight = catchAsync(async (req, res, next) => {
  const provider = String(req.params.provider || '').toLowerCase().slice(0, 48);
  const { channel } = req.params;
  const rate = await checkWebhookRate(req, provider, res);
  const conn = await resolveChannel(provider, channel);
  if (!conn) {
    await noteUnknownChannel(provider);
    throw unknownChannel();
  }
  const pre = await withTenant(conn, async (transaction) => {
    const params = await readWebhookParams({ groupId: conn.groupId, companyId: conn.companyId }, transaction);
    const connection = await IntegrationConnection.findOne({ where: { id: conn.connectionId, companyId: conn.companyId }, attributes: ['id', 'policyJson'], transaction });
    return { params, policy: connection ? connection.policyJson : {} };
  });
  if (req.webhookViaRootAlias && !pre.params.aliasRootEnabled) {
    await noteUnknownChannel(provider);
    throw unknownChannel();
  }
  enforceCompanyLimit(rate, pre.params.rateLimitPerMinute, res);
  req.webhookIntake = { provider, channel, conn, params: pre.params, startedAt: Date.now() };
  req.webhookBodyLimit = bodyLimitFor(pre.params.maxBodyBytes, pre.policy, platformBodyCeiling());
  next();
});

module.exports = { webhookPreflight };
