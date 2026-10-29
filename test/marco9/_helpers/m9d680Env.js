'use strict';

// Apoio dos testes dos KPIs de Tecnologia no BI (M9-D680): tec.availability, tec.queues_dlq, tec.integration_errors, tec.freshness, tec.auth_failures e tec.blocked_events.
// Duas empresas novas (contagens independentes), relógio fixo (12:00 de 28/10/2026 em São Paulo), fontes dos read models da M9-D628 e sinais técnicos globais.
const { createKit } = require('./biKpiKit');
const env628 = require('./m9d628Env');
const plataforma = require('./m9d628Plataforma');
const integracoes = require('./m9d628Integracoes');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const CODES = ['tec.availability', 'tec.queues_dlq', 'tec.integration_errors', 'tec.freshness', 'tec.auth_failures', 'tec.blocked_events'];

const kit = createKit({
  models: env628.MODELS, label: 'D680',
  materialize: async (t, asOf, tx) => ({ tech: await kpisApi.materializeTechKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

async function setup() {
  const env = await kit.setup();
  await env.admin.query('DELETE FROM analytics.tech_signal_log'); // sinais de outro teste não entram nas contas deste
  return env;
}

/** Fontes de uma empresa: filas, atualizações de read models, integrações, autenticação e bloqueios (as mesmas da M9-D628). As sondas ficam por conta de cada teste. */
async function seedSources(env, t) {
  await plataforma.filas(env, t);
  await plataforma.atualizacoes(env, t);
  const conns = await integracoes.integracoes(env, t);
  await integracoes.autenticacao(env, t, conns);
  await integracoes.bloqueios(env, t);
  return conns;
}

/** Sondas horárias de 28/10 (00:00 a 11:00 de SP): API com `apiDown` falhas, DATABASE sempre ok. Com intervalo de 3600 s o esperado de hoje às 12:00 é 12 por sonda. */
async function hourlyProbes(env, { apiDown = 1, hours = 12 } = {}) {
  for (let h = 0; h < hours; h += 1) {
    const at = new Date(Date.UTC(2026, 9, 28, 3 + h, 10)); // 00:10 + h hora(s) de SP
    await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: h >= apiDown, occurredAt: at });
    await env628.signal(env, { kind: 'PROBE', probe: 'DATABASE', ok: true, occurredAt: at });
  }
}

module.exports = { ...kit, ...env628, CODES, setup, seedSources, hourlyProbes, MODELS: env628.MODELS };
