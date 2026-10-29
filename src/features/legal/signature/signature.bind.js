'use strict';

const { sequelize, SignatureEnvelope, Signature, SignatureProviderRouting } = require('../../../models');
const { registerCallObserver } = require('../../integrations/dispatch/worker/worker.hooks');

/**
 * Liga a resposta do fornecedor ao envelope do Jurídico (M9-D236): quando `createEnvelope` é aceito, o worker de envios entrega a resposta e este observador grava o id do
 * envelope no par (connection, id), o id de cada signatário nas assinaturas e a linha de roteamento do webhook antigo do Clicksign. Roda na transação do worker, num SAVEPOINT:
 * falhar aqui nunca derruba o envio. Envio incerto (UNKNOWN) não passa por aqui: o id do envelope se aprende depois, no primeiro evento do fornecedor (signature.events.js).
 */
async function bindEnvelopeResult({ dispatch, connection, response, transaction }) {
  const envelope = await SignatureEnvelope.findOne({ where: { dispatchId: dispatch.id, companyId: dispatch.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!envelope) return;
  const externalId = response.externalResourceId || (response.raw && response.raw.providerEnvelopeId) || null;
  if (!externalId) return;
  await envelope.update({ externalEnvelopeId: String(externalId).slice(0, 160), connectionId: connection.id }, { transaction });
  const assinaturas = await Signature.findAll({ where: { envelopeId: envelope.id }, transaction, lock: transaction.LOCK.UPDATE });
  const lista = Array.isArray(response.signers) ? response.signers : [];
  for (const a of assinaturas) {
    const achado = lista.find((s) => s.personId === a.personId);
    if (!achado || !achado.externalSignerId) continue;
    await a.update({ externalSignatureId: String(achado.externalSignerId).slice(0, 128), providerEnvelopeId: envelope.externalEnvelopeId }, { transaction });
    await SignatureProviderRouting.findOrCreate({
      where: { externalSignatureId: a.externalSignatureId },
      defaults: { externalSignatureId: a.externalSignatureId, providerEnvelopeId: envelope.externalEnvelopeId, groupId: a.groupId, companyId: a.companyId },
      transaction,
    });
  }
}

let installed = false;
/** Registra o observador uma vez por processo. */
function installEnvelopeBinder() {
  if (installed) return;
  installed = true;
  registerCallObserver(async (args) => {
    const { dispatch, response, error } = args;
    if (error || !response || dispatch.operation !== 'createEnvelope' || dispatch.aggregateType !== 'ContractVersion') return;
    try {
      await sequelize.transaction({ transaction: args.transaction }, (savepoint) => bindEnvelopeResult({ ...args, transaction: savepoint }));
    } catch { /* o savepoint desfez só a ligação; o envio segue e o id se aprende no primeiro evento */ }
  });
}

module.exports = { installEnvelopeBinder, bindEnvelopeResult };
