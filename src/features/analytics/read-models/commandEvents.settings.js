'use strict';

/**
 * M9-D710 — parâmetros do administrador dos fatos do dia do Centro de Comando (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.centro.janela_horas       duração, em horas, da janela móvel do bloco 1 (padrão do livro: 24). Hoje: termina no instante da leitura; data passada: termina às 00:00 do dia
 *                                       seguinte de São Paulo (exclusivo). A comparação usa a janela imediatamente anterior, de mesma duração.
 *   analytics.centro.valor_relevante    pagamento liquidado com valor igual ou acima deste entra em "Pagamentos liquidados relevantes" (inclusivo; padrão do livro: R$ 10.000,00).
 *                                       Aceita "R$ 10.000,00", "10000,00" e "10000.00".
 *   analytics.owner.<código>            owner (papel responsável pela reconciliação) de legal.contracts_signed, crm.opportunities_won e fin.payments_settled_relevant.
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const HOURS_KEY = 'analytics.centro.janela_horas';
const THRESHOLD_KEY = 'analytics.centro.valor_relevante';
const OWNERS = Object.freeze({
  'legal.contracts_signed': 'Jurídico (papel juridico-gestor)',
  'crm.opportunities_won': 'Gerência Comercial (papel comercial-gestor)',
  'fin.payments_settled_relevant': 'Diretoria Financeira (papel financeiro-gestor)',
});
const CODES = Object.freeze(Object.keys(OWNERS));
const ownerKey = (code) => `analytics.owner.${code}`;

const COMMAND_DEFAULTS = Object.freeze({
  [HOURS_KEY]: 24,
  [THRESHOLD_KEY]: 'R$ 10.000,00',
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNERS[code]])),
});

/** "R$ 10.000,00" | "10000,00" | "10000.00" -> "10000.00" (centavos exatos, sem ponto flutuante); null se não for dinheiro >= 0. */
function parseMoneyText(text) {
  const raw = String(text === undefined || text === null ? '' : text).replace(/^\s*R\$\s*/i, '').trim();
  let normal = null;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(raw) || /^\d+(,\d{1,2})?$/.test(raw)) normal = raw.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(\.\d{1,2})?$/.test(raw)) normal = raw;
  if (normal === null) return null;
  const [whole, cents = ''] = normal.split('.');
  return `${BigInt(whole)}.${cents.padEnd(2, '0')}`;
}

function validateMoney(key, value) {
  const AppError = require('../../../utils/AppError');
  if (parseMoneyText(value) === null) {
    throw AppError.badRequest(`O valor de "${key}" deve ser um valor em reais, como R$ 10.000,00.`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const COMMAND_SETTINGS_SCHEMA = Object.freeze({
  [HOURS_KEY]: { type: 'integer', min: 1, max: 720 },
  [THRESHOLD_KEY]: { type: 'string', validate: validateMoney },
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
});

async function readSetting(key, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  return getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, COMMAND_DEFAULTS[key]);
}

/** Janela do bloco 1 em horas; ausente ou inválida cai no padrão do livro (24). */
async function readWindowHours(scope, transaction) {
  const value = Number(await readSetting(HOURS_KEY, scope, transaction));
  return Number.isInteger(value) && value >= 1 && value <= 720 ? value : COMMAND_DEFAULTS[HOURS_KEY];
}

/** Limiar de pagamento relevante em decimal exato ("10000.00"); ausente ou inválido cai no padrão do livro. */
async function readRelevantAmount(scope, transaction) {
  return parseMoneyText(await readSetting(THRESHOLD_KEY, scope, transaction)) || parseMoneyText(COMMAND_DEFAULTS[THRESHOLD_KEY]);
}

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readCommandOwner(metricCode, scope, transaction) {
  const value = await readSetting(ownerKey(metricCode), scope, transaction);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNERS[metricCode];
}

module.exports = { CODES, KEYS: { HOURS_KEY, THRESHOLD_KEY }, COMMAND_DEFAULTS, COMMAND_SETTINGS_SCHEMA, parseMoneyText, readWindowHours, readRelevantAmount, readCommandOwner };
