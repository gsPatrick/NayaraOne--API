'use strict';

/**
 * M9-D618 — parâmetros do administrador dos read models de Obras, Estoque/Patrimônio e Pós-obra (aba "BI e Centro de Comando" em
 * /painel/configuracoes). Todos têm o padrão do livro ou o comportamento do código e só valem quando a empresa os altera:
 *   analytics.obra.previsao_metodo          RITMO (padrão) projeta prazo e custo pelo ritmo já medido; PLANEJADO repete o baseline.
 *   analytics.obra.receita_contrato_status  status de contrato cuja valor entra na receita contratada da obra.
 *   analytics.estoque.tipos_item            tipos de item que entram no valor em estoque, abaixo do mínimo e ruptura.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const METHOD_KEY = 'analytics.obra.previsao_metodo';
const REVENUE_KEY = 'analytics.obra.receita_contrato_status';
const ITEM_TYPES_KEY = 'analytics.estoque.tipos_item';

const OBRA_DEFAULTS = Object.freeze({
  [METHOD_KEY]: 'RITMO',
  [REVENUE_KEY]: 'SIGNED,ACTIVE,SUSPENDED,CLOSED',
  [ITEM_TYPES_KEY]: 'CONSUMABLE',
});

const CODE_LIST_RE = /^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$/;
const codeList = (key, value) => {
  const AppError = require('../../../utils/AppError'); // import tardio: este arquivo é carregado pelo settings.service
  if (!CODE_LIST_RE.test(String(value).replace(/\s+/g, ''))) {
    throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de códigos em maiúsculas separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
  }
};

const OBRA_SETTINGS_SCHEMA = {
  [METHOD_KEY]: { type: 'string', enum: ['RITMO', 'PLANEJADO'] },
  [REVENUE_KEY]: { type: 'string', validate: codeList },
  [ITEM_TYPES_KEY]: { type: 'string', validate: codeList },
};

async function readParam(key, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  return getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, OBRA_DEFAULTS[key]);
}

async function readForecastMethod(scope, transaction) {
  const value = await readParam(METHOD_KEY, scope, transaction);
  return ['RITMO', 'PLANEJADO'].includes(value) ? value : OBRA_DEFAULTS[METHOD_KEY];
}

/** Lista de códigos (maiúsculas, sem espaço) do parâmetro; valor inválido volta ao padrão. */
async function readCodeList(key, scope, transaction) {
  const raw = String(await readParam(key, scope, transaction)).replace(/\s+/g, '');
  return CODE_LIST_RE.test(raw) ? raw.split(',') : OBRA_DEFAULTS[key].split(',');
}

module.exports = {
  METHOD_KEY, REVENUE_KEY, ITEM_TYPES_KEY, OBRA_DEFAULTS, OBRA_SETTINGS_SCHEMA, codeList, readForecastMethod,
  readContractStatuses: (scope, transaction) => readCodeList(REVENUE_KEY, scope, transaction),
  readItemTypes: (scope, transaction) => readCodeList(ITEM_TYPES_KEY, scope, transaction),
  readCodeList,
};
