'use strict';

// M9-D035 — "saúde da empresa": uma linha por área, com os números do read model ({{num:ref}}, escritos pelo servidor) e a fonte da área.
// Área sem permissão entra como "<Área>: sem acesso." e não é lida. Só agregados.
const { EXTRACTORS } = require('./diretoria.numbers');
const { itemsFromReport } = require('../../tools/numbers/financeNumbers');

const LINES = Object.freeze({
  finance: () => 'Financeiro: a receber {{num:a_receber_valor}}, a pagar {{num:a_pagar_valor}}, saldo líquido projetado {{num:saldo_projetado}} e total vencido {{num:vencido_total}}.',
  crm: () => 'Comercial: {{num:funil_abertas}} oportunidades em aberto, com {{num:funil_valor}} de valor esperado.',
  construction: () => 'Obras: {{num:obras_ativas}} em execução, {{num:obras_atrasadas}} com prazo vencido e avanço físico médio de {{num:obras_avanco_fisico}}.',
  legal: (o) => `Jurídico: ${o.bands.map((_, i) => `{{num:contratos_f${i + 1}_qtd}} contratos vencem em até {{num:contratos_f${i + 1}_dias}} ({{num:contratos_f${i + 1}_valor}})`).join(', ')}.`,
  correspondent: () => 'Correspondente: {{num:casos_parados_total}} casos de financiamento parados.',
  inventory: () => 'Estoque: {{num:estoque_em_risco}} itens em risco, dos quais {{num:estoque_ruptura}} com risco de ruptura.',
});

const SOURCE_TITLE = Object.freeze({
  finance: 'Saúde financeira da semana', crm: 'Funil comercial', construction: 'Carteira de obras', legal: 'Contratos a vencer', correspondent: 'Casos de financiamento parados', inventory: 'Estoque em risco',
});

/** Itens do payload de uma área lida (as mesmas funções que o modelo usaria, por tool). */
function itemsOf(area) {
  if (area.topic === 'finance') return itemsFromReport(area.output);
  return EXTRACTORS[area.tool](area.output);
}

const sourceOf = (area, text, asOf) => {
  const ref = area.output.source || 'finance.getWeeklyHealthReport';
  return { sourceType: 'READ_MODEL', sourceRef: ref, title: SOURCE_TITLE[area.topic], text: `Read model: ${ref}\n${text}`, retrievedAt: asOf };
};

function healthBlocks(areas) {
  const lines = [];
  const payload = [];
  const sources = [];
  for (const area of areas) {
    if (area.denied) { lines.push(`${area.label}: sem acesso.`); continue; }
    lines.push(`- ${LINES[area.topic](area.output)}`);
    const items = itemsOf(area);
    payload.push(...items);
    sources.push(sourceOf(area, items.map((i) => `${i.label}: ${i.value}`).join('\n'), items.length ? items[0].asOf : undefined));
  }
  return { lines, payload, sources };
}

module.exports = { healthBlocks, itemsOf, sourceOf };
