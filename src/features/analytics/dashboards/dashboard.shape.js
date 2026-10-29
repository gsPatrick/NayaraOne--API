'use strict';

/**
 * M9-D634 (3.2 e 3.3) — monta o corpo de um widget a partir do que o snapshot gravou (valor principal e linhas de dimensão), seguindo o `config` do
 * widget. Só organiza e formata: barras e funil (`group` + `share` + `extra`), tabela por corretor (`group` + `measures`), fatos do cartão (`facts`),
 * séries de naturezas diferentes lado a lado sem total (`series`) e o alerta do cartão (`alertOn`). Nenhum número é calculado aqui.
 * Chave de dimensão: `grupo:id[:medida]` ou chave solta (`vencidos_qtd`); a unidade de cada medida vem do sufixo da chave (dimensionUnit).
 */
const { dimensionUnit } = require('../metrics/dimensionUnit');
const { natureLabel } = require('../metrics/registry.natures');
const { formatValue } = require('./dashboard.format');
const { sortItems } = require('./dashboard.order');

function parseKey(key) {
  const parts = String(key).split(':');
  if (parts.length === 1) return { group: null, id: null, measure: parts[0] };
  return { group: parts[0], id: parts[1], measure: parts.slice(2).join(':') };
}

/** "VISIT_SCHEDULED" -> "Visit scheduled": rótulo legível do código quando o Front não tem tradução própria. */
function humanize(id) {
  const text = String(id).replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function indexDimensions(dimensions) {
  const flat = new Map();
  const groups = new Map();
  for (const d of dimensions) {
    const { group, id, measure } = parseKey(d.key);
    if (group === null) { flat.set(measure, d); continue; }
    if (!groups.has(group)) groups.set(group, new Map());
    const items = groups.get(group);
    if (!items.has(id)) items.set(id, new Map());
    items.get(id).set(measure, d);
  }
  return { flat, groups };
}

const cell = (metric, key, label, dim) => {
  const unit = dimensionUnit(key, metric.unit);
  return { key, label, unit, value: dim ? dim.value : null, formatted: dim ? formatValue(unit, dim.value) : null };
};

function factsOf(config, metric, flat) {
  return (config.facts || []).filter((f) => flat.has(f.key)).map((f) => cell(metric, f.key, f.label, flat.get(f.key)));
}

function seriesOf(config, metric, flat) {
  return (config.series || []).map((s) => {
    const dim = s.key === '' ? { value: metric.value } : flat.get(s.key);
    const unit = s.key === '' ? metric.unit : dimensionUnit(s.key, metric.unit);
    return { key: s.key, label: s.label, valueNature: s.nature, valueNatureLabel: natureLabel(s.nature), unit, value: dim ? dim.value : null, formatted: dim ? formatValue(unit, dim.value) : null };
  });
}

/** Linhas de um grupo: cada uma com a medida principal (`valueKey`, ou a sem sufixo), a participação (`share`), as medidas extras e as colunas da tabela. */
function rowsOfGroup(config, metric, items) {
  const valueKey = config.valueKey || '';
  return [...items.entries()].map(([id, measures]) => {
    const main = measures.get(valueKey) || null;
    const row = { id, label: humanize(id), value: main ? main.value : null, formatted: main ? formatValue(dimensionUnit(valueKey, metric.unit), main.value) : null };
    if (config.share) row.share = measures.has(config.share) ? cell(metric, config.share, 'Participação', measures.get(config.share)) : null;
    if (config.extra) row.extra = config.extra.filter((x) => measures.has(x.key)).map((x) => cell(metric, x.key, x.label, measures.get(x.key)));
    if (config.measures) row.cells = config.measures.map((m) => cell(metric, m.key, m.label, measures.get(m.key)));
    return row;
  });
}

/**
 * Linhas do widget. Com `group`, uma lista só. Com `groups` ([{ group, label }], M9-D654: ranking por causa, equipe e material; perdas por obra e
 * material), uma lista por grupo, cada uma ordenada pelo seu valor, uma depois da outra; a linha leva `group`, `groupLabel` e o código em `rawId`.
 */
function itemsOf(config, metric, groups, orderList) {
  if (!config.groups) return sortItems(rowsOfGroup(config, metric, groups.get(config.group) || new Map()), config.order, orderList);
  return config.groups.flatMap((spec) => sortItems(rowsOfGroup(config, metric, groups.get(spec.group) || new Map()), config.order, orderList)
    .map((r) => ({ ...r, id: `${spec.group}:${r.id}`, rawId: r.id, group: spec.group, groupLabel: spec.label, label: `${spec.label}: ${r.label}` })));
}

/** `alert` = o cartão está em alerta: o indicador (ou a chave `alertOn`) tem valor maior que zero. Decidido aqui, nunca no Front. */
function alertOf(config, metric, flat) {
  if (!config.alertOn && !config.alert) return false;
  const raw = config.alertOn ? (flat.get(config.alertOn) || {}).value : metric.value;
  return raw !== null && raw !== undefined && Number(raw) > 0;
}

function buildBody(widgetType, config, metric, dimensions, orderList) {
  const { flat, groups } = indexDimensions(dimensions);
  const body = { facts: factsOf(config, metric, flat), series: seriesOf(config, metric, flat), alert: alertOf(config, metric, flat) };
  if (config.group || config.groups) body.items = itemsOf(config, metric, groups, orderList);
  if (config.measures) body.columns = config.measures.map((m) => ({ key: m.key, label: m.label }));
  if (config.chart) body.chart = config.chart;
  if (config.link) body.link = config.link; // tela de lista que o cartão abre (indicador NORMAL não tem detalhe de BI; D712)
  if (config.noTotal) body.noTotal = true; // séries de naturezas diferentes: o cartão não tem total (M9-D610)
  if (config.labelKind) body.labelKind = config.labelKind; // USER: o código da linha é um usuário; o Front mostra o nome que ele conhece
  if (config.highlight && flat.has(config.highlight.key)) body.highlight = cell(metric, config.highlight.key, config.highlight.label, flat.get(config.highlight.key));
  return { widgetType, ...body };
}

module.exports = { buildBody, parseKey, humanize };
