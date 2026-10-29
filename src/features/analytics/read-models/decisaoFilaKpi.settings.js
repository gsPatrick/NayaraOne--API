'use strict';

/**
 * M9-D709 — parâmetros do administrador da fila de decisão do Centro de Comando (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.fin.approvals_pending | inv.adjustments_pending | tec.rule_approvals_pending | ai.proposals_pending   owner (papel responsável) de cada KPI
 *   analytics.centro.decisao_atraso_horas   idade, em horas, acima da qual o item pendente aparece como "envelhecido" e entra na contagem de envelhecidas
 *                                           (o livro pede "o que exige decisão" sem dizer quando é urgente; padrão 48, regra inferida da demanda)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const QUEUE_KPI_CODES = Object.freeze(['fin.approvals_pending', 'inv.adjustments_pending', 'tec.rule_approvals_pending', 'ai.proposals_pending']);
const OWNERS = Object.freeze({
  'fin.approvals_pending': 'Diretoria Financeira (papel financeiro-gestor)',
  'inv.adjustments_pending': 'Gestor de Estoque (papel estoque-gestor)',
  'tec.rule_approvals_pending': 'Tecnologia (papel tecnologia-gestor)',
  'ai.proposals_pending': 'Tecnologia/IA (papel ia-gestor)',
});
const OWNER_KEY = (code) => `analytics.owner.${code}`;
const AGED_KEY = 'analytics.centro.decisao_atraso_horas';
const AGED_DEFAULT = 48;

const DECISAO_FILA_DEFAULTS = Object.freeze({ ...Object.fromEntries(QUEUE_KPI_CODES.map((code) => [OWNER_KEY(code), OWNERS[code]])), [AGED_KEY]: AGED_DEFAULT });
const DECISAO_FILA_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(QUEUE_KPI_CODES.map((code) => [OWNER_KEY(code), { type: 'string' }])),
  [AGED_KEY]: { type: 'integer', min: 1, max: 8760 },
});

async function readQueueOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(OWNER_KEY(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNERS[metricCode]);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNERS[metricCode];
}

/** Horas a partir das quais o item pendente é "envelhecido"; ausente ou inválido cai no padrão. */
async function readAgedHours(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(AGED_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, AGED_DEFAULT);
  return Number.isInteger(value) && value >= 1 && value <= 8760 ? value : AGED_DEFAULT;
}

module.exports = { QUEUE_KPI_CODES, OWNERS, AGED_KEY, DECISAO_FILA_DEFAULTS, DECISAO_FILA_SETTINGS_SCHEMA, readQueueOwner, readAgedHours };
