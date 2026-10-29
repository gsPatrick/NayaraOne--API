'use strict';

/**
 * M9-D699 — parâmetro do administrador do teste de carga do BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.carga.degradacao_max_pct   quanto o p95 de cada operação do fluxo operacional pode subir, em %, quando os painéis do BI estão sob
 *                                        carga, sobre a linha de base sem BI. O livro (§21) exige que o painel pesado não degrade o OLTP e não
 *                                        dá o limite; padrão 10 (regra inferida da demanda). Lido por scripts/analytics/loadTest.js.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const KEY = 'analytics.carga.degradacao_max_pct';
const LOAD_DEFAULTS = Object.freeze({ [KEY]: 10 });
const LOAD_SETTINGS_SCHEMA = { [KEY]: { type: 'integer', min: 0, max: 1000 } };

/** Limite vigente para a empresa (valor inválido ou ausente cai no padrão). */
async function readDegradationMaxPct(scope, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const value = await getSetting(KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, LOAD_DEFAULTS[KEY]);
  return Number.isInteger(value) && value >= 0 && value <= 1000 ? value : LOAD_DEFAULTS[KEY];
}

module.exports = { KEY, LOAD_DEFAULTS, LOAD_SETTINGS_SCHEMA, readDegradationMaxPct };
