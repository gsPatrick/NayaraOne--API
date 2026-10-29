'use strict';

/**
 * M9-D652 / M9-D611 — origem dos números dos KPIs de desperdício, custo pós-obra e recorrência: quais registros reproduzem cada KPI.
 *  obra.waste          baixas de estoque do tipo perda ligadas a uma obra (soma do custo gravado no movimento, que é o custo médio do dia da baixa);
 *  obra.postwork_cost  custo dos casos de garantia ENCERRADOS: custo de cada ação (linhas) mais mão de obra e material do próprio caso (parcela);
 *  obra.recurrence     casos de garantia vinculados a obras (as não conformidades entram no cálculo e são conferidas pelo teste de reprodução).
 * O detalhe (drill-down, M9-D690) abre essas linhas; só quem tem analytics:drilldown e a leitura do domínio chega nelas.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const CLOSED_CASE = `EXISTS (SELECT 1 FROM construction.maintenance_cases c WHERE c.id = t."warranty_case_id" AND c.company_id = t."company_id" AND c.deleted_at IS NULL AND c.status = 'CLOSED' AND c.project_id IS NOT NULL)`;

const SPECS = [
  {
    metricCode: 'obra.waste', type: 'STOCK_MOVEMENTS', table: 'inventory.inventory_movements', valueColumn: 'total_cost', columns: { equals: { movementType: 'movement_type' } },
    predicates: [() => ({ sql: 't."project_id" IS NOT NULL', replacements: {} })],
    describe: () => 'Baixas de estoque do tipo perda ligadas a obras, pelo custo médio do dia da baixa',
  },
  {
    metricCode: 'obra.postwork_cost', type: 'WARRANTY_ACTIONS', table: 'construction.warranty_actions', valueColumn: 'cost', columns: { equals: { deletedAt: 'deleted_at' } },
    predicates: [() => ({ sql: CLOSED_CASE, replacements: {} })],
    addends: [() => ({
      label: 'Mão de obra e material dos casos de garantia encerrados',
      sql: `SELECT COALESCE(SUM(COALESCE(c.labor_cost, 0) + COALESCE(c.material_cost, 0)), 0)::text AS total FROM construction.maintenance_cases c
             WHERE c.company_id = :companyId AND c.deleted_at IS NULL AND c.status = 'CLOSED' AND c.project_id IS NOT NULL`,
      replacements: {},
    })],
    describe: () => 'Ações de garantia dos casos encerrados de obras (custo realizado do pós-obra)',
  },
  {
    metricCode: 'obra.recurrence', type: 'WARRANTY_CASES', table: 'construction.maintenance_cases', columns: { equals: { deletedAt: 'deleted_at' } },
    predicates: [() => ({ sql: 't."project_id" IS NOT NULL', replacements: {} })],
    describe: () => 'Casos de garantia vinculados a obras (as não conformidades da obra também contam como ocorrência)',
  },
];

const DETAILS = {
  'obra.waste': { columns: ['project_id', 'inventory_item_id', 'movement_type', 'quantity', 'moved_at'], link: '/painel/estoque/movimentos' },
  'obra.postwork_cost': { columns: ['warranty_case_id', 'assigned_team', 'material_used', 'performed_at'], link: '/painel/obras/pos-obra' },
  'obra.recurrence': { columns: ['project_id', 'status', 'root_cause_code', 'created_at'], link: '/painel/obras/pos-obra' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAILS[spec.metricCode]);
}

module.exports = { OBRA_COST_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
