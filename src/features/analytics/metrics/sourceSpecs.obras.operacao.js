'use strict';

/**
 * M9-D651 / M9-D611 — origem dos números dos KPIs de atrasos, medições e não conformidades das obras: os atrasos saem das etapas (project_stages), as
 * medições de stage_measurements e as não conformidades de nonconformities. O filtro (data-base em instante de São Paulo, início inclusivo e fim exclusivo)
 * é montado e assinado por kpis/obras/entries (filters.operacao.js); as condições que não variam ficam fixas aqui (`predicates`).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const fixed = (sql) => () => ({ sql, replacements: {} });
const LIVE = { deletedAt: 'deleted_at' };
const MEASURED_STATUSES = ['SUBMITTED', 'REVIEWED', 'APPROVED', 'PAYABLE'];

const SPECS = [
  {
    type: 'PROJECT_STAGES', table: 'construction.project_stages', metricCode: 'obra.delays', columns: { period: 'ends_at', equals: LIVE }, predicates: [fixed(`t."status" <> 'DONE' AND COALESCE(t."measured_pct", 0) < 100`)],
    describe: (f) => `Etapas não concluídas, com progresso abaixo de 100% e fim previsto antes de ${f.period && f.period.to ? day(f.period.to) : 'hoje'}`,
  },
  {
    type: 'STAGE_MEASUREMENTS', table: 'construction.stage_measurements', metricCode: 'obra.measurements', valueColumn: 'total_amount', columns: { status: 'status' },
    describe: () => `Medições enviadas em diante (${MEASURED_STATUSES.join(', ')}); rascunho, rejeitada e substituída não contam`,
  },
  {
    type: 'NONCONFORMITIES', table: 'construction.nonconformities', metricCode: 'obra.nonconformities', columns: { equals: LIVE }, predicates: [fixed(`t."status" <> 'CLOSED'`)],
    describe: () => 'Não conformidades abertas (não fechadas nem excluídas) das obras da empresa',
  },
];

for (const spec of SPECS) if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);

module.exports = { OBRA_OPERACAO_SOURCE_CODES: SPECS.map((s) => s.metricCode), MEASURED_STATUSES };
