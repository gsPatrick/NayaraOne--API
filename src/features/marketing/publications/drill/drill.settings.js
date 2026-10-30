'use strict';

/**
 * M9-D442 — parâmetros do failure drill de provedor (aba Marketing de Configurações; padrão = Maturacao/demandas/parametros.csv). O livro fixa os 12 cenários e o resultado
 * esperado, mas não o tamanho do ensaio:
 *  - `marketing.drill.jobs_pendentes`: quantas publicações ficam esperando com o circuito aberto (o exemplo do livro usa 100; o ensaio de rotina usa menos);
 *  - `marketing.drill.slow_margem_ms`: quanto o cenário SLOW passa do tempo máximo do worker (`marketing.worker.timeout_s`) para valer como TIMEOUT.
 */
const KEYS = Object.freeze({ pendingJobs: 'marketing.drill.jobs_pendentes', slowMarginMs: 'marketing.drill.slow_margem_ms' });
const DRILL_SETTING_DEFAULTS = Object.freeze({ [KEYS.pendingJobs]: 10, [KEYS.slowMarginMs]: 500 });
const DRILL_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.pendingJobs]: { type: 'integer', min: 1, max: 1000 },
  [KEYS.slowMarginMs]: { type: 'integer', min: 50, max: 60000 },
});

/** Parâmetros do ensaio lidos na hora (nada em cache). */
async function readDrillParams(tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const read = async (key) => {
    const value = Number(await getSetting(key, tenant, transaction, DRILL_SETTING_DEFAULTS[key]));
    return Number.isInteger(value) && value >= 1 ? value : DRILL_SETTING_DEFAULTS[key];
  };
  return { pendingJobs: await read(KEYS.pendingJobs), slowMarginMs: await read(KEYS.slowMarginMs) };
}

module.exports = { KEYS, DRILL_SETTING_DEFAULTS, DRILL_SETTINGS_SCHEMA, readDrillParams };
