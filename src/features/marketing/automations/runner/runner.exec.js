'use strict';

const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { EXECUTORS } = require('./executors');

const timeoutAfter = (ms) => new Promise((_, reject) => { setTimeout(() => reject(Object.assign(new Error('timeout'), { actionTimeout: true })), ms).unref(); });

/**
 * Executa UMA ação (passo 7) num savepoint, com o tempo máximo do parâmetro. Sucesso: OK, SKIPPED ou UNKNOWN conforme o executor. Erro: FAILED com MKT_ACTION_FAILED
 * (as escritas parciais da ação são desfeitas). Estouro de tempo: UNKNOWN com MKT_ACTION_UNKNOWN (o destino pode ter agido; nada é repetido às cegas).
 */
async function executeOne(ctx, entry, def) {
  const executor = EXECUTORS[entry.type];
  const actionCtx = { ...ctx, entry, def };
  try {
    const result = await sequelize.transaction({ transaction: ctx.transaction }, (savepoint) => Promise.race([
      executor({ ...actionCtx, transaction: savepoint }), timeoutAfter(ctx.params.actionTimeoutS * 1000),
    ]));
    return { ...entry, status: result.status, provider_ref: result.providerRef || null, error_code: result.errorCode || null, ...(result.detail ? { detail: String(result.detail).slice(0, 200) } : {}) };
  } catch (err) {
    if (err.actionTimeout) return { ...entry, status: 'UNKNOWN', error_code: 'MKT_ACTION_UNKNOWN', detail: 'tempo esgotado' };
    logger.warn({ type: entry.type, err: err.message, code: err.code }, 'marketing.runner.action_failed');
    return { ...entry, status: 'FAILED', error_code: 'MKT_ACTION_FAILED', detail: String(err.message || err.code || 'erro').slice(0, 200) };
  }
}

/**
 * Passo 7 e 8: percorre as ações PENDING em ordem. `stopOnError` (padrão verdadeiro) interrompe na primeira falha e as seguintes ficam PENDING (o replay as executa);
 * com `stopOnError: false` a falha não impede as demais. Devolve a lista de ações atualizada, sem tocar nas que já estão OK, SKIPPED ou SCHEDULED.
 */
async function executePending(ctx, entries, defs) {
  const out = [...entries];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].status !== 'PENDING') continue;
    const def = defs[out[i].index] || {};
    out[i] = await executeOne(ctx, out[i], def);
    if (['FAILED', 'UNKNOWN'].includes(out[i].status) && def.stopOnError !== false) break;
  }
  return out;
}

module.exports = { executePending, executeOne };
