'use strict';

// M9-D037 — resolvedores RULE da NAY Obras (caminho sem modelo do ModelRouter, D012): listagem e cálculo saem do serviço do Marco 6
// (nayObras/projectHealth), o servidor escreve os números ({{num:ref}}) e a resposta leva fonte e carimbo de tempo.
const AppError = require('../../../../utils/AppError');
const { getSetting } = require('../../../settings/settings.service');
const { extractEntities } = require('../../orchestrator/numbers/textEntities');
const { OBRAS_SETTING_DEFAULTS: D } = require('./obras.settings');
const { delayedProjects, budgetVsActual } = require('./obras.data');
const { tag } = require('./obras.numbers');
const { CODE } = require('./obras.policy');

const PERMISSION = 'construction:read';
const DENIED = 'Você não tem permissão para consultar estes dados.';

const isMine = (ruleInput) => String(ruleInput.agentCode || '').toUpperCase() === CODE;

function assertCan(ruleInput) {
  if (!Array.isArray(ruleInput.permissions) || !ruleInput.permissions.includes(PERMISSION)) throw new AppError(DENIED, 403, 'AI_PERMISSION_DENIED', { permission: PERMISSION });
}

const money = (projectId, name, label, value, unit, source, asOf) => ({ ref: `obra_${tag(projectId)}_${name}`, label, value: String(value), unit, source, asOf });

/** Os números que aparecem num texto livre do diário ou no nome da obra viram itens do payload (a origem é o registro citado). */
function numbersOfFreeText(text, prefix, source, asOf) {
  return extractEntities(text).filter((e) => e.kind === 'n').map((e, i) => ({
    ref: `${prefix}_txt${i}`, label: 'Número citado no registro', value: String(e.key), unit: ['BRL', '%'].includes(e.unit) ? e.unit : 'un', source, asOf,
  }));
}

function projectBlock(p) {
  const t = tag(p.projectId);
  const src = 'construction.projects';
  const p1 = (n, l, v, u) => money(p.projectId, n, l, v, u, src, p.asOf);
  const payload = [
    p1('atraso_dias', 'Atraso', p.delayDays, 'dias'), p1('orcado', 'Orçado', p.budgeted, 'BRL'), p1('realizado', 'Realizado', p.actual, 'BRL'),
    p1('desvio', 'Desvio de custo', p.deviation, 'BRL'),
    ...(p.deviationPct === null ? [] : [p1('desvio_pct', 'Desvio de custo sobre o orçado', p.deviationPct, '%')]),
    ...numbersOfFreeText(p.cause.text, `obra_${t}_causa`, 'construction.daily_reports', p.asOf),
    ...numbersOfFreeText(`${p.name || ''} ${p.code || ''}`, `obra_${t}_nome`, src, p.asOf),
  ];
  const pct = p.deviationPct === null ? '' : ` ({{num:obra_${t}_desvio_pct}})`;
  const line = `- ${p.name || 'Obra'} (${p.code || p.projectId}): atraso de {{num:obra_${t}_atraso_dias}} dias; causa registrada no diário: ${p.cause.text}; `
    + `orçado {{num:obra_${t}_orcado}}, realizado {{num:obra_${t}_realizado}}, desvio {{num:obra_${t}_desvio}}${pct}.`;
  const source = {
    sourceType: 'READ_MODEL', sourceRef: `construction.projects:${p.projectId}`, title: `Obra ${p.name || p.code || p.projectId}`, retrievedAt: p.asOf,
    text: `${p.name || ''} ${p.code || ''} ${p.cause.text} atraso ${p.delayDays} dias orçado ${p.budgeted} realizado ${p.actual} desvio ${p.deviation}`.trim(),
  };
  return { payload, line, source };
}

