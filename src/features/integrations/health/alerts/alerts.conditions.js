'use strict';

const { loadHealthContext } = require('../healthContext');
const { findCurrentRow } = require('../healthStore');
const { getWindowSample } = require('../metrics');
const { evaluateConnectionSecret } = require('../../secrets/secretExpiry');
const { readSecretParams } = require('../../secrets/secretParams');
const { readQuotaParams } = require('../../dispatch/quota/quota.params');

const MIN_MS = 60000;

/** PROVIDER_DOWN: o teste de saúde ativo marcou DOWN, ou o disjuntor está aberto há mais que `circuit_open_min`. HIGH (CRITICAL se a criticidade é CRITICAL). */
function providerDown(row, hc, params, now) {
  if (!row) return null;
  const porSaude = Number(row.check_consecutive_failures) >= hc.params.downAfterFailures;
  const aberto = row.circuit_state === 'OPEN' && row.circuit_opened_at && now.getTime() - new Date(row.circuit_opened_at).getTime() > params.circuitOpenMin * MIN_MS;
  if (!porSaude && !aberto) return null;
  const severity = hc.criticality === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
  return { type: 'PROVIDER_DOWN', marker: '', severity, details: { reason: porSaude ? 'HEALTH_CHECK' : 'CIRCUIT_OPEN', consecutiveFailures: Number(row.check_consecutive_failures), circuitOpenedAt: row.circuit_opened_at || null, criticality: hc.criticality } };
}

/** ERROR_RATE_UP: sucesso da última hora abaixo da meta do SLO da criticidade. MEDIUM (HIGH se a criticidade é CRITICAL). Sem chamadas não há taxa. */
function errorRateUp(window, hc) {
  const taxa = window.metrics.successRate;
  if (taxa === null || taxa >= hc.slo.minSuccessRate) return null;
  const severity = hc.criticality === 'CRITICAL' ? 'HIGH' : 'MEDIUM';
  return { type: 'ERROR_RATE_UP', marker: '', severity, details: { window: '1h', successRate: taxa, target: hc.slo.minSuccessRate, callsTotal: window.aggregate.callsTotal, criticality: hc.criticality } };
}

/** AUTH_FAILURE: a connection está em AUTH_FAILED (credencial recusada duas vezes ou vencida). HIGH. */
const authFailure = (connection) => (connection.status === 'AUTH_FAILED'
  ? { type: 'AUTH_FAILURE', marker: '', severity: 'HIGH', details: { status: 'AUTH_FAILED' } } : null);

/** Severidade do aviso de credencial: o marco mais distante é LOW, o mais próximo HIGH e os do meio MEDIUM (30, 14 e 7 dias = LOW, MEDIUM, HIGH). */
function secretSeverity(marco, marcos) {
  const ordenados = [...marcos].sort((a, b) => b - a);
  if (marco === ordenados[0]) return 'LOW';
  if (marco === ordenados[ordenados.length - 1]) return 'HIGH';
  return 'MEDIUM';
}

/** SECRET_EXPIRING: o marco de aviso (`integration.secret.expiry_alert_days`) em que a credencial está; um alerta por marco, o mais urgente substitui o anterior. */
async function secretExpiring(connection, domain, ctx, now, transaction) {
  const [aval, params] = await Promise.all([
    evaluateConnectionSecret(connection, { domain, now: now.getTime(), transaction, ctx }),
    readSecretParams(ctx, transaction),
  ]);
  if (aval.state !== 'EXPIRING') return null;
  return {
    type: 'SECRET_EXPIRING', marker: String(aval.alertDays), severity: secretSeverity(aval.alertDays, params.alertDays),
    details: { daysLeft: Math.max(0, Math.floor(aval.daysLeft)), alertDays: aval.alertDays, deadline: aval.deadline },
  };
}

/** SYNC_STALLED: um alerta por fluxo parado (a marca é o id do cursor). HIGH. `stalls` vem do detector da M9-D208. */
const syncStalled = (stalls) => stalls.map((s) => ({
  type: 'SYNC_STALLED', marker: s.cursorId, severity: 'HIGH',
  details: { stream: s.stream, reason: s.reason || 'NO_SUCCESS', minutesWithoutSuccess: s.minutesWithoutSuccess ?? null, limitMinutes: s.limitMinutes ?? null, criticality: s.criticality || null },
}));

/** QUOTA_LOW: o que resta da cota do fornecedor está abaixo da reserva (`integration.rate_limit.reserve_pct`) e a cota ainda não renovou. MEDIUM. */
async function quotaLow(row, ctx, now, transaction) {
  if (!row || row.quota_limit === null || row.quota_remaining === null || !(row.quota_limit > 0)) return null;
  if (row.quota_resets_at && new Date(row.quota_resets_at).getTime() <= now.getTime()) return null;
  const { reservePct } = await readQuotaParams(ctx, transaction);
  if (row.quota_remaining * 100 >= row.quota_limit * reservePct) return null;
  return { type: 'QUOTA_LOW', marker: '', severity: 'MEDIUM', details: { limit: row.quota_limit, remaining: row.quota_remaining, reservePct, resetsAt: row.quota_resets_at || null } };
}

/**
 * Condições de alerta vigentes de UMA connection (M9-D224 3.3). Devolve uma lista de { type, marker, severity, details }: cada item é uma
 * condição ATIVA; o que não está na lista não é alerta. Connection fora de ACTIVE e AUTH_FAILED só pode ter AUTH_FAILURE.
 */
async function evaluateConnectionConditions(connection, ctx, { now, params, stalls = [], domain = null }, transaction) {
  const ativa = connection.status === 'ACTIVE';
  const [hc, row] = await Promise.all([loadHealthContext(connection, transaction), findCurrentRow(connection.id, transaction)]);
  const out = [authFailure(connection)];
  if (ativa) {
    const window = await getWindowSample(connection, '1h', now, transaction);
    out.push(providerDown(row, hc, params, now), errorRateUp(window, hc), await secretExpiring(connection, domain, ctx, now, transaction), await quotaLow(row, ctx, now, transaction), ...syncStalled(stalls));
  }
  return out.filter(Boolean);
}

module.exports = { evaluateConnectionConditions, secretSeverity };
