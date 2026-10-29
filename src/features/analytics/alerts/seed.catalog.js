'use strict';

/**
 * M9-D691 (3.3) — catálogo dos alertas semente. Cada um tem o parâmetro do administrador `analytics.alerta_semente.<chave>` com o texto
 * "<código da métrica> [recorte] <operador> <valor>[%], <INFO|WARNING|CRITICAL>[ com tarefa]" (o alerta de freshness usa "métrica CRITICAL em STALE,
 * <severidade>"). O padrão é o do livro/parametros.csv. O recorte (30d, vencidos) é a dimensão do KPI que o alerta lê.
 */
const SEEDS = Object.freeze([
  { key: 'fin_free_cash_baixo', alertCode: 'fin_free_cash_baixo', default: 'fin.free_cash < R$ 50.000,00, WARNING' },
  { key: 'fin_necessidade_respirar', alertCode: 'fin_breathing_need', default: 'fin.breathing_need > 0, WARNING' },
  { key: 'freshness_critica', alertCode: 'analytics_freshness_critica', kind: 'FRESHNESS', default: 'métrica CRITICAL em STALE, WARNING' },
  { key: 'garantia_vencendo_30d', alertCode: 'rent_garantia_30d', default: 'rent.guarantees_expiring 30d > 0, WARNING' },
  { key: 'integracao_erro', alertCode: 'tec_integracao_erro', default: 'tec.integration_errors > 10%, CRITICAL' },
  { key: 'orcamento_ia', alertCode: 'ai_orcamento', default: 'ai.budget > 80%, WARNING' },
  { key: 'prazo_juridico_vencido', alertCode: 'legal_prazo_vencido', default: 'legal.deadlines vencidos > 0, CRITICAL com tarefa' },
]);

/** Métrica sintética do alerta de freshness (a instância guarda a métrica vencida em `metric_code`). */
const FRESHNESS_METRIC_CODE = 'analytics.freshness_stale';

const settingKey = (seed) => `analytics.alerta_semente.${seed.key}`;

module.exports = { SEEDS, FRESHNESS_METRIC_CODE, settingKey };
