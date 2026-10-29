'use strict';

/**
 * M9-D618 — parâmetros do administrador dos read models de Obras, Estoque/Patrimônio e Pós-obra (aba "BI e Centro de Comando" em
 * /painel/configuracoes). Todos têm o padrão do livro ou o comportamento do código e só valem quando a empresa os altera:
 *   analytics.obra.previsao_metodo          RITMO (padrão) projeta prazo e custo pelo ritmo já medido; PLANEJADO repete o baseline.
 *   analytics.obra.receita_contrato_status  status de contrato cuja valor entra na receita contratada da obra.
 *   analytics.estoque.tipos_item            tipos de item que entram no valor em estoque, abaixo do mínimo e ruptura.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const { codeList, readCodeList } = require('./settings.codeList');

const METHOD_KEY = 'analytics.obra.previsao_metodo';
const REVENUE_KEY = 'analytics.obra.receita_contrato_status';
const ITEM_TYPES_KEY = 'analytics.estoque.tipos_item';

const OBRA_DEFAULTS = Object.freeze({
  [METHOD_KEY]: 'RITMO',
  [REVENUE_KEY]: 'SIGNED,ACTIVE,SUSPENDED,CLOSED',
  [ITEM_TYPES_KEY]: 'CONSUMABLE',
});

const OBRA_SETTINGS_SCHEMA = {
  [METHOD_KEY]: { type: 'string', enum: ['RITMO', 'PLANEJADO'] },
  [REVENUE_KEY]: { type: 'string', validate: codeList },
  [ITEM_TYPES_KEY]: { type: 'string', validate: codeList },
};

async function readForecastMethod(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(METHOD_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, OBRA_DEFAULTS[METHOD_KEY]);
  return ['RITMO', 'PLANEJADO'].includes(value) ? value : OBRA_DEFAULTS[METHOD_KEY];
}

module.exports = {
  METHOD_KEY, REVENUE_KEY, ITEM_TYPES_KEY, OBRA_DEFAULTS, OBRA_SETTINGS_SCHEMA, readForecastMethod,
  readContractStatuses: (scope, transaction) => readCodeList(REVENUE_KEY, OBRA_DEFAULTS[REVENUE_KEY], scope, transaction),
  readItemTypes: (scope, transaction) => readCodeList(ITEM_TYPES_KEY, OBRA_DEFAULTS[ITEM_TYPES_KEY], scope, transaction),
};
