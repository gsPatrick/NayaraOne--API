'use strict';

/**
 * M9-D628 — read models de Tecnologia, Integrações, Segurança e IA do BI (schema analytics, RLS FORCE por company_id). Cada read model tem o seu arquivo em tecnologia/ (uma
 * responsabilidade por arquivo); este reúne o registro dos nove:
 *   plataforma   rm_tech_availability, rm_tech_queues, rm_tech_freshness
 *   integrações  rm_tech_integrations, rm_tech_blocked_events, rm_tech_auth_failures
 *   IA           rm_ai_cost, rm_ai_quality, rm_ai_tool_calls
 * Somente os serviços de métrica de analytics/metrics leem estas tabelas (M9-D613); painéis e briefs leem a métrica. As métricas técnicas globais têm uma cópia por empresa
 * (o RLS do BI é por empresa) e só são lidas com analytics:read:tech (DI-D628-1).
 */
const models = [
  require('./tecnologia/availability'),
  require('./tecnologia/queues'),
  require('./tecnologia/freshness'),
  require('./tecnologia/integrations'),
  require('./tecnologia/blocked-events'),
  require('./tecnologia/auth-failures'),
  require('./tecnologia/ai-cost'),
  require('./tecnologia/ai-quality'),
  require('./tecnologia/ai-tool-calls'),
];

module.exports = { TECNOLOGIA_IA_MODELS: models.map((m) => m.def.name) };
