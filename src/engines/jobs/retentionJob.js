'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const { moduleSettingKey } = require('../../features/core-governance/governance.settings');
const { KEYS, RETENTION_SETTING_DEFAULTS } = require('../../features/core-governance/data-quality/retention.settings');
const { todayInZone, clockInZone } = require('../../features/core-governance/data-quality/retention.calendar');
const { openTenantTx } = require('../../features/core-governance/data-quality/retention.tenantTx');
const retention = require('../../features/core-governance/data-quality/retention.service');

/**
 * retentionJob (Marco 9, M9-D911 §3.3.1): uma vez por dia, a partir de governanca.retencao.job_hora:job_minuto (padrão 03:30, America/Sao_Paulo), por empresa:
 *  1. gera a SIMULAÇÃO de todas as políticas (mode DRY; nada de negócio é alterado) para o steward ler;
 *  2. para as políticas com auto_apply (o calendário de integração, que chama integration.purge_expired() com os prazos dos parâmetros integration.*, e o payload bruto de
 *     DEAD_LETTER de 7 dias), gera uma simulação só delas e a aplica na hora (a simulação vem antes; o legal hold é conferido nos dois momentos).
 * As demais políticas NUNCA são aplicadas pelo job: o apply delas é humano (POST /retention/runs/:id/apply: MFA, código da rodada e justificativa).
 * Empresa com o módulo Dados mestres desligado é pulada. Desligar no processo: RETENTION_JOB_DISABLED=true.
 */
const TICK_MS = 10 * 60 * 1000;
const lastRunDay = new Map();
const system = { userId: null, roles: [] };

async function companies() {
  const found = [];
  for (const group of await Group.findAll()) {
    const list = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of list) found.push({ groupId: group.id, companyId: company.id });
  }
  return found;
}

async function runCompany(tenant, now, force) {
  const settings = await openTenantTx(tenant, async (tx) => {
    const read = (key) => getSetting(key, tenant, tx, RETENTION_SETTING_DEFAULTS[key]);
    return { enabled: (await getSetting(moduleSettingKey('data-quality'), tenant, tx, true)) !== false, hour: Number(await read(KEYS.JOB_HORA)), minute: Number(await read(KEYS.JOB_MINUTO)) };
  });
  const day = todayInZone(now);
  const clock = clockInZone(now);
  if (!settings.enabled) return null;
  if (!force && (clock.hour < settings.hour || (clock.hour === settings.hour && clock.minute < settings.minute) || lastRunDay.get(tenant.companyId) === day)) return null;
  const dry = await openTenantTx(tenant, (tx) => retention.runDryRun(tenant, system, { source: 'JOB', now }, tx));
  const autos = await openTenantTx(tenant, async (tx) => (await retention.listPolicies(tenant, tx)).filter((policy) => policy.autoApply));
  let applied = null;
  if (autos.length) {
    const autoDry = await openTenantTx(tenant, (tx) => retention.runDryRun(tenant, system, { policyCodes: autos.map((policy) => policy.code), source: 'JOB_AUTO', now }, tx));
    applied = await retention.applyRun(tenant, system, autoDry.id, { runTx: (fn) => openTenantTx(tenant, fn), now });
  }
  if (!force) lastRunDay.set(tenant.companyId, day);
  return { companyId: tenant.companyId, dryRunId: dry.id, autoRunId: applied ? applied.id : null, autoStatus: applied ? applied.status : null };
}

/** `force` ignora a hora e o "já rodou hoje" (execução sob demanda e testes). */
async function runRetentionJob({ now = new Date(), force = false } = {}) {
  const summary = { companies: 0, ran: 0, errors: 0, summaries: [] };
  for (const tenant of await companies()) {
    summary.companies += 1;
    try {
      const result = await runCompany(tenant, now, force);
      if (result) { summary.ran += 1; summary.summaries.push(result); }
    } catch (err) {
      summary.errors += 1;
      logger.error({ companyId: tenant.companyId, err: err.message }, 'retentionJob.company.failed');
    }
  }
  return summary;
}

function startRetentionJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runRetentionJob().catch((err) => logger.error({ err: err.message }, 'retentionJob.failed')).finally(() => { running = false; });
  };
  tick();
  return setInterval(tick, tickMs);
}

module.exports = { runRetentionJob, startRetentionJob };
