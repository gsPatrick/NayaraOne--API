'use strict';

const logger = require('../../../utils/logger');
const { sequelize } = require('../../../models');
const { transitionDispatch } = require('../dispatch/dispatch.transition');
const { readAnalyticsParams } = require('./analytics.params');

const DROPPABLE = ['PENDING', 'RETRY_WAIT'];

/**
 * Descarte de métrica ou evento que não saiu em `integration.analytics.drop_after_s` (padrão 300 s; M9-D243 3.1): o envio de uma
 * connection de ANALYTICS ainda esperando (PENDING ou RETRY_WAIT) há mais que o prazo vira CANCELLED, com o motivo na auditoria. Roda no início
 * de cada rodada do worker, antes de pegar os envios vencidos, de modo que um envio velho nunca é enviado. Quem já está em SENDING não é tocado.
 */
async function dropExpiredAnalytics(ctx, { now = new Date() } = {}, transaction) {
  const { dropAfterS } = await readAnalyticsParams(ctx, transaction);
  const limite = new Date(now.getTime() - dropAfterS * 1000);
  const [rows] = await sequelize.query(
    `SELECT d.id FROM "integration"."dispatches" d JOIN "integration"."providers" p ON p.code = d.provider_code
      WHERE d.company_id = :company AND p.domain = 'ANALYTICS' AND d.status IN (:status) AND d.created_at <= :limite ORDER BY d.created_at LIMIT 500`,
    { replacements: { company: ctx.companyId, status: DROPPABLE, limite }, transaction },
  );
  let dropped = 0;
  for (const { id } of rows) {
    try {
      await sequelize.transaction({ transaction }, (savepoint) => transitionDispatch(ctx, id, 'CANCELLED', {}, { motivo: `Descartada: não enviada em ${dropAfterS} s (métrica descartável).` }, savepoint));
      dropped += 1;
    } catch (err) {
      logger.warn({ dispatchId: id, code: err.code }, 'Descarte de analytics ignorado (o envio mudou de estado)');
    }
  }
  return { dropped };
}

module.exports = { dropExpiredAnalytics };
