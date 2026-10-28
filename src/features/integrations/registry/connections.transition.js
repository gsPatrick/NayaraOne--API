'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { STATUSES, TRANSITIONS } = require('./registry.constants');
const { serializeConnection, auditar, exigirMfaEmProducao } = require('./registry.auditoria');
const { carregarTravada } = require('./connections.service');

/**
 * Muda o status. `opts.system` = ação do sistema (só ela leva ACTIVE -> AUTH_FAILED);
 * `opts.testConnectionOk` = test-connection verde (só ele leva AUTH_FAILED -> ACTIVE, D250).
 */
async function transitionConnection(id, toStatus, ctx, transaction, opts = {}) {
  const c = await carregarTravada(id, ctx, transaction);
  const de = c.status;
  const invalida = () => AppError.conflict(`Transição de status inválida: ${de} -> ${toStatus}.`, 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  if (!STATUSES.includes(toStatus) || !(TRANSITIONS[de] || []).includes(toStatus)) throw invalida();
  if (toStatus === 'AUTH_FAILED' && !opts.system) throw invalida();
  if (de === 'AUTH_FAILED' && toStatus === 'ACTIVE' && !opts.testConnectionOk) throw invalida();
  await exigirMfaEmProducao(c.environment, ctx, transaction, { system: Boolean(opts.system) });

  if (toStatus === 'ACTIVE') {
    if (c.environment === 'PRODUCTION' && !c.productionReleasedAt) {
      throw AppError.conflict('Esta integração ainda não foi liberada para produção.', 'INTEGRATION_PRODUCTION_NOT_RELEASED');
    }
    const outra = await IntegrationConnection.findOne({
      where: { companyId: c.companyId, providerCode: c.providerCode, environment: c.environment, status: 'ACTIVE', id: { [Op.ne]: c.id } },
      transaction,
    });
    if (outra) throw AppError.conflict('Já existe uma integração ativa deste fornecedor neste ambiente.', 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
  }
  const antes = serializeConnection(c);
  c.status = toStatus;
  c.updatedBy = ctx.userId || null;
  try {
    await c.save({ transaction });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('Já existe uma integração ativa deste fornecedor neste ambiente.', 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
    }
    throw err;
  }
  await auditar(ctx, c, antes, serializeConnection(c), `Integração "${c.label}": status ${de} -> ${toStatus}.`, transaction);
  return c;
}

module.exports = { transitionConnection };
