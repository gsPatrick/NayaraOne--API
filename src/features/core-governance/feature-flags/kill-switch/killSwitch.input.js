'use strict';

const E = require('../flags.errors');
const K = require('./killSwitch.errors');
const { getProbe, listProbes } = require('./probes/registry');

const isMissing = (v) => v === undefined || v === null || v === '';

/**
 * Campos de kill switch do corpo do POST /feature-flags (M9-D872 §3.1): `isKillSwitch` só vale para flag (kind FLAG), tem risco CRITICAL (padrão) e exige `probe` — o nome de um
 * probe registrado no código (422 GOV_KILL_PROBE_REQUIRED sem ele ou com nome que não existe). `probe` fora de kill switch é recusado. Devolve { isKillSwitch, probe, risk }.
 */
function parseKillSwitch({ isKillSwitch, kind, probe, risk }) {
  if (!isKillSwitch) {
    if (!isMissing(probe)) throw E.inputInvalid('O probe só vale para kill switch.', { field: 'probe' });
    return { isKillSwitch: false, probe: null, risk: null };
  }
  if (kind !== 'FLAG') throw E.inputInvalid('Kill switch é sempre uma flag, não uma configuração.', { field: 'isKillSwitch' });
  if (isMissing(risk)) risk = 'CRITICAL';
  if (String(risk).trim().toUpperCase() !== 'CRITICAL') throw E.inputInvalid('Kill switch tem risco CRITICAL.', { field: 'risk' });
  if (isMissing(probe) || typeof probe !== 'string') throw K.probeRequired({ field: 'probe' });
  if (!getProbe(probe.trim())) throw K.probeRequired({ field: 'probe', probe: probe.trim(), registered: listProbes().map((p) => p.name) });
  return { isKillSwitch: true, probe: probe.trim(), risk: 'CRITICAL' };
}

module.exports = { parseKillSwitch };
