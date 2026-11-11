'use strict';

// Apoio dos testes DI-BI-5 e DI-BI-7 ("Integrações com erro" lê a última janela FECHADA do health). Uma connection ATIVA de messaging-sandbox na empresa nova X do kit da M9-D680
// e janelas de 60 minutos do health gravadas à mão (contas feitas à mão nos testes). Relógio do BI fixado por quem chama. Banco descartável (127.0.0.1).
const kit = require('./m9d680Env');

async function activeConnection(env, t) {
  return kit.seed(env, t, 'integration.connections', { provider_code: 'messaging-sandbox', environment: 'SANDBOX', label: `m9bi janela ${kit.uuid()}`, status: 'ACTIVE' });
}

/** Janela de `minutes` minutos que começa em `startIso`, com `total` chamadas e `failed` erros. */
function healthWindow(env, t, conn, startIso, { total, failed, minutes = 60 }) {
  return kit.seed(env, t, 'integration.provider_health', {
    connection_id: conn, provider_code: 'messaging-sandbox', window_start: startIso, window_minutes: minutes, calls_total: total, calls_success: total - failed, calls_failed: failed,
    latency_p95_ms: 100, latency_p99_ms: 200, rate_limit_count: 0, auth_failures: 0, retries_total: 0, dlq_count: 0, backlog_count: 0, quota_remaining: null, updated_at: startIso,
  });
}

/** Recalcula os read models da empresa e os KPIs de Tecnologia no instante dado (relógio do BI e passada da agenda no mesmo instante) e devolve tec.integration_errors. */
async function kpiAt(env, t, instant) {
  kit.clock.setClock(instant);
  await kit.runSchedule(t, instant);
  return (await kit.kpis(t)).tech.kpis['tec.integration_errors'];
}

module.exports = { kit, activeConnection, healthWindow, kpiAt };
