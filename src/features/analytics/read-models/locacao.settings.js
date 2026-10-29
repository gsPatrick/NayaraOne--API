'use strict';

/**
 * M9-D617 — parâmetros do administrador dos read models de Locação (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.locacao.tipos_contrato      tipos de contrato que contam como locação (padrão: os do jurídico, LEASE_LIKE_TYPES)
 *   analytics.locacao.repasse_prazo_dias  dias, depois do fim do mês de referência, para o repasse ao proprietário vencer
 *   analytics.locacao.nota_elogio / nota_reclamacao / nota_conflito   nota (0 a 10) de cada tipo de registro de atendimento, que faz
 *                                         as vezes de resposta de satisfação (não existe pesquisa de satisfação no sistema)
 * A janela da inadimplência é a mesma do Financeiro (analytics.inadimplencia.janela_dias, M9-D615).
 */
const AppError = require('../../../utils/AppError');

const KEYS = Object.freeze({
  contractTypes: 'analytics.locacao.tipos_contrato',
  repassDays: 'analytics.locacao.repasse_prazo_dias',
  scoreCompliment: 'analytics.locacao.nota_elogio',
  scoreComplaint: 'analytics.locacao.nota_reclamacao',
  scoreConflict: 'analytics.locacao.nota_conflito',
});

const LOCACAO_DEFAULTS = Object.freeze({
  [KEYS.contractTypes]: 'LEASE,LEASE_RESIDENTIAL,LEASE_COMMERCIAL,LEASE_SEASONAL,PROPERTY_ADMIN',
  [KEYS.repassDays]: 10,
  [KEYS.scoreCompliment]: 5,
  [KEYS.scoreComplaint]: 1,
  [KEYS.scoreConflict]: 3,
});

/** "LEASE,PROPERTY_ADMIN" -> ['LEASE', 'PROPERTY_ADMIN'] (códigos em maiúsculas, até 20) ou null. */
function parseTypes(text) {
  const parts = String(text === undefined || text === null ? '' : text).split(',').map((p) => p.trim().toUpperCase());
  return parts.length && parts.length <= 20 && parts.every((p) => /^[A-Z][A-Z0-9_]{1,39}$/.test(p)) ? [...new Set(parts)] : null;
}

function validateTypes(key, value) {
  if (!parseTypes(value)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de tipos de contrato separados por vírgula, como LEASE,PROPERTY_ADMIN.`, 'SETTING_INVALID_VALUE', { key, value });
}

const LOCACAO_SETTINGS_SCHEMA = {
  [KEYS.contractTypes]: { type: 'string', validate: validateTypes },
  [KEYS.repassDays]: { type: 'integer', min: 0, max: 90 },
  [KEYS.scoreCompliment]: { type: 'integer', min: 0, max: 10 },
  [KEYS.scoreComplaint]: { type: 'integer', min: 0, max: 10 },
  [KEYS.scoreConflict]: { type: 'integer', min: 0, max: 10 },
};

const int = (v, key, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : LOCACAO_DEFAULTS[key]);

/** Parâmetros vigentes da empresa; ausente ou inválido cai no padrão. */
async function readLocacaoParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, LOCACAO_DEFAULTS[key]);
  const [types, days, praise, complaint, conflict] = await Promise.all([get(KEYS.contractTypes), get(KEYS.repassDays), get(KEYS.scoreCompliment), get(KEYS.scoreComplaint), get(KEYS.scoreConflict)]);
  return {
    leaseTypes: parseTypes(types) || parseTypes(LOCACAO_DEFAULTS[KEYS.contractTypes]),
    repassDays: int(days, KEYS.repassDays, 0, 90),
    scoreCompliment: int(praise, KEYS.scoreCompliment, 0, 10),
    scoreComplaint: int(complaint, KEYS.scoreComplaint, 0, 10),
    scoreConflict: int(conflict, KEYS.scoreConflict, 0, 10),
  };
}

module.exports = { KEYS, LOCACAO_DEFAULTS, LOCACAO_SETTINGS_SCHEMA, parseTypes, readLocacaoParams };
