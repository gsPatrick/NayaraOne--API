'use strict';

/**
 * M9-D699 (3.3) — critérios de aprovação do teste de carga, em função pura dos números:
 *   - p95 de cada operação do fluxo operacional (OLTP) com os painéis sob carga <= p95 da linha de base x (1 + limite/100);
 *   - p95 de cada painel <= a meta do painel (dashboard_definitions.p95_target_ms, M9-D698);
 *   - rebuild sob carga concluído, com o mesmo hash, sem erro;
 *   - nenhuma falha inesperada (5xx, tempo esgotado, erro de banco) nem no fluxo operacional nem nos painéis.
 * Piso absoluto (analytics.carga.tolerancia_absoluta_ms): também passa quem excede a linha de base em no máximo esse tanto de ms.
 * O limite de degradação é o parâmetro analytics.carga.degradacao_max_pct (padrão 10). Comparação exata em inteiros (microssegundos e
 * centésimos de ponto percentual), sem ponto flutuante na decisão.
 */
const micros = (ms) => Math.round(Number(ms) * 1000);

/** Variação percentual do p95 com 1 casa (texto), só para o relatório. Linha de base zero: null. */
function variationPct(baseMs, withBiMs) {
  const base = micros(baseMs);
  if (base <= 0) return null;
  return (Math.round(((micros(withBiMs) - base) * 1000) / base) / 10).toFixed(1);
}

/** Uma operação dentro do limite: percentual OU piso absoluto (em microssegundos, sem ponto flutuante). */
function within(base, bi, maxPct, floorMs) {
  const withinPct = micros(bi) * 100 <= micros(base) * (100 + maxPct);
  // piso absoluto (analytics.carga.tolerancia_absoluta_ms): operação de poucos ms oscila mais que o percentual só por ruído da máquina
  const withinFloor = micros(bi) - micros(base) <= micros(floorMs);
  return { pass: withinPct || withinFloor, byFloor: !withinPct && withinFloor };
}

/**
 * Três formas de a operação ficar dentro do limite (DI-D699-9); degradação real não passa em nenhuma:
 *   1. o p95 agregado de todas as rodadas dentro do percentual ou do piso absoluto;
 *   2. mediana das rodadas: cada rodada (base, BI) é comparada sozinha e MAIS DA METADE fica dentro do limite;
 *   3. envelope de ruído: o p95 com BI não passa do MAIOR p95 de rodada da própria linha de base (a diferença não se distingue da
 *      oscilação que a máquina já tem sem o BI). Sem `rounds`, vale só o p95 agregado.
 */
function oltpResult(baseline, withBi, maxPct, floorMs = 0, rounds = []) {
  const out = {};
  for (const [op, base] of Object.entries(baseline)) {
    const bi = withBi[op];
    if (!bi || base.p95 === null || bi.p95 === null) {
      out[op] = { baselineP95: base.p95, withBiP95: bi ? bi.p95 : null, variationPct: null, pass: false, reason: 'sem amostra suficiente' };
      continue;
    }
    const perRound = rounds.map((r) => (r.baseline[op] && r.withBi[op] && r.baseline[op].p95 !== null && r.withBi[op].p95 !== null
      ? within(r.baseline[op].p95, r.withBi[op].p95, maxPct, floorMs).pass : false));
    const roundsPassed = perRound.filter(Boolean).length;
    const aggregate = within(base.p95, bi.p95, maxPct, floorMs);
    const baseRounds = rounds.map((r) => (r.baseline[op] ? r.baseline[op].p95 : null)).filter((v) => v !== null);
    const envelopeMs = baseRounds.length ? Math.max(...baseRounds) : null;
    const byMedian = perRound.length > 0 && roundsPassed * 2 > perRound.length;
    const byNoise = envelopeMs !== null && micros(bi.p95) <= micros(envelopeMs);
    const pass = aggregate.pass || byMedian || byNoise;
    out[op] = {
      baselineP95: base.p95, withBiP95: bi.p95, variationPct: variationPct(base.p95, bi.p95), pass, byFloor: aggregate.byFloor,
      ...(perRound.length ? { roundsPassed, roundsTotal: perRound.length, baselineRoundMaxP95: envelopeMs } : {}),
      reason: pass ? null : `p95 ${bi.p95} ms contra ${base.p95} ms (limite ${maxPct}% e piso de ${floorMs} ms${perRound.length ? `; ${roundsPassed} de ${perRound.length} rodadas dentro do limite; maior p95 de rodada sem BI ${envelopeMs} ms` : ''})`,
    };
  }
  return out;
}

function panelResult(panels, targets) {
  const out = {};
  for (const [code, s] of Object.entries(panels)) {
    const target = targets[code];
    const pass = target !== undefined && s.p95 !== null && micros(s.p95) <= micros(target);
    out[code] = { p95: s.p95, targetMs: target === undefined ? null : target, pass, reason: pass ? null : `p95 ${s.p95} ms contra a meta de ${target === undefined ? 'sem meta' : `${target} ms`}` };
  }
  return out;
}

/** O painel (ou consulta) que mais tempo de servidor consumiu: a pista do responsável quando a degradação reprova a etapa. */
function culprit(panels) {
  const ranked = Object.entries(panels).map(([code, s]) => ({ code, totalMs: (s.p50 || 0) * s.count })).sort((a, b) => b.totalMs - a.totalMs);
  return ranked.length ? { panel: ranked[0].code, totalMs: Math.round(ranked[0].totalMs) } : null;
}

/** input: { baseline, withBi, panels, targets, rebuild, maxPct, floorMs, rounds, unexpected } -> { pass, oltp, panels, rebuild, failures[], culprit } */
function evaluate({ baseline, withBi, panels, targets, rebuild, maxPct, floorMs = 0, rounds = [], unexpected = 0 }) {
  const oltp = oltpResult(baseline, withBi, maxPct, floorMs, rounds);
  const panelsOut = panelResult(panels, targets);
  const rebuildOut = {
    pass: Boolean(rebuild && rebuild.completed && rebuild.hashBefore === rebuild.hashAfter && !rebuild.error),
    reason: rebuild && rebuild.completed && rebuild.hashBefore === rebuild.hashAfter && !rebuild.error ? null
      : (rebuild && rebuild.error) || 'o rebuild não concluiu ou o hash mudou', ...(rebuild || {}),
  };
  const failures = [
    ...Object.entries(oltp).filter(([, r]) => !r.pass).map(([op, r]) => ({ kind: 'OLTP', name: op, reason: r.reason })),
    ...Object.entries(panelsOut).filter(([, r]) => !r.pass).map(([code, r]) => ({ kind: 'PAINEL', name: code, reason: r.reason })),
    ...(rebuildOut.pass ? [] : [{ kind: 'REBUILD', name: 'rm_finance_health', reason: rebuildOut.reason }]),
    ...(unexpected > 0 ? [{ kind: 'ERRO', name: 'falhas inesperadas', reason: `${unexpected} falha(s) inesperada(s) durante a carga` }] : []),
  ];
  return { pass: failures.length === 0, maxPct, floorMs, oltp, panels: panelsOut, rebuild: rebuildOut, failures, culprit: failures.length ? culprit(panels) : null };
}

module.exports = { evaluate, variationPct, oltpResult, panelResult };
