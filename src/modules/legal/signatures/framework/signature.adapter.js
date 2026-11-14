'use strict';

const { IntegrationConnection } = require('../../../../models');
const adapterRegistry = require('../../../../features/integrations/registry/adapterRegistry');
const { invoke } = require('../../../../features/integrations/registry/adapterInvoke');
const { ensureSignatureConnection } = require('./signature.connection');
const { ensureAdapterRegistered } = require('./signature.boot');

/**
 * Acesso do Jurídico ao fornecedor do envelope pelo contrato do port (M9-D236): a connection do envelope (ou, para assinatura criada antes do registro, a atual da empresa),
 * o adapter do AdapterRegistry e a chamada validada por `invoke` (pedido e resposta normalizada). O Jurídico nunca instancia o adapter antigo do fornecedor.
 */
async function adapterOf(ctx, envelope, transaction) {
  const connection = (envelope && envelope.connectionId && await IntegrationConnection.findOne({ where: { id: envelope.connectionId, companyId: ctx.companyId }, transaction }))
    || await ensureSignatureConnection(ctx, transaction);
  ensureAdapterRegistered(connection.providerCode);
  return { adapter: await adapterRegistry.resolve(connection, ctx, transaction), connection };
}

/** Operação do port com resposta normalizada ({ status, externalResourceId }): getEnvelope, cancelEnvelope. */
async function callEnvelope(ctx, envelope, operation, request, transaction) {
  const { adapter } = await adapterOf(ctx, envelope, transaction);
  return invoke(adapter, operation, request, { tenant: ctx, transaction, meta: { transaction } });
}

/** Arquivo assinado: o adapter devolve `document.buffer` além da saída normalizada (o buffer não passa pelo `invoke`, que só devolve os campos normalizados). */
async function downloadSigned(ctx, envelope, transaction) {
  const { adapter } = await adapterOf(ctx, envelope, transaction);
  const resposta = await adapter.downloadSigned(adapter.ctx, { externalResourceId: envelope.externalEnvelopeId, documentSha256: envelope.documentSha256 }, { transaction });
  return resposta && resposta.document && resposta.document.buffer ? resposta.document : null;
}

module.exports = { adapterOf, callEnvelope, downloadSigned };
