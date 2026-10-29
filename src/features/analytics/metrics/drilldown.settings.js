'use strict';

/**
 * M9-D690 (3.5) — parâmetros do administrador do detalhe (drill-down) do BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.drilldown.tamanho_pagina_maximo   maior pageSize aceito (livro: 200)
 *   analytics.drilldown.tamanho_pagina_padrao   pageSize quando o pedido não informa (nunca passa do máximo)
 * Arquivo sem dependências no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const MAX_KEY = 'analytics.drilldown.tamanho_pagina_maximo';
const DEFAULT_KEY = 'analytics.drilldown.tamanho_pagina_padrao';
const DRILLDOWN_DEFAULTS = Object.freeze({ [MAX_KEY]: 200, [DEFAULT_KEY]: 50 });
const DRILLDOWN_SETTINGS_SCHEMA = { [MAX_KEY]: { type: 'integer', min: 1, max: 1000 }, [DEFAULT_KEY]: { type: 'integer', min: 1, max: 1000 } };

const valid = (v, fallback) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : fallback);

/** { max, standard }: o padrão nunca ultrapassa o máximo; valor inválido volta ao padrão do livro. */
async function readPageLimits(ctx, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const scope = { companyId: ctx.companyId, groupId: ctx.groupId };
  const max = valid(Number(await getSetting(MAX_KEY, scope, transaction, DRILLDOWN_DEFAULTS[MAX_KEY])), DRILLDOWN_DEFAULTS[MAX_KEY]);
  const standard = valid(Number(await getSetting(DEFAULT_KEY, scope, transaction, DRILLDOWN_DEFAULTS[DEFAULT_KEY])), DRILLDOWN_DEFAULTS[DEFAULT_KEY]);
  return { max, standard: Math.min(standard, max) };
}

module.exports = { MAX_KEY, DEFAULT_KEY, DRILLDOWN_DEFAULTS, DRILLDOWN_SETTINGS_SCHEMA, readPageLimits };
