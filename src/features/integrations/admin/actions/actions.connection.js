'use strict';

const { Op } = require('sequelize');
const AppError = require('../../../../utils/AppError');
const { IntegrationConnection, IntegrationProvider } = require('../../../../models');

/** Ordem de preferência quando o pedido não diz qual connection: a ativa, depois a que perdeu a credencial, a pausada e o rascunho (desativada nunca). */
const PREFERENCIA = Object.freeze(['ACTIVE', 'AUTH_FAILED', 'PAUSED', 'DRAFT']);

const naoAchou = () => AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');

/** A connection da empresa para o fornecedor e o ambiente (e o id, se informado) + a linha do catálogo. Outra empresa ou fornecedor sem connection é 404. */
async function resolveActionConnection(providerCode, { environment, connectionId }, ctx, transaction) {
  const where = { companyId: ctx.companyId, providerCode: String(providerCode), environment, ...(connectionId ? { id: connectionId } : { status: { [Op.in]: PREFERENCIA } }) };
  const candidatas = await IntegrationConnection.findAll({ where, order: [['created_at', 'DESC']], transaction });
  const connection = connectionId ? candidatas[0] : PREFERENCIA.map((s) => candidatas.find((c) => c.status === s)).find(Boolean);
  if (!connection) throw naoAchou();
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { transaction });
  if (!provider) throw naoAchou();
  return { connection, provider };
}

module.exports = { resolveActionConnection };
