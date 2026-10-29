'use strict';

const { sequelize, IntegrationDispatch } = require('../../../models');
const logger = require('../../../utils/logger');
const { confirmDispatch } = require('../../integrations/dispatch/worker/worker.confirm');

/**
 * O envio do caso (`submitCase`) é ON_STATUS (M9-D214): a resposta da submissão nunca confirma. Quando o provider informa o status do caso, por webhook assinado
 * ou por consulta de status, o envio daquele caso (achado pelo id externo) vai a CONFIRMED com essa evidência. Roda num savepoint e NUNCA derruba o webhook nem a consulta.
 * `source`: WEBHOOK_SIGNED ou STATUS_QUERY. Devolve true quando confirmou agora.
 */
async function confirmSubmitDispatchByStatus(ctx, { providerCode, externalCaseId, rawStatus, source }, transaction) {
  try {
    return await sequelize.transaction({ transaction }, async (savepoint) => {
      const envio = await IntegrationDispatch.findOne({
        where: { companyId: ctx.companyId, operation: 'submitCase', aggregateType: 'ProviderSubmission', externalResourceId: String(externalCaseId), status: 'SUBMITTED' }, transaction: savepoint,
      });
      if (!envio) return false;
      const r = await confirmDispatch(ctx, envio.id, { source, status: String(rawStatus).slice(0, 64), externalResourceId: externalCaseId }, savepoint);
      return r.confirmed;
    });
  } catch (err) {
    logger.warn({ providerCode, err: err.message, code: err.code }, 'Correspondente: não foi possível confirmar o envio do caso pelo status do provider; o status segue aplicado.');
    return false;
  }
}

module.exports = { confirmSubmitDispatchByStatus };
