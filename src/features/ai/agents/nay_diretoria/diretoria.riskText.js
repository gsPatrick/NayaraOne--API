'use strict';

// M9-D035 — texto dos riscos e das prioridades sugeridas. Prioridade é só texto: nada é criado, executado nem proposto.
const { LABEL } = require('./diretoria.risks');

const cents = (n) => Number(n || 0).toFixed(2);
const mk = (r) => (name, label, value, unit) => ({ ref: `risco_${r.id}_${name}`, label, value: unit === 'BRL' ? cents(value) : String(value), unit, source: r.source, asOf: r.asOf });
const ref = (r, name) => `{{num:risco_${r.id}_${name}}}`;

const SENTENCE = Object.freeze({
  inadimplencia: (r) => `${ref(r, 'itens')} parcelas a receber vencidas, somando ${ref(r, 'valor')}, ${ref(r, 'pct')} do total elegível`,
  contratos: (r) => `${ref(r, 'itens')} contratos vencem em até ${ref(r, 'dias')}, somando ${ref(r, 'valor')}`,
  obras: (r) => `${ref(r, 'itens')} obras com prazo vencido, entre ${ref(r, 'ativas')} em execução`,
  casos: (r) => `${ref(r, 'itens')} casos sem atividade há mais de ${ref(r, 'dias')}`,
  estoque: (r) => `${ref(r, 'itens')} itens em risco alto, dos quais ${ref(r, 'ruptura')} com risco de ruptura`,
});

const EXTRA_ITEMS = Object.freeze({
  inadimplencia: (m, r) => [m('valor', 'Valor vencido', r.value, 'BRL'), m('pct', 'Inadimplência sobre o total elegível', r.pct, '%')],
  contratos: (m, r) => [m('dias', 'Limite da faixa', r.days, 'dias'), m('valor', 'Valor a vencer', r.value, 'BRL')],
  obras: (m, r) => [m('ativas', 'Obras em execução', r.active, 'un')],
  casos: (m, r) => [m('dias', 'Dias sem atividade para ser considerado parado', r.days, 'dias')],
  estoque: (m, r) => [m('ruptura', 'Itens com risco de ruptura', r.stockout, 'un')],
});

/** Itens do payload de um risco. */
function riskItems(r) {
  const m = mk(r);
  return [m('itens', 'Ocorrências', r.count, 'un'), ...EXTRA_ITEMS[r.id](m, r)];
}

const riskLine = (r) => `- Severidade ${LABEL[r.severity].toLowerCase()} | ${r.theme}: ${SENTENCE[r.id](r)}. Fonte: ${r.source}.`;

const priorityLine = (r) => `- Prioridade ${LABEL[r.severity].toLowerCase()}: tratar "${r.theme.toLowerCase()}" (${SENTENCE[r.id](r)}).`;

const NO_RISK = 'Nenhum risco encontrado nas áreas consultadas.';
const PRIORITY_NOTE = 'Estas prioridades são sugestões em texto: nenhuma ação foi executada nem proposta, e a decisão é de quem tem a alçada.';

module.exports = { riskItems, riskLine, priorityLine, NO_RISK, PRIORITY_NOTE };
