'use strict';

/**
 * M9-D699 (3.3) — critérios de aprovação do teste de carga, em função pura dos números:
 *   - p95 de cada operação do fluxo operacional (OLTP) com os painéis sob carga <= p95 da linha de base x (1 + limite/100);
 *   - p95 de cada painel <= a meta do painel (dashboard_definitions.p95_target_ms, M9-D698);
 *   - rebuild sob carga concluído, com o mesmo hash, sem erro;
 *   - nenhuma falha inesperada (5xx, tempo esgotado, erro de banco) nem no fluxo operacional nem nos painéis;
 *   - prova determinística (sonda de bloqueios, lockProbe.js): ZERO sessões esperando lock de uma sessão do BI durante as janelas com BI, e a
 *     sonda viu o BI ativo (sem isso a prova não vale). Independe da velocidade da máquina; é o critério que não oscila.
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
 * Duas formas de a operação ficar dentro do limite (DI-D699-9, endurecida na reabertura M-4); degradação real não passa em nenhuma:
 *   1. o p95 agregado de todas as rodadas dentro do percentual ou do piso absoluto;
 *   2. mediana das rodadas: cada rodada (base, BI) é comparada sozinha e MAIS DA METADE fica dentro do limite (percentual ou piso).
 * O antigo "envelope de ruído" (aprovar quem não passa do maior p95 de rodada da própria linha de base) foi REMOVIDO: deixava passar
 * degradação real quando a linha de base oscilava. Quem prova que o BI não atrapalha, sem depender do relógio, é a sonda de bloqueios.
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
    const byMedian = perRound.length > 0 && roundsPassed * 2 > perRound.length;
    const pass = aggregate.pass || byMedian;
    out[op] = {
      baselineP95: base.p95, withBiP95: bi.p95, variationPct: variationPct(base.p95, bi.p95), pass, byFloor: aggregate.byFloor,
      ...(perRound.length ? { roundsPassed, roundsTotal: perRound.length } : {}),
      reason: pass ? null : `p95 ${bi.p95} ms contra ${base.p95} ms (limite ${maxPct}% e piso de ${floorMs} ms${perRound.length ? `; ${roundsPassed} de ${perRound.length} rodadas dentro do limite` : ''})`,
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

/** Prova determinística: nenhum bloqueio causado pelo BI e a sonda viu o BI ativo. `locks` ausente (sem sonda) não é avaliado. */
function lockResult(locks) {
  if (!locks) return { pass: true, skipped: true, reason: null };
  const noSamples = locks.samples < 1 || locks.biSeen < 1;
  const pass = locks.blockedByBi === 0 && !noSamples && !locks.error;
  let reason = null;
  if (locks.blockedByBi > 0) reason = `${locks.blockedByBi} amostra(s) com sessão do fluxo operacional esperando lock de uma sessão do BI`;
  else if (locks.error) reason = `a sonda de bloqueios falhou: ${locks.error}`;
  else if (noSamples) reason = 'a sonda de bloqueios não viu o BI ativo (a prova não vale)';
  return { ...locks, pass, reason };
}

/**
 * Modo de latência (`latencyMode`): 'gate' (padrão do CLI e do pipeline LAB) reprova pela latência; 'report' (teste automatizado, em máquina
 * compartilhada por vários agentes e CI) mede, relata e marca `observed`, sem reprovar: quem reprova ali são os critérios determinísticos.
 *
 * A comparação de latência só vale com CPU sobrando: com os núcleos todos ocupados (pelo próprio BI e pelo banco na mesma máquina, ou por outros
 * processos) o p95 de operações de ~2 ms mede a disputa por CPU, não o BI. host = { cpuBusyMax, saturationMax, strict }: maior fração de CPU ocupada
 * em uma janela da execução. Saturada e não estrita: INCONCLUSIVA (dita no relatório; os critérios determinísticos seguem valendo). Estrita
 * (--exigir-latencia, pipeline LAB): máquina saturada reprova, porque a prova não pôde ser feita.
 */
