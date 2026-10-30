'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const clock = require('../../features/analytics/metrics/clock'); // M9-D606: o relógio do BI é um só
const { runProbes, purgeTechSignals, PROBES } = require('../../features/analytics/tech-signals');
const { readTechParams, TECH_DEFAULTS, KEYS } = require('../../features/analytics/read-models/tecnologia.settings');

/**
 * analyticsTechProbeJob (Marco 9, M9-D628 3.4): mede as sondas de saúde do ERP (API, banco, fila e storage) a cada `analytics.tec.intervalo_sonda_s` (padrão 60 s) e
 * grava um sinal por sonda em analytics.tech_signal_log; uma vez por hora apaga os sinais mais velhos que `analytics.tec.sinais_retencao_dias`. A sonda é do sistema e
 * não de uma empresa, então o parâmetro vale pelo MENOR intervalo e pela UNIÃO das sondas configuradas entre as empresas (lido a cada 5 minutos). Falha nunca derruba o servidor.
 */
const TICK_MS = 5000;
const PARAMS_TTL_MS = 5 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const state = { lastRunAt: 0, lastPurgeAt: 0, params: null, paramsAt: 0 };

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: group.id, c: company.id }, transaction });
    return fn(transaction);
  });
}

/** { intervalS, probes, retentionDays } globais: o menor intervalo, a união das sondas e a maior retenção entre as empresas (sem empresa, os padrões). */
async function resolveGlobalParams() {
  const merged = { intervalS: TECH_DEFAULTS[KEYS.probeIntervalS], probes: new Set(), retentionDays: TECH_DEFAULTS[KEYS.signalRetentionDays] };
  let companies = 0;
  for (const group of await Group.findAll()) {
    const list = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of list) {
      const p = await tenantTx(group, company, (transaction) => readTechParams({ companyId: company.id, groupId: group.id }, transaction));
      merged.intervalS = companies === 0 ? p.probeIntervalS : Math.min(merged.intervalS, p.probeIntervalS);
      merged.retentionDays = companies === 0 ? p.signalRetentionDays : Math.max(merged.retentionDays, p.signalRetentionDays);
      p.probes.forEach((probe) => merged.probes.add(probe));
      companies += 1;
    }
  }
  if (!companies) PROBES.forEach((probe) => merged.probes.add(probe));
  return { ...merged, probes: [...merged.probes] };
}

/** Uma passada: mede as sondas se o intervalo venceu e apaga o que passou da retenção. `force` ignora o intervalo (teste). */
async function runAnalyticsTechProbeJob({ now = clock.now(), force = false } = {}) {
  if (!state.params || force || now.getTime() - state.paramsAt >= PARAMS_TTL_MS) { state.params = await resolveGlobalParams(); state.paramsAt = now.getTime(); }
  const { intervalS, probes, retentionDays } = state.params;
  const out = { probed: null, purged: 0 };
  if (force || now.getTime() - state.lastRunAt >= intervalS * 1000) {
    state.lastRunAt = now.getTime();
    out.probed = await runProbes({ probes, now });
  }
  if (force || now.getTime() - state.lastPurgeAt >= PURGE_EVERY_MS) {
    state.lastPurgeAt = now.getTime();
    out.purged = await sequelize.transaction((transaction) => purgeTechSignals({ now, retentionDays }, transaction));
  }
  return out;
}

function startAnalyticsTechProbeJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAnalyticsTechProbeJob().finally(() => { running = false; }).catch((err) => {
      logger.error({ err }, '[AnalyticsTechProbeJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAnalyticsTechProbeJob, startAnalyticsTechProbeJob };
