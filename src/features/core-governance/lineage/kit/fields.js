'use strict';

/**
 * M9-D810 — de onde cada indicador lê. Regra: a especificação de origem do BI (M9-D611, `getSourceSpec`) diz a tabela e as colunas (valor, período, status e
 * natureza); indicador composto junta os componentes. Onde a especificação aponta para um read model do próprio BI ou não existe, a origem real está aqui
 * (o que o read model lê da tabela de domínio). Falta de origem é erro de semente, nunca linha em branco.
 */
const OVERRIDES = {
  'rent.delinquency': ['finance.financial_entries.amount', 'finance.financial_entries.due_at', 'finance.financial_entries.status', 'finance.financial_entries.nature', 'finance.financial_entries.contract_id'],
  'obra.baseline_actual_forecast': ['construction.budgets.baseline_amount', 'construction.budgets.total_amount', 'finance.financial_entries.amount', 'finance.financial_entries.status', 'finance.financial_entries.construction_project_id', 'legal.contracts.total_value'],
  'obra.projected_margin': ['construction.budgets.baseline_amount', 'construction.budgets.total_amount', 'finance.financial_entries.amount', 'finance.financial_entries.status', 'finance.financial_entries.construction_project_id', 'legal.contracts.total_value'],
  'fin.approvals_pending': ['finance.approval_requests.status', 'finance.approval_requests.created_at', 'finance.approval_requests.risk_level', 'finance.financial_entries.amount', 'finance.commission_installments.amount', 'finance.owner_repasses.net_amount'],
  'inv.adjustments_pending': ['inventory.adjustment_proposals.status', 'inventory.adjustment_proposals.created_at', 'inventory.adjustment_proposals.quantity', 'inventory.adjustment_proposals.estimated_value'],
  'tec.rule_approvals_pending': ['core.rule_approval_requests.status', 'core.rule_approval_requests.created_at'],
  'ai.proposals_pending': ['ai.ai_recommendations.status', 'ai.ai_recommendations.created_at', 'ai.ai_recommendations.proposed_action'],
  'legal.contracts_signed': ['legal.signatures.signed_at', 'legal.signatures.status', 'legal.contracts.status', 'legal.contracts.contract_type', 'legal.contract_versions.version_number', 'legal.contract_versions.content_hash'],
  'crm.opportunities_won': ['crm.opportunities.stage', 'crm.opportunities.closed_at', 'crm.proposals.value', 'crm.proposals.status'],
  'fin.payments_settled_relevant': ['finance.financial_entries.amount', 'finance.financial_entries.status', 'finance.financial_entries.settled_at', 'finance.financial_entries.nature'],
};

function specColumns(spec) {
  const c = spec.columns || {};
  const columns = [spec.valueColumn, c.period, c.status, c.nature].filter(Boolean);
  return [...new Set(columns.length ? columns : ['id'])].map((column) => `${spec.table}.${column}`);
}

/** Campos de origem (`schema.tabela.coluna`) do indicador, sem repetição e em ordem estável. */
function sourceFieldsOf(code, getSourceSpec, seen = new Set()) {
  if (OVERRIDES[code]) return [...OVERRIDES[code]];
  if (seen.has(code)) return [];
  seen.add(code);
  let spec = null;
  try { spec = getSourceSpec(code); } catch (_err) { spec = null; }
  if (!spec) throw new Error(`Semente de lineage: o indicador ${code} não tem origem declarada (especificação de origem nem lista própria).`);
  if (Array.isArray(spec.components)) return [...new Set(spec.components.flatMap((component) => sourceFieldsOf(component, getSourceSpec, seen)))];
  if (!spec.table || spec.table.startsWith('analytics.')) throw new Error(`Semente de lineage: o indicador ${code} lê de um read model do BI; informe a origem real em kit/fields.js.`);
  return specColumns(spec);
}

module.exports = { sourceFieldsOf, OVERRIDES };
