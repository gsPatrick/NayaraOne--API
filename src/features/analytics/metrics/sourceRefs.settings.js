'use strict';

/**
 * M9-D611 — parâmetro do administrador do rastreio até a origem (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.rastreio.amostra_ids   quantos ids de lançamentos acompanham cada número (livro: até 20; 0 = nunca mostrar ids).
 * Arquivo sem dependências no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const SAMPLE_KEY = 'analytics.rastreio.amostra_ids';
const SOURCE_REFS_DEFAULTS = Object.freeze({ [SAMPLE_KEY]: 20 });
const SOURCE_REFS_SETTINGS_SCHEMA = { [SAMPLE_KEY]: { type: 'integer', min: 0, max: 20 } };

async function readSampleSize(ctx, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = Number(await getSetting(SAMPLE_KEY, { companyId: ctx.companyId, groupId: ctx.groupId }, transaction, SOURCE_REFS_DEFAULTS[SAMPLE_KEY]));
  return Number.isInteger(value) && value >= 0 && value <= 20 ? value : SOURCE_REFS_DEFAULTS[SAMPLE_KEY];
}

module.exports = { SAMPLE_KEY, SOURCE_REFS_DEFAULTS, SOURCE_REFS_SETTINGS_SCHEMA, readSampleSize };
