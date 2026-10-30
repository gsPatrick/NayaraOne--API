'use strict';

const { readFlagsParams } = require('../flags.params');
const { getProbe } = require('./probes/registry');
const { STALE_REASONS } = require('./killSwitch.constants');
const repo = require('./killSwitch.repository');

const DAY_MS = 86400000;

/**
 * Situação de verificação de um kill switch (M9-D872 §3.3). O PASS que vale é o último de HOMOLOG/DEV da MESMA versão do probe (o probe é o mesmo código nos ambientes), então
 * vale também para o switch de PROD; mudou a versão do probe sem novo PASS, o switch vence. Vence também sem PASS há mais que `governanca.flags.kill_teste_dias` (29 dias em dia, 31 vence com 30).
 * Devolve { stale, reason, lastPassAt, probeVersion, days }.
 */
async function evaluate(tenant, flagRow, { now = new Date(), transaction } = {}) {
  const params = await readFlagsParams(tenant, transaction);
  const probe = getProbe(flagRow.probe);
  const days = params.killDays;
  if (!probe) return { stale: true, reason: STALE_REASONS.probeMissing, lastPassAt: null, probeVersion: null, days };
  const at = await repo.lastPass(tenant, flagRow.key, probe.version, transaction);
  if (!at) {
    const anyVersion = await repo.lastPass(tenant, flagRow.key, null, transaction);
    return { stale: true, reason: anyVersion ? STALE_REASONS.version : STALE_REASONS.never, lastPassAt: null, probeVersion: probe.version, days };
  }
  const old = now.getTime() - at.getTime() > days * DAY_MS;
  return { stale: old, reason: old ? STALE_REASONS.old : null, lastPassAt: at.toISOString(), probeVersion: probe.version, days };
}

/** Inventário: kill switches sem probe cadastrado ou com probe que não existe no código (o teste "todo kill switch tem probe" falha se a lista não for vazia). */
async function switchesWithoutProbe(tenant, transaction) {
  const missing = await repo.withoutProbe(tenant, transaction);
  const unregistered = (await repo.listSwitches(tenant, transaction, { onlyActive: false })).filter((row) => row.probe && !getProbe(row.probe)).map((row) => ({ id: row.id, key: row.key, probe: row.probe }));
  return [...missing, ...unregistered];
}

module.exports = { evaluate, switchesWithoutProbe };