/** "Quais obras estão atrasadas e por quê?": por obra, atraso em dias, causa do diário e custo acumulado x orçado. */
async function listarObrasAtrasadas(ruleInput, { tenant, transaction }) {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput);
  const max = Number(await getSetting('ia.nay_obras.max_itens_lista', tenant, transaction, D['ia.nay_obras.max_itens_lista'])) || D['ia.nay_obras.max_itens_lista'];
  const result = await delayedProjects(transaction, { max });
  const asOf = result.asOf;
  const totalItem = { ref: 'obras_atrasadas_total', label: 'Obras atrasadas', value: String(result.total), unit: 'un', source: 'construction.projects', asOf };
  if (!result.total) {
    return { answer: 'Nenhuma obra está com o prazo planejado vencido: {{num:obras_atrasadas_total}} obras atrasadas.', numbersPayload: [totalItem], snapshotAt: asOf, sources: [{ sourceType: 'READ_MODEL', sourceRef: 'construction.projects', title: 'Obras em andamento', text: 'Obras atrasadas 0', retrievedAt: asOf }] };
  }
  const blocks = result.items.map(projectBlock);
  const shown = { ...totalItem, ref: 'obras_atrasadas_exibidas', label: 'Obras listadas', value: String(result.items.length) };
  const head = `Obras atrasadas: {{num:obras_atrasadas_total}}; abaixo, {{num:obras_atrasadas_exibidas}} da mais para a menos atrasada.`;
  return {
    answer: [head, ...blocks.map((b) => b.line)].join('\n'),
    numbersPayload: [totalItem, shown, ...blocks.flatMap((b) => b.payload)],
    sources: blocks.map((b) => b.source),
    snapshotAt: asOf,
  };
}

/** Cálculo do desvio de custo de uma obra (a obra vem do `subject` do pedido): sempre por regra, nunca pelo modelo. */
async function calcularDesvioCustoObra(ruleInput, { transaction }) {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput);
  const subject = ruleInput.subject;
  if (!subject || subject.type !== 'constructionProject' || !subject.id) return null; // sem a obra: 422 AI_RULE_UNRESOLVED
  const c = await budgetVsActual(subject.id, transaction);
  const t = tag(subject.id);
  const src = 'construction.getBudgetVsActual';
  const payload = [
    money(subject.id, 'orcado', 'Orçado', c.budgeted, 'BRL', src, c.asOf), money(subject.id, 'realizado', 'Realizado', c.actual, 'BRL', src, c.asOf),
    money(subject.id, 'desvio', 'Desvio de custo', c.deviation, 'BRL', src, c.asOf),
    ...(c.deviationPct === null ? [] : [money(subject.id, 'desvio_pct', 'Desvio de custo sobre o orçado', c.deviationPct, '%', src, c.asOf)]),
    ...numbersOfFreeText(`${c.name || ''} ${c.code || ''}`, `obra_${t}_nome`, 'construction.projects', c.asOf),
  ];
  const pct = c.deviationPct === null ? '' : ` ({{num:obra_${t}_desvio_pct}})`;
  return {
    answer: `${c.name || 'Obra'} (${c.code || c.projectId}): orçado {{num:obra_${t}_orcado}}, realizado {{num:obra_${t}_realizado}}, desvio de custo {{num:obra_${t}_desvio}}${pct}.`,
    numbersPayload: payload,
    sources: [{ sourceType: 'READ_MODEL', sourceRef: `construction.projects:${c.projectId}`, title: `Custos da obra ${c.name || c.code || c.projectId}`, retrievedAt: c.asOf, text: `${c.name || ''} ${c.code || ''} orçado ${c.budgeted} realizado ${c.actual} desvio ${c.deviation}`.trim() }],
    snapshotAt: c.asOf,
  };
}

const RESOLVERS = Object.freeze({ listar_obras_atrasadas: listarObrasAtrasadas, calcular_desvio_custo_obra: calcularDesvioCustoObra });

module.exports = { RESOLVERS, listarObrasAtrasadas, calcularDesvioCustoObra, numbersOfFreeText };
