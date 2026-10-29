'use strict';

/**
 * M9-D685 (3.1, bloco 4) — "Onde há dinheiro parado ou perdido". A fórmula é a do parâmetro `analytics.centro.dinheiro_parado_componentes` (padrão conservador):
 * PARADO = recebíveis vencidos + medições pendentes de aprovação + comissão confirmada ainda não recebida; PERDIDO = perdas de estoque + desperdício + custo de pós-obra.
 * Os dois totais saem SEPARADOS, cada um com a lista dos componentes e a natureza do valor (nunca um total único). Repasses a proprietários vencidos são dinheiro de
 * terceiros: ficam à parte, listados e destacados, e NUNCA entram na soma (BI-005). Soma em decimal exato (M9-D605); o Front só exibe. Cada item vale só para quem lê TODOS os domínios dos componentes (`domains`): total parcial nunca é mostrado.
 */
const money = require('../../metrics/formulas/money');
const { natureLabel } = require('../../metrics/registry.natures');
const { dimensionNature } = require('../../metrics/dimensionNature');
const { formatValue } = require('../dashboard.format');
const { COMPONENTS } = require('../../centroSettings');
const { dim } = require('./command.read');
const { makeItem } = require('./command.item');

const BRL = (text) => formatValue('BRL', text);

function componentOf(code, src) {
  const spec = COMPONENTS[code];
  const raw = spec.dimension ? dim(src, spec.dimension) : src.value;
  if (raw === null || raw === undefined) return null;
  const amount = money.money(raw);
  const nature = dimensionNature(code, spec.dimension, src.valueNature);
  const component = { metricCode: code, domain: src.domain, label: spec.label, amount, formatted: BRL(amount), valueNature: nature, valueNatureLabel: natureLabel(nature), apart: spec.apart === true, freshness: src.freshness };
  if (code === 'fin.owner_repasses_pending') { // M9-D623: o repasse parado além do prazo de alerta é destacado, sem alerta próprio e sem tornar o indicador DEGRADED
    const overdueCount = dim(src, 'vencidos_alerta_qtd');
    component.highlight = money.cmp(amount, 0) > 0;
    component.overdueCount = overdueCount === null ? null : Number(overdueCount);
    component.totalPending = src.value;
    component.totalPendingFormatted = BRL(src.value);
  }
  return component;
}

function groupItem(type, key, title, components, base) {
  const sum = money.money(money.sum(components.map((c) => c.amount)));
  return makeItem({
    type, idSuffix: key, title, detail: `${components.length} ${components.length === 1 ? 'componente' : 'componentes'}: ${components.map((c) => `${c.label} ${c.formatted}`).join('; ')}.`,
    severity: money.cmp(sum, 0) > 0 ? 'WARNING' : 'INFO', domain: base.domain, metricCode: components[0] ? components[0].metricCode : null, value: sum, formatted: BRL(sum), unit: 'BRL', rank: base.rank, sortValue: Number(sum),
    extra: { group: key, components, domains: [...new Set(components.map((c) => c.domain))], source: { metricCode: components[0] ? components[0].metricCode : null, metricCodes: components.map((c) => c.metricCode) } },
  });
}

/** Devolve { items, totals }: o item PARADO, o item PERDIDO e, se houver, o item de terceiros (à parte), mais o resumo `totals` separado por natureza do dinheiro. */
async function buildDinheiro(env) {
  const byGroup = { PARADO: [], PERDIDO: [], TERCEIROS: [] };
  for (const { code, group, apart } of env.params.components) {
    const src = env.sources.get(code);
    if (!src || !src.ok) continue;
    const component = componentOf(code, src);
    if (!component) continue;
    if (apart || component.apart) byGroup.TERCEIROS.push({ ...component, group });
    else byGroup[group].push({ ...component, group });
  }
  const domainOf = (list) => (list[0] ? env.sources.get(list[0].metricCode).domain : 'GENERAL');
  const items = [];
  const totals = {};
  for (const [group, key, title, rank] of [['PARADO', 'PARADO', 'Dinheiro parado', 0], ['PERDIDO', 'PERDIDO', 'Dinheiro perdido', 1], ['TERCEIROS', 'TERCEIROS', 'Repasses a proprietários vencidos (dinheiro de terceiros, à parte)', 2]]) {
    const list = byGroup[group];
    if (!list.length) continue;
    const item = groupItem(group === 'PARADO' ? 'DINHEIRO_PARADO' : group === 'PERDIDO' ? 'DINHEIRO_PERDIDO' : 'DINHEIRO_TERCEIROS', key, title, list, { domain: domainOf(list), rank });
    if (group === 'TERCEIROS') { item.severity = list.some((c) => c.highlight) ? 'WARNING' : 'INFO'; item.highlight = list.some((c) => c.highlight); item.detail = `${item.detail} Nunca somado ao dinheiro parado.`; }
    items.push(item);
    totals[group.toLowerCase()] = { amount: item.value, formatted: item.formatted, components: list, separate: true };
  }
  return { items, totals };
}

module.exports = { buildDinheiro };
