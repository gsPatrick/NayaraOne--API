'use strict';

/**
 * M9-D693 (3.4 e 3.5) — o que entra no briefing e em que ordem, decidido pelo SERVIDOR (a NAY só escreve o texto). Prioridade: (1) alertas
 * CRITICAL abertos; (2) métricas em VERMELHO pelo semáforo do painel (`config.trafficLight.red` do widget); (2,5) qualidade do dado, que vem
 * antes de qualquer conclusão sobre variação; (3) maiores variações relevantes desfavoráveis ou de sentido desconhecido; (4) alertas WARNING;
 * (5) destaques positivos (variação favorável e alerta resolvido no período). Métrica normal não entra. Um item por métrica (o de melhor
 * prioridade, levando os demais motivos). Métrica com dado degradado ou velho nunca leva número: só o aviso de qualidade da sua área.
 */
const { compareThreshold } = require('../alerts');
const { has, domainPermissionOf } = require('../security');
const { qualityAttentionItem } = require('../quality/status.block');
const { areaOf } = require('./brief.areas');

const TIER = Object.freeze({ CRITICAL: 1, RED: 2, QUALITY: 2.5, VARIATION: 3, WARNING: 4, HIGHLIGHT: 5 });

/** Variação relevante? Percentual nulo (anterior zero) com valor atual diferente de zero também é relevante. */
function isRelevant(variation, relevantPct) {
  if (!variation || Number(variation.absolute) === 0) return false;
  return variation.percent === null ? true : Math.abs(Number(variation.percent)) >= relevantPct;
}

/** 'FAVORAVEL' | 'DESFAVORAVEL' | 'DESCONHECIDA' conforme a polaridade configurada da métrica. */
function directionOf(variation, polarity) {
  if (!polarity) return 'DESCONHECIDA';
  const up = Number(variation.absolute) > 0;
  return (polarity === 'alta') === up ? 'FAVORAVEL' : 'DESFAVORAVEL';
}

function redLight(fact) {
  const red = fact.trafficLight && fact.trafficLight.red;
  if (!red || fact.quality || fact.current.value === null) return false;
  try { return compareThreshold(fact.current.value, red.operator, red.value); } catch (err) { return false; }
}

function newEntry(code, fact) {
  return { metricCode: code, fact, tier: Infinity, tipo: 'DESTAQUE', reasons: [], alerts: [], sortKey: 0 };
}

function addReason(entries, code, fact, { tier, tipo, reason, sortKey = 0 }) {
  const entry = entries.get(code) || newEntry(code, fact);
  entries.set(code, entry);
  entry.reasons.push(reason);
  if (tier < entry.tier) { entry.tier = tier; entry.sortKey = sortKey; }
  if (tipo === 'EXCECAO') entry.tipo = 'EXCECAO';
  return entry;
}

function alertReasons(entries, alerts, factsByCode, domainVisible) {
  for (const a of alerts) {
    if (a.domain && !domainVisible(a.domain)) continue;
    const fact = factsByCode.get(a.metricCode) || null;
    const open = a.status !== 'RESOLVED';
    const tier = !open ? TIER.HIGHLIGHT : a.severity === 'CRITICAL' ? TIER.CRITICAL : a.severity === 'WARNING' ? TIER.WARNING : null;
    if (tier === null) continue;
    const entry = addReason(entries, a.metricCode, fact, {
      tier, tipo: open ? 'EXCECAO' : 'DESTAQUE', reason: open ? `ALERTA_${a.severity}` : 'ALERTA_RESOLVIDO', sortKey: -new Date(a.openedAt).getTime(),
    });
    entry.alerts.push(a);
    entry.fact = entry.fact || fact;
  }
}

function factReasons(entries, facts, params) {
  for (const fact of facts) {
    if (fact.quality) continue;
    if (redLight(fact)) addReason(entries, fact.metricCode, fact, { tier: TIER.RED, tipo: 'EXCECAO', reason: 'SEMAFORO_VERMELHO' });
    if (!isRelevant(fact.variation, params.relevantPct)) continue;
    const favorable = directionOf(fact.variation, fact.polarity) === 'FAVORAVEL';
    const weight = fact.variation.percent === null ? Infinity : Math.abs(Number(fact.variation.percent));
    addReason(entries, fact.metricCode, fact, {
      tier: favorable ? TIER.HIGHLIGHT : TIER.VARIATION, tipo: favorable ? 'DESTAQUE' : 'EXCECAO', reason: favorable ? 'VARIACAO_FAVORAVEL' : 'VARIACAO_RELEVANTE', sortKey: -weight,
    });
  }
}

/** Um item ATENCAO_QUALIDADE por área adiada (texto do `qualityAttentionItem` da M9-D697, sem número). Sem indicador com registro na área não há fonte para citar: fica só no resumo. */
function qualityCandidates(facts, gates) {
  const out = [];
  for (const [domain, gate] of gates) {
    const inArea = facts.filter((f) => f.domain === domain);
    if (!inArea.length) continue;
    const bad = inArea.filter((f) => f.quality && f.quality !== 'AREA_ADIADA');
    const area = areaOf(domain);
    const item = qualityAttentionItem({ area, gate });
    out.push({
      kind: 'QUALIDADE', tier: TIER.QUALITY, tipo: 'ATENCAO_QUALIDADE', area, domains: [domain], sortKey: 0, metricCodes: item.metricCodes,
      reasons: [...new Set(gate.reasons.map((r) => r.problem))], fonte: (bad.length ? bad : inArea).map((f) => f.source), fato: item.fato,
    });
  }
  return out;
}

function toCandidate(entry, sources) {
  const fact = entry.fact;
  const source = fact ? fact.source : sources.get(entry.metricCode) || null;
  const domain = fact ? fact.domain : (entry.alerts[0] && entry.alerts[0].domain) || null;
  return {
    kind: 'METRICA', tier: entry.tier, tipo: entry.tipo, area: fact ? fact.area : areaOf(domain), domains: domain ? [domain] : [], sortKey: entry.sortKey,
    metricCode: entry.metricCode, reasons: entry.reasons, alerts: entry.alerts, fact, fonte: source ? [source] : [],
  };
}

/**
 * @returns {{ selected: object[], dropped: object[], hasException: boolean, droppedException: boolean }}
 * `sources`: Map(metricCode -> fonte) das métricas de alerta sem registro na data-base do período.
 */
function buildCandidates({ ctx, facts, alerts, params, briefType, gates = new Map(), sources = new Map() }) {
  const entries = new Map();
  const factsByCode = new Map(facts.map((f) => [f.metricCode, f]));
  const domainVisible = (domain) => has(ctx, domainPermissionOf(ctx.domainMap, domain));
  alertReasons(entries, alerts, factsByCode, domainVisible);
  factReasons(entries, facts, params);
  const ordered = [...[...entries.values()].map((e) => toCandidate(e, sources)), ...qualityCandidates(facts, gates)]
    .sort((a, b) => a.tier - b.tier || a.sortKey - b.sortKey || String(a.metricCode || a.area).localeCompare(String(b.metricCode || b.area)));
  const max = params.maxItems[briefType];
  const selected = ordered.slice(0, max).map((c, i) => ({ ...c, refId: `i${i + 1}` }));
  const dropped = ordered.slice(max);
  const isException = (c) => c.tipo !== 'DESTAQUE';
  return { selected, dropped, hasException: selected.some(isException), droppedException: dropped.some(isException) };
}

module.exports = { buildCandidates, TIER, isRelevant, directionOf };
