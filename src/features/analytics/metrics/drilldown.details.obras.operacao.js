'use strict';

// M9-D651 / M9-D690 (3.3) — campos do registro no detalhe dos KPIs de atrasos, medições e não conformidades das obras (etapa, medição e não conformidade
// mostram a obra na linha, sem link próprio de tela).
const { registerDrilldownDetail } = require('./drilldown.details');

registerDrilldownDetail('obra.delays', { columns: ['project_id', 'ends_at', 'measured_pct'] });
registerDrilldownDetail('obra.measurements', { columns: ['project_stage_id', 'measured_pct', 'approved_at'] });
registerDrilldownDetail('obra.nonconformities', { columns: ['project_id', 'cause_code', 'team_label', 'created_at'] });
