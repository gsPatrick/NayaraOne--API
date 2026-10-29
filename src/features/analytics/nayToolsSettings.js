'use strict';

/**
 * M9-D695 — parâmetro do administrador das ferramentas da NAY Diretoria (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.nay.max_itens_resposta   quantos itens no máximo uma ferramenta da NAY devolve numa resposta (decomposição por dimensão,
 *                                      alertas e referências de origem). Acima disso o resultado vem cortado e marcado como truncado.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const MAX_ITEMS_KEY = 'analytics.nay.max_itens_resposta';
const NAY_TOOLS_DEFAULTS = Object.freeze({ [MAX_ITEMS_KEY]: 50 });
const NAY_TOOLS_SETTINGS_SCHEMA = { [MAX_ITEMS_KEY]: { type: 'integer', min: 1, max: 200 } };

async function readMaxItems(scope, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const value = Number(await getSetting(MAX_ITEMS_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, NAY_TOOLS_DEFAULTS[MAX_ITEMS_KEY]));
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : NAY_TOOLS_DEFAULTS[MAX_ITEMS_KEY];
}

module.exports = { MAX_ITEMS_KEY, NAY_TOOLS_DEFAULTS, NAY_TOOLS_SETTINGS_SCHEMA, readMaxItems };
