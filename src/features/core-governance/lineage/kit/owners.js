'use strict';

/**
 * M9-D810 — responsável (domínio de dados mestres, M9-D804) e área de cada nó que as sementes derivam do sistema. Funções puras e sem estado: o mesmo nó
 * (por exemplo `finance.financial_entries.amount`) sai igual de qualquer semente, o que permite juntá-las sem conflito.
 */
const { AREA } = require('../lineage.constants');

const TABLE_RULES = [
  [/^(finance\.(commission|owner_repass)|correspondent\.commission)/, 'COMISSOES', AREA.COMMISSION],
  [/^finance\./, 'FINANCEIRO', AREA.MONEY],
  [/^legal\.(contract|signature)/, 'CONTRATOS', AREA.CONTRACT],
  [/^legal\./, 'CONTRATOS', AREA.EXEC_KPI],
  [/^correspondent\.dimob/, 'FISCAL', AREA.DIMOB],
  [/^correspondent\./, 'CORRESPONDENTE', AREA.EXEC_KPI],
  [/^crm\./, 'CRM', AREA.EXEC_KPI],
  [/^marketing\./, 'CRM', AREA.EXEC_KPI],
  [/^real_estate\./, 'IMOVEIS', AREA.EXEC_KPI],
  [/^people\./, 'PESSOAS', AREA.EXEC_KPI],
  [/^construction\./, 'OBRAS', AREA.EXEC_KPI],
  [/^inventory\./, 'ESTOQUE', AREA.EXEC_KPI],
];
const EVENT_RULES = [
  [/^finance\.(commission|owner_repass)/, 'COMISSOES', AREA.COMMISSION],
  [/^finance\./, 'FINANCEIRO', AREA.MONEY],
  [/^legal\./, 'CONTRATOS', AREA.CONTRACT],
  [/^correspondent\.dimob/, 'FISCAL', AREA.DIMOB],
  [/^correspondent\./, 'CORRESPONDENTE', AREA.EXEC_KPI],
  [/^(crm|marketing|radar)\./, 'CRM', AREA.EXEC_KPI],
  [/^(property|real_estate)\./, 'IMOVEIS', AREA.EXEC_KPI],
  [/^(construction|obra|project)\./, 'OBRAS', AREA.EXEC_KPI],
  [/^(inventory|tool)\./, 'ESTOQUE', AREA.EXEC_KPI],
];
const READ_MODEL_RULES = [
  [/^analytics\.rm_fin_commission/, 'COMISSOES', AREA.COMMISSION],
  [/^analytics\.rm_(finance|fin_)/, 'FINANCEIRO', AREA.MONEY],
  [/^analytics\.rm_mkt_campaign_month/, 'CRM', AREA.MONEY],
  [/^analytics\.rm_(crm|radar|broker|mkt|support)/, 'CRM', AREA.EXEC_KPI],
  [/^analytics\.rm_property/, 'IMOVEIS', AREA.EXEC_KPI],
  [/^analytics\.rm_(rental|legal)/, 'CONTRATOS', AREA.EXEC_KPI],
  [/^analytics\.rm_(project|postwork|obra)/, 'OBRAS', AREA.EXEC_KPI],
  [/^analytics\.rm_(inventory|tool)/, 'ESTOQUE', AREA.EXEC_KPI],
  [/^correspondent\.dimob/, 'FISCAL', AREA.DIMOB],
];
const FALLBACK = ['TECNOLOGIA', AREA.EXEC_KPI];

function match(rules, code) {
  const hit = rules.find(([pattern]) => pattern.test(code));
  return hit ? { ownerDomain: hit[1], area: hit[2] } : { ownerDomain: FALLBACK[0], area: FALLBACK[1] };
}

const fieldOwnership = (qualifiedColumn) => match(TABLE_RULES, qualifiedColumn);
const eventOwnership = (eventType) => match(EVENT_RULES, eventType);
const readModelOwnership = (qualifiedTable) => match(READ_MODEL_RULES, qualifiedTable);

/** Domínio responsável pelo indicador: o de comissões/contratos pela área, os demais pelo domínio do BI. */
const BI_DOMAIN_OWNER = { FINANCE: 'FINANCEIRO', CRM: 'CRM', PROPERTIES: 'IMOVEIS', RENTAL: 'CONTRATOS', CONSTRUCTION: 'OBRAS', INVENTORY: 'ESTOQUE', LEGAL: 'CONTRATOS', CORRESPONDENT: 'CORRESPONDENTE', MARKETING: 'CRM', SUPPORT: 'CRM', TECH_AI: 'TECNOLOGIA' };
function metricOwner(row) {
  if (row.area === AREA.COMMISSION) return 'COMISSOES';
  if (row.area === AREA.CONTRACT) return 'CONTRATOS';
  return BI_DOMAIN_OWNER[row.domain] || 'TECNOLOGIA';
}

module.exports = { fieldOwnership, eventOwnership, readModelOwnership, metricOwner };
