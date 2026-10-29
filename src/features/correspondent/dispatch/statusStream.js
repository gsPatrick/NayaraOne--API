'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { FinancingCase } = require('../../../models');
const logger = require('../../../utils/logger');
const { runSyncCycle } = require('../../integrations/sync');
const { tenantTx } = require('../../integrations/dispatch/worker/tenantTx');
const { ensureFinancingConnection } = require('./financingConnection');

/**
 * Consulta de status dos casos como STREAM de sincronização (M9-D240 3.1, M9-D208): `financing.case_status`, um cursor por connection do provider. O cursor guarda o
 * último caso consultado (token = id do caso): se o processo cair no meio, a rodada seguinte retoma dali, e o lease impede dois workers na mesma varredura. Ao chegar
 * ao fim da lista o cursor volta ao começo. Quem consulta o provider é `pollCase(caseId)` (a mesma regra de antes: fora de transação, aplica pelo mesmo caminho do webhook).
 */
const STREAM = 'financing.case_status';

function sourceFor({ ctx, providerCode, polledStatuses, pollCase, totals }) {
  return {
    async fetchPage({ cursorValue, pageSize }) {
      const ids = (await tenantTx(ctx, async (transaction) => FinancingCase.findAll({
        where: { providerCode, status: { [Op.in]: polledStatuses }, ...(cursorValue ? { id: { [Op.gt]: cursorValue } } : {}) }, attributes: ['id'], order: [['id', 'ASC']], limit: pageSize, transaction,
      }))).map((c) => c.id);
      // Fim da lista: o cursor volta ao começo junto com a última página (a varredura seguinte recomeça).
      if (!ids.length) return { items: [], nextCursor: cursorValue ? '' : null, done: true };
      return { items: ids, nextCursor: ids.length < pageSize ? '' : ids[ids.length - 1], done: ids.length < pageSize };
    },
    // A consulta ao provider e a aplicação têm transações próprias (nenhuma trava segurada enquanto se espera o provider).
    async applyItems(ids) {
      let aplicados = 0;
      for (const id of ids) {
        totals.candidates += 1;
        // eslint-disable-next-line no-await-in-loop
        if (await pollCase(id)) { aplicados += 1; totals.applied += 1; }
      }
      return aplicados;
    },
  };
}

/** Varre os casos em andamento de cada provider da empresa pelo stream. Devolve { candidates, applied }. */
async function sweepCaseStatusStream({ group, company, polledStatuses, pollCase }) {
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  const provedores = (await tenantTx(ctx, (transaction) => FinancingCase.findAll({
    where: { status: { [Op.in]: polledStatuses }, providerCode: { [Op.ne]: 'manual' } }, attributes: ['providerCode'], group: ['provider_code'], transaction,
  }))).map((c) => c.providerCode);
  const totals = { candidates: 0, applied: 0 };
  for (const providerCode of provedores) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const connection = await tenantTx(ctx, (transaction) => ensureFinancingConnection(ctx, providerCode, transaction));
      // eslint-disable-next-line no-await-in-loop
      await runSyncCycle({ connectionId: connection.id, stream: STREAM, cursorKind: 'TOKEN', workerId: `correspondent-poll-${crypto.randomUUID()}` }, ctx, sourceFor({ ctx, providerCode, polledStatuses, pollCase, totals }));
    } catch (err) {
      logger.warn({ providerCode, err: err.message, code: err.code }, 'Correspondente: a varredura de status do provider não pôde rodar.');
    }
  }
  return totals;
}

module.exports = { sweepCaseStatusStream, STREAM };
