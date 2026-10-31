'use strict';

const crypto = require('node:crypto');
const providers = require('../control/blockers.providers');
const { accountableOf } = require('../control/blockers.rules');
const raci = require('../raci/raci.service');
const windows = require('./window.repository');
const results = require('./results.repository');

const CODES = Object.freeze({ DIFF: 'GOV_PARALLEL_DIFF_BLOCKER', MISSING_IN_NEW: 'GOV_PARALLEL_MISSING_IN_NEW', MISSING_IN_OLD: 'GOV_PARALLEL_MISSING_IN_OLD' });
const ACTIVITY = 'PARALLEL_COMPARE_CLOSE';

/** Referência curta e estável da diferença (a coluna `ref` do blocker tem 128 caracteres): janela + entidade + chave + campo. */
const refOf = (windowId, entity, key, field) => `par:${crypto.createHash('sha256').update(`${windowId}\u0000${entity}\u0000${key}\u0000${field}`).digest('hex').slice(0, 40)}`;

/**
 * Blockers da comparação paralela (M9-D903 §3.5 e §3.6), no ponto de extensão da Torre (M9-D901): uma linha por diferença bloqueante em aberto — a mais recente de cada
 * (entidade, chave, campo) das janelas RUNNING. Sai quando uma execução seguinte devolve MATCH ou DIFF_ALLOWED para a mesma tupla. Só a chave do legado e o nome do campo
 * aparecem no detalhe: nunca o valor.
 */
async function provide(tenant, scope, transaction) {
  const matrix = await raci.getMatrix(tenant, transaction);
  const owner = accountableOf(matrix.activities.find((activity) => activity.code === ACTIVITY));
  const out = [];
  for (const window of await windows.listRunning(tenant, transaction)) {
     
    for (const row of await results.openBlockers(tenant, window.id, transaction)) {
      const code = CODES[row.diff_kind] || CODES.DIFF;
      out.push({
        code, entity: row.entity, ref: refOf(window.id, row.entity, row.source_key, row.field), owner,
        detail: { source_system: window.source_system, window_id: window.id, source_key: row.source_key, field: row.field || null, kind: row.diff_kind || 'VALUE' },
      });
    }
  }
  return out;
}

const unregister = providers.register('migration-parallel-compare', provide);

module.exports = { CODES, ACTIVITY, provide, refOf, unregister };
