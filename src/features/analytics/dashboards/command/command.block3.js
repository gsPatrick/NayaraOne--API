'use strict';

/**
 * M9-D685 (3.1, bloco 3) — "Onde há risco": alertas OPEN por severidade (M9-D691), anomalias financeiras de risco alto (`fin.anomalies_open`), processos de risco
 * alto ou crítico (`legal.cases_by_risk`), garantias vencidas (`rent.guarantees_expiring`), obras com margem projetada abaixo de `analytics.centro.margem_minima_pct`
 * (`obra.projected_margin`) e integrações fora do SLO (`tec.integration_errors`). Ordem: severidade e, no empate, o que tem mais ocorrências.
 */
const money = require('../../metrics/formulas/money');
const { formatValue } = require('../dashboard.format');
const { formatValue: formatAlertValue } = require('../../alerts/list.format');
const { dim, isPositive } = require('./command.read');
const { makeItem, humanize } = require('./command.item');

const HIGH_RISK_LEVELS = Object.freeze(['CRITICAL', 'HIGH']); // o nível de risco do processo jurídico (LegalCase.riskLevel)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const count = (src, key) => (isPositive(dim(src, key)) ? Number(dim(src, key)) : 0);

function alertItems(env) {
  return env.alerts.filter((a) => a.status === 'OPEN').map((a) => {
    const value = formatAlertValue(a.lastValue, a.unit);
    return makeItem({
      type: 'ALERTA_ABERTO', alert: { id: a.id, code: a.alertCode }, alertMetricCode: a.metricCode, domain: a.domain, severity: a.severity, title: `Alerta aberto: ${humanize(a.alertCode)}`,
      detail: value ? `Último valor: ${value}.` : null, href: env.alertHref(a.id), sortValue: new Date(a.openedAt).getTime() * -1,
    });
  });
}

function metricItems(env) {
  const get = (code) => env.sources.get(code);
  const items = [];
  const anomalies = get('fin.anomalies_open');
  if (anomalies && anomalies.ok && isPositive(dim(anomalies, 'alto'))) {
    const n = Number(dim(anomalies, 'alto'));
    items.push(makeItem({ type: 'ANOMALIA_FINANCEIRA', title: plural(n, 'anomalia financeira de risco alto', 'anomalias financeiras de risco alto'), severity: 'WARNING', domain: anomalies.domain, metricCode: 'fin.anomalies_open', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n }));
  }
  const cases = get('legal.cases_by_risk');
  if (cases && cases.ok) {
    const n = HIGH_RISK_LEVELS.reduce((sum, level) => sum + count(cases, `risco:${level}`), 0);
    if (n > 0) items.push(makeItem({ type: 'PROCESSO_RISCO_ALTO', title: plural(n, 'processo jurídico de risco alto ou crítico', 'processos jurídicos de risco alto ou crítico'), severity: count(cases, 'risco:CRITICAL') > 0 ? 'CRITICAL' : 'WARNING', domain: cases.domain, metricCode: 'legal.cases_by_risk', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n }));
  }
  const guarantees = get('rent.guarantees_expiring');
  if (guarantees && guarantees.ok && isPositive(dim(guarantees, 'vencidas_qtd'))) {
    const n = Number(dim(guarantees, 'vencidas_qtd'));
    items.push(makeItem({ type: 'GARANTIA_VENCIDA', title: plural(n, 'garantia de locação vencida', 'garantias de locação vencidas'), severity: 'WARNING', domain: guarantees.domain, metricCode: 'rent.guarantees_expiring', idSuffix: 'vencidas', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n }));
  }
  const integrations = get('tec.integration_errors');
  if (integrations && integrations.ok && isPositive(dim(integrations, 'acima_do_slo_qtd'))) {
    const n = Number(dim(integrations, 'acima_do_slo_qtd'));
    items.push(makeItem({ type: 'INTEGRACAO_FORA_SLO', title: plural(n, 'integração acima do limite de erro', 'integrações acima do limite de erro'), severity: 'WARNING', domain: integrations.domain, metricCode: 'tec.integration_errors', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n }));
  }
  return items;
}

/** Uma linha por obra cuja margem projetada (%) está abaixo do mínimo configurado; margem negativa é CRITICAL. */
function marginItems(env) {
  const src = env.sources.get('obra.projected_margin');
  if (!src || !src.ok) return [];
  const items = [];
  for (const [key, value] of src.dims) {
    const m = /^obra:([^:]+):margem_pct$/.exec(key);
    if (!m || money.cmp(value, env.params.minMarginPct) >= 0) continue;
    items.push(makeItem({
      type: 'OBRA_MARGEM_BAIXA', idSuffix: m[1], title: `Obra ${m[1].slice(0, 8)}: margem projetada abaixo do mínimo`, severity: money.cmp(value, 0) < 0 ? 'CRITICAL' : 'WARNING', domain: src.domain, metricCode: 'obra.projected_margin',
      detail: `Margem ${formatValue('PERCENT', value)}; mínimo ${formatValue('PERCENT', String(env.params.minMarginPct))}.`, value, formatted: formatValue('PERCENT', value), unit: 'PERCENT', drilldown: true, sortValue: -Number(value),
      extra: { projectId: m[1] },
    }));
  }
  return items;
}

async function buildRisco(env) {
  return [...alertItems(env), ...metricItems(env), ...marginItems(env)];
}

module.exports = { buildRisco, HIGH_RISK_LEVELS };
