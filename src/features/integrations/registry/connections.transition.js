'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { STATUSES, TRANSITIONS } = require('./registry.constants');
const { serializeConnection, auditar, exigirMfaEmProducao } = require('./registry.auditoria');
const { carregarTravada } = require('./connections.service');
const { exigirSegredoParaAtivarIA } = require('./connections.aiRules');

/** Houve rotação de credencial DEPOIS de a conexão ser marcada como comprometida? (reativação exige nova credencial no cofre, M9-D433) */
function rotatedAfterCompromise(c) {
  const mark = c.policyJson && c.policyJson.compromised && c.policyJson.compromised.at;
  const rotated = c.lastSecretRotationAt ? new Date(c.lastSecretRotationAt).getTime() : null;
  return Boolean(mark && rotated && rotated > new Date(mark).getTime());
}

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
  if (toStatus === 'COMPROMISED' && !opts.system) throw invalida(); // M9-D433: quem marca é o tratamento de conta comprometida, nunca a transição manual comum
  if (de === 'COMPROMISED' && toStatus === 'ACTIVE' && !rotatedAfterCompromise(c)) {
    throw AppError.conflict('A conexão foi marcada como comprometida: cadastre uma nova credencial no cofre antes de reativar.', 'INTEGRATION_CONNECTION_REAUTH_REQUIRED');
  }
  await exigirMfaEmProducao(c.environment, ctx, transaction, { system: Boolean(opts.system) });

  if (toStatus === 'ACTIVE') {
    exigirSegredoParaAtivarIA(await IntegrationProvider.findByPk(c.providerCode, { transaction }), c);
    if (c.environment === 'PRODUCTION' && !c.productionReleasedAt) {
      throw AppError.conflict('Esta integração ainda não foi liberada para produção.', 'INTEGRATION_PRODUCTION_NOT_RELEASED');
    }
    if (c.environment === 'PRODUCTION') await require('./release.evidence.contract').assertSuiteGreenForActivation(c, ctx, transaction); // M9-D222/D256: sem suíte verde não fica ACTIVE em produção
    const outra = await IntegrationConnection.findOne({
      where: { companyId: c.companyId, providerCode: c.providerCode, environment: c.environment, status: 'ACTIVE', id: { [Op.ne]: c.id } },
      transaction,
    });
    if (outra) throw AppError.conflict('Já existe uma integração ativa deste fornecedor neste ambiente.', 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
  }
  const antes = serializeConnection(c);
  if (toStatus === 'COMPROMISED') c.policyJson = { ...(c.policyJson || {}), compromised: { at: new Date().toISOString(), reason: String(opts.reason || '').slice(0, 500) } };
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
  // M9-D216: test-connection verde reativa a connection e os envios parados por recusa de credencial voltam sem gastar tentativa.
  if (de === 'AUTH_FAILED' && toStatus === 'ACTIVE') await require('../dispatch/retry/retry.resume').resumeAuthFailedDispatches(ctx, c.id, transaction);
  return c;
}

module.exports = { transitionConnection };
