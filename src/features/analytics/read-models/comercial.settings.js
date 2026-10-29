'use strict';

/**
 * M9-D616 — parâmetros do administrador dos read models de Comercial/CRM e Imóveis (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.centro.opp_parada_dias              dias sem movimento para a oportunidade em andamento contar como parada (livro/PD-026: 7)
 *   analytics.comercial.janela_recalculo_dias     quantos dias para trás a agenda recalcula os read models diários (visitas e propostas
 *                                                 agendadas não geram evento no momento do agendamento)
 *   analytics.comercial.primeira_resposta_inclui_nay   a resposta da NAY conta como primeira resposta do lead (padrão Ligado)
 *   analytics.imoveis.faixas_sem_venda_dias       limites, em dias, das faixas de "imóvel sem venda" (ex.: 30,60,90,180)
 * Arquivo sem dependência de settings.service no topo (evita ciclo; a leitura usa import tardio).
 */
const AppError = require('../../../utils/AppError');

const KEYS = Object.freeze({
  stalledDays: 'analytics.centro.opp_parada_dias',
  recalcDays: 'analytics.comercial.janela_recalculo_dias',
  includeNay: 'analytics.comercial.primeira_resposta_inclui_nay',
  noSaleBands: 'analytics.imoveis.faixas_sem_venda_dias',
});

const COMERCIAL_DEFAULTS = Object.freeze({
  [KEYS.stalledDays]: 7,
  [KEYS.recalcDays]: 7,
  [KEYS.includeNay]: true,
  [KEYS.noSaleBands]: '30,60,90,180',
});

/** "30,60,90,180" -> [30, 60, 90, 180] (inteiros positivos em ordem estritamente crescente, até 10) ou null. */
function parseBands(text) {
  const parts = String(text === undefined || text === null ? '' : text).split(',').map((p) => p.trim());
  if (!parts.length || parts.length > 10 || !parts.every((p) => /^[1-9][0-9]{0,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n, i) => i === 0 || n > nums[i - 1]) ? nums : null;
}

function validateBands(key, value) {
  if (!parseBands(value)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista crescente de dias, como 30,60,90,180 (até 10 faixas).`, 'SETTING_INVALID_VALUE', { key, value });
}

const COMERCIAL_SETTINGS_SCHEMA = {
  [KEYS.stalledDays]: { type: 'integer', min: 1, max: 365 },
  [KEYS.recalcDays]: { type: 'integer', min: 1, max: 90 },
  [KEYS.includeNay]: { type: 'boolean' },
  [KEYS.noSaleBands]: { type: 'string', validate: validateBands },
};

const int = (v, key, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : COMERCIAL_DEFAULTS[key]);

/** { stalledDays, recalcDays, includeNay, bands } vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readComercialParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, COMERCIAL_DEFAULTS[key]);
  const [stalled, recalc, nay, bands] = await Promise.all([get(KEYS.stalledDays), get(KEYS.recalcDays), get(KEYS.includeNay), get(KEYS.noSaleBands)]);
  return {
    stalledDays: int(stalled, KEYS.stalledDays, 1, 365),
    recalcDays: int(recalc, KEYS.recalcDays, 1, 90),
    includeNay: typeof nay === 'boolean' ? nay : COMERCIAL_DEFAULTS[KEYS.includeNay],
    bands: parseBands(bands) || parseBands(COMERCIAL_DEFAULTS[KEYS.noSaleBands]),
  };
}

module.exports = { KEYS, COMERCIAL_DEFAULTS, COMERCIAL_SETTINGS_SCHEMA, parseBands, readComercialParams };