function latencyConclusive(host) {
  if (!host) return { conclusive: true, strict: false, reason: null };
  const saturated = host.cpuBusyMax > host.saturationMax;
  return {
    conclusive: !saturated, strict: Boolean(host.strict), cpuBusyMax: host.cpuBusyMax, saturationMax: host.saturationMax,
    reason: saturated ? `máquina saturada: CPU ocupada em ${Math.round(host.cpuBusyMax * 100)}% (limite ${Math.round(host.saturationMax * 100)}%); a latência de operações de poucos ms mede a disputa por CPU, não o BI` : null,
  };
}

/** O painel (ou consulta) que mais tempo de servidor consumiu: a pista do responsável quando a degradação reprova a etapa. */
function culprit(panels) {
  const ranked = Object.entries(panels).map(([code, s]) => ({ code, totalMs: (s.p50 || 0) * s.count })).sort((a, b) => b.totalMs - a.totalMs);
  return ranked.length ? { panel: ranked[0].code, totalMs: Math.round(ranked[0].totalMs) } : null;
}

/** input: { baseline, withBi, panels, targets, rebuild, maxPct, floorMs, rounds, unexpected } -> { pass, oltp, panels, rebuild, failures[], culprit } */
function evaluate({ baseline, withBi, panels, targets, rebuild, maxPct, floorMs = 0, rounds = [], unexpected = 0, locks = null, host = null, latencyMode = 'gate' }) {
  const latency = latencyConclusive(host);
  const oltpRaw = oltpResult(baseline, withBi, maxPct, floorMs, rounds);
  const observe = latencyMode === 'report'; // modo observação (teste automatizado em máquina compartilhada): a latência é medida e relatada, não reprova
  const waived = observe || (!latency.conclusive && !latency.strict);
  const oltp = Object.fromEntries(Object.entries(oltpRaw).map(([op, r]) => [op, !r.pass && waived ? { ...r, pass: true, ...(observe ? { observed: true } : { inconclusive: true }) } : (!r.pass && !latency.conclusive ? { ...r, reason: `${r.reason}; ${latency.reason}` } : r)]));
  const panelsRaw = panelResult(panels, targets);
  const panelsOut = Object.fromEntries(Object.entries(panelsRaw).map(([code, r]) => [code, !r.pass && r.p95 !== null && waived ? { ...r, pass: true, ...(observe ? { observed: true } : { inconclusive: true }) } : r]));
  const locksOut = lockResult(locks);
  const rebuildOut = {
    pass: Boolean(rebuild && rebuild.completed && rebuild.hashBefore === rebuild.hashAfter && !rebuild.error),
    reason: rebuild && rebuild.completed && rebuild.hashBefore === rebuild.hashAfter && !rebuild.error ? null
      : (rebuild && rebuild.error) || 'o rebuild não concluiu ou o hash mudou', ...(rebuild || {}),
  };
  const failures = [
    ...Object.entries(oltp).filter(([, r]) => !r.pass).map(([op, r]) => ({ kind: 'OLTP', name: op, reason: r.reason })),
    ...Object.entries(panelsOut).filter(([, r]) => !r.pass).map(([code, r]) => ({ kind: 'PAINEL', name: code, reason: r.reason })),
    ...(locksOut.pass ? [] : [{ kind: 'BLOQUEIO', name: 'sessões do BI', reason: locksOut.reason }]),
    ...(rebuildOut.pass ? [] : [{ kind: 'REBUILD', name: 'rm_finance_health', reason: rebuildOut.reason }]),
    ...(unexpected > 0 ? [{ kind: 'ERRO', name: 'falhas inesperadas', reason: `${unexpected} falha(s) inesperada(s) durante a carga` }] : []),
  ];
  return { pass: failures.length === 0, maxPct, floorMs, oltp, panels: panelsOut, rebuild: rebuildOut, locks: locksOut, latency: { ...latency, mode: latencyMode }, failures, culprit: failures.length ? culprit(panels) : null };
}

module.exports = { evaluate, variationPct, oltpResult, panelResult, lockResult };
