'use strict';

/**
 * M9-D697 (reabertura F08/F10) — o MOTIVO de um indicador não mostrar número, em português, e a data da última atualização da fonte. O cartão e a faixa de
 * qualidade dizem qual é o problema (fonte sem atualização, dado antigo, verificação de qualidade que falhou, dependência com dado incompleto, falta de
 * amostra) em vez de só "Dado incompleto". Texto pronto do servidor; o Front só desenha e formata a data. Nunca expõe o valor observado nem o código do check.
 */
const REASONS = Object.freeze({
  NEVER: 'A fonte deste indicador ainda não foi atualizada.',
  EXPIRED: 'A última atualização da fonte é antiga demais; o valor foi retido para não enganar.',
  CHECK: 'Uma verificação de qualidade da fonte falhou; o valor fica retido até a próxima atualização que passar.',
  INHERITED: 'Depende de outro indicador com dado incompleto.',
  SAMPLE: 'Faltam dados para calcular este indicador (sem medição ou amostra insuficiente na data).',
  STALE: 'A fonte está atrasada em relação ao limite de atualização.',
});

/** Instante (ISO) da última atualização da fonte, ou nulo quando nunca foi atualizada. */
function lastUpdateOf(metric) {
  const f = (metric && metric.freshness) || {};
  const at = f.sourceSnapshotAt || f.refreshedAt || metric.sourceSnapshotAt || metric.refreshedAt || null;
  return at ? new Date(at).toISOString() : null;
}

/** Motivo (texto) de o indicador estar sem valor confiável; nulo quando está confiável. */
function incompleteReason(metric) {
  if (!metric) return null;
  const state = metric.freshness && metric.freshness.state;
  const q = metric.quality || {};
  if (state === 'UNKNOWN') return REASONS.NEVER;
  if (state === 'EXPIRED') return REASONS.EXPIRED;
  if ((q.degradedBy || q.checks || []).length) return REASONS.CHECK;
  if ((q.inheritedFrom || q.components || []).length && metric.status !== 'OK') return REASONS.INHERITED;
  if (metric.status === 'DEGRADED' || metric.status === 'INCOMPLETE' || metric.incomplete) return REASONS.SAMPLE;
  if (metric.status === 'STALE' || state === 'STALE') return REASONS.STALE;
  return null;
}

module.exports = { incompleteReason, lastUpdateOf, REASONS };
