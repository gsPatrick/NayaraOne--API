'use strict';

/**
 * M9-D620 — parâmetros do administrador dos KPIs de caixa livre e dinheiro de terceiros (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.caixa.usar_saldo_abertura          soma o saldo de abertura das contas bancárias da empresa ao caixa total. Padrão: ligado.
 *   analytics.terceiros.termos_caucao            termos (separados por vírgula) que, na referência do dinheiro de terceiros, marcam a origem "caução".
 *   analytics.terceiros.termos_repasse           idem para a origem "repasse ao proprietário". O que não casa com nenhum dos dois é "outro".
 *   analytics.mapa_status.finance                mapa de status do ledger. A parte "liquidado = STATUS[,STATUS]" diz quais status entram como realizado.
 *   analytics.owner.fin.free_cash                owner (papel responsável) do KPI de caixa livre.
 *   analytics.owner.fin.third_party_cash         owner do KPI de dinheiro de terceiros.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const USE_OPENING_KEY = 'analytics.caixa.usar_saldo_abertura';
const CAUCAO_KEY = 'analytics.terceiros.termos_caucao';
const REPASSE_KEY = 'analytics.terceiros.termos_repasse';
const STATUS_MAP_KEY = 'analytics.mapa_status.finance';
const OWNER_KEYS = Object.freeze({
  'fin.free_cash': 'analytics.owner.fin.free_cash',
  'fin.third_party_cash': 'analytics.owner.fin.third_party_cash',
});
const DEFAULT_OWNER = 'Diretoria Financeira (papel financeiro-gestor)';
const DEFAULT_STATUS_MAP = 'a pagar/receber = PENDING; liquidado = SETTLED; REVERSED e CANCELLED excluídos; estorno e original ignorados em par';
const LEDGER_STATUSES = Object.freeze(['PENDING', 'PARTIALLY_SETTLED', 'SETTLED', 'REVERSED', 'CANCELLED']);
const REALIZED_ALLOWED = Object.freeze(['PARTIALLY_SETTLED', 'SETTLED']);

const CASH_DEFAULTS = Object.freeze({
  [USE_OPENING_KEY]: true,
  [CAUCAO_KEY]: 'caução, caucao',
  [REPASSE_KEY]: 'repasse',
  [STATUS_MAP_KEY]: DEFAULT_STATUS_MAP,
  [OWNER_KEYS['fin.free_cash']]: DEFAULT_OWNER,
  [OWNER_KEYS['fin.third_party_cash']]: DEFAULT_OWNER,
});

/** "caução, caucao" -> ['caução', 'caucao']: de 1 a 10 termos de até 40 caracteres, sem curinga. Texto inválido devolve null. */
function parseTerms(text) {
  const terms = String(text ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const valid = terms.length >= 1 && terms.length <= 10 && terms.every((t) => t.length <= 40 && !/[%_\\]/.test(t));
  return valid ? [...new Set(terms)] : null;
}

/** Status que o mapa declara como realizado ("liquidado = SETTLED" ou "liquidado = SETTLED,PARTIALLY_SETTLED"); null se o trecho é inválido ou ausente. */
function parseRealizedStatuses(text) {
  const match = /liquidad[oa]s?\s*=\s*([A-Za-z_,\s]+?)\s*(?:;|$)/i.exec(String(text ?? ''));
  if (!match) return null;
  const list = match[1].split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return list.length && list.every((s) => REALIZED_ALLOWED.includes(s)) ? [...new Set(list)] : null;
}

function bad(key, why) {
  const AppError = require('../../../utils/AppError');
  return AppError.badRequest(`O valor de "${key}" ${why}`, 'SETTING_INVALID_VALUE', { key });
}

const validateTerms = (key, value) => { if (!parseTerms(value)) throw bad(key, 'deve ter de 1 a 10 termos separados por vírgula (até 40 caracteres, sem % nem _).'); };
const validateStatusMap = (key, value) => {
  if (!parseRealizedStatuses(value)) throw bad(key, `deve conter o trecho "liquidado = STATUS" com status entre ${REALIZED_ALLOWED.join(' e ')} (exemplo: liquidado = SETTLED).`);
};

const CASH_SETTINGS_SCHEMA = {
  [USE_OPENING_KEY]: { type: 'boolean' },
  [CAUCAO_KEY]: { type: 'string', validate: validateTerms },
  [REPASSE_KEY]: { type: 'string', validate: validateTerms },
  [STATUS_MAP_KEY]: { type: 'string', validate: validateStatusMap },
  [OWNER_KEYS['fin.free_cash']]: { type: 'string' },
  [OWNER_KEYS['fin.third_party_cash']]: { type: 'string' },
};

async function readSetting(key, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  return getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, CASH_DEFAULTS[key]);
}

/** Parâmetros vigentes da empresa para o cálculo do caixa; valor ausente ou inválido cai no padrão. */
async function readCashParams(scope, transaction) {
  const opening = await readSetting(USE_OPENING_KEY, scope, transaction);
  return {
    includeOpening: typeof opening === 'boolean' ? opening : CASH_DEFAULTS[USE_OPENING_KEY],
    caucaoTerms: parseTerms(await readSetting(CAUCAO_KEY, scope, transaction)) || parseTerms(CASH_DEFAULTS[CAUCAO_KEY]),
    repasseTerms: parseTerms(await readSetting(REPASSE_KEY, scope, transaction)) || parseTerms(CASH_DEFAULTS[REPASSE_KEY]),
    realizedStatuses: parseRealizedStatuses(await readSetting(STATUS_MAP_KEY, scope, transaction)) || parseRealizedStatuses(DEFAULT_STATUS_MAP),
  };
}

async function readCashOwner(metricCode, scope, transaction) {
  const value = await readSetting(OWNER_KEYS[metricCode], scope, transaction);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = {
  USE_OPENING_KEY, CAUCAO_KEY, REPASSE_KEY, STATUS_MAP_KEY, OWNER_KEYS, CASH_DEFAULTS, CASH_SETTINGS_SCHEMA, LEDGER_STATUSES,
  parseTerms, parseRealizedStatuses, readCashParams, readCashOwner,
};
