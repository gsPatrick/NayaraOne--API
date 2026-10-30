'use strict';

const { runCollector } = require('../collectors/run');
const { previousDay } = require('../collectors/storage');
const { dayKey } = require('../costReadModel');
const { readDetectorParams } = require('./detectors.params');
const findings = require('./findings.repository');
const { DETECTORS } = require('./index');

/**
 * Roda UM detector para a empresa (M9-D862): lê, concilia os achados e registra a execução. Roda numa subtransação (runCollector): se o detector falhar, nada
 * do que ele gravou fica, NENHUM achado falso é criado nem resolvido, a falha vai a governance.cost_collector_runs (e ao log) e a função nunca lança.
 * Devolve { ok, detector, opened, updated, resolved } ou { ok: false, detector, code }.
 */
async function runDetector(tenant, detector, now, transaction, { detect } = {}) {
  let summary = { opened: 0, updated: 0, resolved: 0 };
  const result = await runCollector(tenant, detector.collector, async (sp) => {
    const params = await readDetectorParams(tenant, sp);
    const ref = detector.scope === 'day' ? previousDay(dayKey(now)) : now;
    const found = await (detect || detector.detect)(tenant, ref, params, sp);
    summary = await findings.reconcile(tenant, detector.detector, found, now, sp);
    return found.length;
  }, transaction, now);
  return { ...result, detector: detector.detector, ...summary };
}

const byCode = (code) => DETECTORS.find((d) => d.detector === code);
const bySchedule = (schedule) => DETECTORS.filter((d) => d.schedule === schedule);

/** Roda os detectores de uma rodada (`daily` ou `queue`) da empresa. */
async function runSchedule(tenant, schedule, now, transaction) {
  const out = [];
  for (const detector of bySchedule(schedule)) out.push(await runDetector(tenant, detector, now, transaction));
  return out;
}

module.exports = { runDetector, runSchedule, byCode };
