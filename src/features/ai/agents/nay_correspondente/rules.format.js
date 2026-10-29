'use strict';

const { STATUS_LABEL } = require('../../../correspondent/correspondentNay.service');

/** Formatação em português dos resultados de regra da NAY Correspondente: só reescreve o que as leituras devolveram, sem calcular nada novo. */
const TZ = 'America/Sao_Paulo';

const nbsp = (text) => text.replace(/[\u00a0\u202f]/g, ' '); // o Intl usa espaço inseparável; na resposta vai espaço comum
const money = (value) => nbsp(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value)));
const percent = (value) => `${nbsp(new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value)))}%`;
const dateOf = (iso) => (iso ? nbsp(new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ })) : 'sem data');
const dateTimeOf = (iso) => (iso ? nbsp(new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })) : 'sem data');
const statusLabel = (code) => STATUS_LABEL[code] || code;
const plural = (n, one, many) => (n === 1 ? one : many);

const sourceLine = (label, ref, asOf) => `Fonte: ${label} (${ref}), consultado em ${dateTimeOf(asOf)}.`;

function formatStalled(r) {
  const head = r.total === 0
    ? `Nenhum caso parado há ${r.thresholdDays} ${plural(r.thresholdDays, 'dia', 'dias')} ou mais.`
    : `${r.total} ${plural(r.total, 'caso parado', 'casos parados')} há ${r.thresholdDays} ${plural(r.thresholdDays, 'dia', 'dias')} ou mais${r.truncated ? ` (listando os ${r.items.length} mais antigos)` : ''}.`;
  const lines = r.items.map((c, i) => `${i + 1}. Caso ${c.financingCaseId} (${statusLabel(c.status)}): parado há ${c.idleDays} ${plural(c.idleDays, 'dia', 'dias')}. ${c.reason}`);
  return [head, ...lines, sourceLine('casos de financiamento', r.source, r.asOf)].join('\n');
}

function formatPending(r) {
  const head = r.total === 0
    ? `O caso ${r.financingCaseId} (${statusLabel(r.caseStatus)}) não tem exigência aberta.`
    : `O caso ${r.financingCaseId} (${statusLabel(r.caseStatus)}) tem ${r.total} ${plural(r.total, 'exigência aberta', 'exigências abertas')}, ${r.requiredOpen} ${plural(r.requiredOpen, 'obrigatória', 'obrigatórias')}.`;
  const lines = r.items.map((it, i) => `${i + 1}. ${it.documentLabel}: ${it.statusLabel}${it.required ? ' (obrigatório)' : ' (opcional)'}, atualizado em ${dateOf(it.updatedAt)}.`);
  return [head, ...lines, sourceLine('exigências do caso', r.source, r.asOf)].join('\n');
}

function formatSimulations(r) {
  if (r.total === 0) return [`O caso ${r.financingCaseId} não tem simulação registrada.`, sourceLine('simulações do caso', r.source, r.asOf)].join('\n');
  const lines = r.simulations.map((s, i) => {
    const rate = s.rateInformed ? `taxa informada ${percent(s.rate)}` : 'taxa não informada';
    return `${i + 1}. ${s.providerCode}: ${money(s.amount)} em ${s.termMonths} meses, parcela ${money(s.monthlyPayment)}, custo total ${money(s.totalCost)}, ${rate}, registrada em ${dateOf(s.createdAt)}.`;
  });
  const note = 'Comparação objetiva de simulações já registradas; não indica aprovação, taxa ou prazo futuros.';
  return [`${r.total} ${plural(r.total, 'simulação registrada', 'simulações registradas')} no caso ${r.financingCaseId}${r.truncated ? ` (listando ${r.simulations.length})` : ''}.`, ...lines, note, sourceLine('simulações do caso', r.source, r.asOf)].join('\n');
}

function formatStatus(r) {
  const line = `O caso ${r.id} está em "${statusLabel(r.status)}", com ${r.applicantsCount} ${plural(r.applicantsCount, 'proponente', 'proponentes')}; última atualização em ${dateTimeOf(r.updatedAt)}.`;
  return [line, sourceLine('caso de financiamento', r.source, r.asOf)].join('\n');
}

module.exports = { formatStalled, formatPending, formatSimulations, formatStatus };
