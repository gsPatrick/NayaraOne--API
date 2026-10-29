'use strict';

/**
 * M9-D615 — parâmetro do administrador do read model financeiro (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.inadimplencia.janela_dias   janela, em dias, que separa o vencido que entra na taxa de inadimplência do que fica fora
 *                                         (livro/demanda: 90). Os horizontes 7, 30 e 60 dias das contas são fixos do livro.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const WINDOW_KEY = 'analytics.inadimplencia.janela_dias';
const FINANCE_HEALTH_DEFAULTS = Object.freeze({ [WINDOW_KEY]: 90 });
const FINANCE_HEALTH_SETTINGS_SCHEMA = { [WINDOW_KEY]: { type: 'integer', min: 1, max: 3650 } };

async function readOverdueWindowDays(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = Number(await getSetting(WINDOW_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, FINANCE_HEALTH_DEFAULTS[WINDOW_KEY]));
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : FINANCE_HEALTH_DEFAULTS[WINDOW_KEY];
}

module.exports = { WINDOW_KEY, FINANCE_HEALTH_DEFAULTS, FINANCE_HEALTH_SETTINGS_SCHEMA, readOverdueWindowDays };
