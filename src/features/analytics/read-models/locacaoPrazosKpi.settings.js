'use strict';

/**
 * M9-D641 — parâmetros do administrador dos KPIs de prazos da Locação no BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.<código>                      owner (papel responsável pela reconciliação) de rent.guarantees_expiring, rent.obligations_pending e rent.inspections_keys
 *   analytics.locacao.garantias_sem_vencimento    tipos de garantia que não têm data de vencimento (padrão SECURITY_DEPOSIT, a caução em dinheiro): garantia desses tipos sem data
 *                                                 não rebaixa a qualidade de "Garantias vencendo"
 * Os tipos de contrato de locação continuam sendo os de analytics.locacao.tipos_contrato (M9-D617). Arquivo sem dependência de settings.service no topo (evita ciclo).
 */
const { codeList, readCodeList } = require('./settings.codeList');

const OWNER = 'Gerência de Locação (papel locação-gestor)';
const CODES = Object.freeze(['rent.guarantees_expiring', 'rent.obligations_pending', 'rent.inspections_keys']);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({ noExpiryTypes: 'analytics.locacao.garantias_sem_vencimento' });

const RENTAL_DEADLINES_KPI_DEFAULTS = Object.freeze({ ...Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNER])), [KEYS.noExpiryTypes]: 'SECURITY_DEPOSIT' });
const RENTAL_DEADLINES_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.noExpiryTypes]: { type: 'string', validate: codeList },
});

/** Tipos de garantia sem vencimento da empresa; ausente ou inválido cai no padrão. */
// Fechamento M5: o banco guarda os códigos do livro; um código antigo configurado vale como o do livro (e vice-versa).
const GUARANTEE_ALIAS_PAIRS = [['DEPOSIT', 'SECURITY_DEPOSIT'], ['CAPITALIZATION_TITLE', 'CAPITALIZATION']];
const readNoExpiryGuaranteeTypes = async (scope, transaction) => {
  const list = await readCodeList(KEYS.noExpiryTypes, RENTAL_DEADLINES_KPI_DEFAULTS[KEYS.noExpiryTypes], scope, transaction);
  const out = new Set(list);
  for (const [a, b] of GUARANTEE_ALIAS_PAIRS) if (out.has(a) || out.has(b)) { out.add(a); out.add(b); }
  return [...out];
};

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readRentalDeadlinesOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER;
}

module.exports = { CODES, KEYS, RENTAL_DEADLINES_KPI_DEFAULTS, RENTAL_DEADLINES_KPI_SETTINGS_SCHEMA, readNoExpiryGuaranteeTypes, readRentalDeadlinesOwner };
