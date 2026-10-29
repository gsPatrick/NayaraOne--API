'use strict';

/**
 * M9-D696 (3.1 item 3; limites e estados da M9-D609) — FRESHNESS: idade de `source_snapshot_at` (a fotografia da FONTE, nunca refreshed_at).
 * FRESH até o limite do domínio (`analytics.freshness.max_minutos.<DOMINIO>`); STALE acima (WARN); EXPIRED acima de fator x limite
 * (`analytics.freshness.fator_expirado`, padrão 4; BLOCK). Idade em minutos inteiros pelo relógio injetável. Sem nenhuma linha o read model
 * ainda não tem o que envelhecer: passa com state EMPTY (a ausência de dados é coberta pela faixa de linhas).
 */
const clock = require('../../metrics/clock');
const sql = require('../quality.sql');

function freshness({ code, domain, metrics = [] }) {
  async function run(ctx) {
    const snapshot = await sql.value(ctx, `SELECT max(source_snapshot_at)::text AS v FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId`);
    const limit = ctx.params.freshnessLimits[domain];
    const factor = ctx.params.freshnessFactor;
    if (!limit) throw new Error(`Domínio de freshness desconhecido: ${domain}`);
    const expected = { maxMinutes: limit, expiredAboveMinutes: limit * factor };
    if (!snapshot) return { passed: true, expected, observed: { state: 'EMPTY', ageMinutes: null, limitMinutes: limit, factor } };
    const ageMinutes = Math.max(0, Math.floor((clock.now().getTime() - new Date(snapshot).getTime()) / 60000));
    const observed = { sourceSnapshotAt: new Date(snapshot).toISOString(), ageMinutes, limitMinutes: limit, factor, state: 'FRESH' };
    if (ageMinutes <= limit) return { passed: true, expected, observed };
    if (ageMinutes > limit * factor) return { passed: false, severityKey: 'FRESHNESS_EXPIRED', expected, observed: { ...observed, state: 'EXPIRED' } };
    return { passed: false, severityKey: 'FRESHNESS_STALE', expected, observed: { ...observed, state: 'STALE' } };
  }
  return { code, type: 'FRESHNESS', domain, metrics, run };
}

module.exports = { freshness };
