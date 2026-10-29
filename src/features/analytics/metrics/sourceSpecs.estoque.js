'use strict';

/**
 * M9-D653 / M9-D611 — origem dos números dos KPIs de Estoque e Patrimônio: quais registros do Estoque reproduzem cada KPI.
 *  inv.stock_value     saldos dos itens ativos dos tipos do parâmetro analytics.estoque.tipos_item (flag stockTypes); a soma é saldo × custo médio;
 *  inv.below_minimum   itens ativos desses tipos com estoque mínimo definido e saldo total abaixo dele;
 *  inv.losses          casos de perda decididos como perda (APPROVED) na janela de dias do parâmetro analytics.estoque.janela_perdas_dias (padrão 30); vale o custo do movimento de baixa, ou o estimado sem ele;
 *  inv.tools_overdue   empréstimos abertos (OPEN ou OVERDUE) com devolução prevista anterior à data-base.
 * O detalhe (drill-down, M9-D690) abre essas linhas; só quem tem analytics:drilldown e a leitura do estoque chega nelas.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const typesOf = (filter) => String(((filter.equals || {}).stockTypes) || 'CONSUMABLE').split(',').map((s) => s.trim()).filter(Boolean);
const ACTIVE_ITEM = (alias) => `${alias}."deleted_at" IS NULL AND ${alias}."status" = 'ACTIVE' AND ${alias}."item_type" IN (:invTypes)`;
const ON_HAND = `COALESCE((SELECT SUM(b.quantity_on_hand) FROM inventory.stock_balances b WHERE b.company_id = t."company_id" AND b.inventory_item_id = t."id"), 0)`;

const SPECS = [
  {
    metricCode: 'inv.stock_value', type: 'STOCK_BALANCES', table: 'inventory.stock_balances', valueColumn: 'quantity_on_hand', flags: ['stockTypes'],
    predicates: [(filter) => ({
      sql: `EXISTS (SELECT 1 FROM inventory.inventory_items i WHERE i.id = t."inventory_item_id" AND i.company_id = t."company_id" AND ${ACTIVE_ITEM('i')})`, replacements: { invTypes: typesOf(filter) },
    })],
    addends: [(filter) => ({
      label: 'Valorização pelo custo médio (saldo × (custo médio − 1)): linhas mais esta parcela dão saldo × custo médio',
      sql: `SELECT COALESCE(SUM(b.quantity_on_hand * (COALESCE(i.average_cost, 0) - 1)), 0)::text AS total FROM inventory.stock_balances b JOIN inventory.inventory_items i ON i.id = b.inventory_item_id AND i.company_id = b.company_id
             WHERE b.company_id = :companyId AND ${ACTIVE_ITEM('i')}`,
      replacements: { invTypes: typesOf(filter) },
    })],
    describe: () => 'Saldos dos itens ativos do estoque, valorizados pelo custo médio ponderado',
  },
  {
    metricCode: 'inv.below_minimum', type: 'INVENTORY_ITEMS', table: 'inventory.inventory_items', flags: ['stockTypes'],
    predicates: [(filter) => ({ sql: `(${ACTIVE_ITEM('t')} AND t."minimum_quantity" IS NOT NULL AND ${ON_HAND} < t."minimum_quantity")`, replacements: { invTypes: typesOf(filter) } })],
    describe: () => 'Itens ativos com saldo total abaixo do estoque mínimo',
  },
  {
    metricCode: 'inv.losses', type: 'LOSS_CASES', table: 'inventory.loss_cases', valueColumn: 'estimated_cost', columns: { status: 'status', period: 'decided_at' },
    addends: [(filter) => ({
      label: 'Custo do movimento de baixa no lugar do estimado',
      sql: `SELECT COALESCE(SUM(mv.total_cost - COALESCE(lc.estimated_cost, 0)), 0)::text AS total FROM inventory.loss_cases lc
             JOIN inventory.inventory_movements mv ON mv.id = lc.resulting_movement_id AND mv.company_id = lc.company_id
            WHERE lc.company_id = :companyId AND lc.status IN (:addStatus) AND lc.decided_at >= :addFrom AND lc.decided_at < :addTo AND mv.total_cost IS NOT NULL`,
      replacements: { addStatus: filter.status && filter.status.length ? filter.status : ['APPROVED'], addFrom: (filter.period || {}).from || '1970-01-01T00:00:00.000Z', addTo: (filter.period || {}).to || '2999-01-01T00:00:00.000Z' },
    })],
    describe: (f) => `Casos de perda decididos como perda de ${f.period && f.period.from ? String(f.period.from).slice(0, 10) : 'sempre'} até antes de ${f.period && f.period.to ? String(f.period.to).slice(0, 10) : 'hoje'}`,
  },
  {
    metricCode: 'inv.tools_overdue', type: 'TOOL_LOANS', table: 'inventory.tool_loans', columns: { status: 'status', period: 'due_at' },
    describe: (f) => `Empréstimos de ferramenta abertos com devolução prevista antes de ${f.period && f.period.to ? String(f.period.to).slice(0, 10) : 'hoje'}`,
  },
];

const DETAILS = {
  'inv.stock_value': { columns: ['inventory_item_id', 'location_id'], link: '/painel/estoque' },
  'inv.below_minimum': { columns: ['name', 'item_type', 'minimum_quantity'], link: '/painel/estoque' },
  'inv.losses': { columns: ['inventory_item_id', 'project_id', 'quantity', 'resulting_movement_id'], link: '/painel/estoque/perdas' },
  'inv.tools_overdue': { columns: ['asset_id', 'person_user_id', 'escalation_level'], link: '/painel/estoque/patrimonio' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAILS[spec.metricCode]);
}

module.exports = { INVENTORY_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
