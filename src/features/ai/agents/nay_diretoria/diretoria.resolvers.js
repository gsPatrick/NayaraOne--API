'use strict';

// M9-D035 — resolvedores RULE da NAY Diretoria (caminho sem modelo do ModelRouter, D012): saúde da empresa, riscos, prioridades sugeridas e
// explicação de indicador. Os números saem dos read models das áreas, o servidor os escreve ({{num:ref}}) e a resposta leva fonte e carimbo de
// tempo. Nada é criado, executado nem proposto: prioridade é texto.
const { getSetting } = require('../../../settings/settings.service');
const { norm } = require('../scope/scope.evaluate');
const { CODE } = require('./diretoria.policy');
const { DIRETORIA_SETTING_DEFAULTS: D } = require('./diretoria.settings');
const { readAreas } = require('./diretoria.data');
const { buildRisks, PARAM_FIELDS } = require('./diretoria.risks');
const { healthBlocks, itemsOf, sourceOf } = require('./diretoria.health');
const { riskItems, riskLine, priorityLine, NO_RISK, PRIORITY_NOTE } = require('./diretoria.riskText');
const { pickIndicator } = require('./diretoria.indicators');

const isMine = (ruleInput) => Boolean(ruleInput) && String(ruleInput.agentCode || '').toUpperCase() === CODE;
const latest = (items) => items.map((i) => i.asOf).filter(Boolean).sort().pop();

async function readParams(tenant, transaction) {
  const out = {};
  for (const [field, key] of Object.entries(PARAM_FIELDS)) out[field] = Number(await getSetting(key, tenant, transaction, D[key])) || D[key];
  return out;
}

const noAccessLines = (areas) => areas.filter((a) => a.denied).map((a) => `${a.label}: sem acesso.`);

async function saudeDaEmpresa(ruleInput, { tenant, transaction }) {
  if (!isMine(ruleInput)) return null;
  const areas = await readAreas({ ruleInput, tenant, transaction });
  const { lines, payload, sources } = healthBlocks(areas);
  return { answer: ['Saúde da empresa nesta semana:', ...lines].join('\n'), numbersPayload: payload, sources, snapshotAt: latest(payload) };
}

async function risksOf(ruleInput, tenant, transaction) {
  const areas = await readAreas({ ruleInput, tenant, transaction });
  const risks = buildRisks(areas, await readParams(tenant, transaction));
  const payload = risks.flatMap(riskItems);
  const sources = risks.map((r) => ({ sourceType: 'READ_MODEL', sourceRef: r.source, title: r.theme, text: `Read model: ${r.source}\n${riskItems(r).map((i) => `${i.label}: ${i.value}`).join('\n')}`, retrievedAt: r.asOf }));
  return { areas, risks, payload, sources };
}

async function listarRiscos(ruleInput, { tenant, transaction }) {
  if (!isMine(ruleInput)) return null;
  const { areas, risks, payload, sources } = await risksOf(ruleInput, tenant, transaction);
  const lines = risks.length ? risks.map(riskLine) : [NO_RISK];
  return { answer: ['Riscos por severidade:', ...lines, ...noAccessLines(areas)].join('\n'), numbersPayload: payload, sources, snapshotAt: latest(payload) };
}

async function sugerirPrioridades(ruleInput, { tenant, transaction }) {
  if (!isMine(ruleInput)) return null;
  const { areas, risks, payload, sources } = await risksOf(ruleInput, tenant, transaction);
  const lines = risks.length ? risks.map(priorityLine) : [NO_RISK];
  return { answer: ['Prioridades sugeridas:', ...lines, ...noAccessLines(areas), PRIORITY_NOTE].join('\n'), numbersPayload: payload, sources, snapshotAt: latest(payload) };
}

function contractValue(area) {
  return area.output.bands.map((_, i) => `{{num:contratos_f${i + 1}_qtd}} contratos até {{num:contratos_f${i + 1}_dias}} ({{num:contratos_f${i + 1}_valor}})`).join('; ');
}

async function explicarIndicador(ruleInput, { tenant, transaction }) {
  if (!isMine(ruleInput)) return null;
  const indicator = pickIndicator(norm(ruleInput.input));
  if (!indicator) return null; // indicador desconhecido: o roteador segue (o modelo recusa ou pede esclarecimento)
  const [area] = await readAreas({ ruleInput, tenant, transaction, only: [indicator.topic] });
  if (area.denied) return { answer: `${area.label}: sem acesso.`, numbersPayload: [], sources: [] };
  const items = itemsOf(area);
  const value = indicator.value || contractValue(area);
  const answer = `${indicator.label}: ${value}. Read model: ${indicator.readModel}. Período: ${indicator.period}. Fórmula: ${indicator.formula}.`;
  const source = sourceOf(area, `${indicator.label}. Período: ${indicator.period}. Fórmula: ${indicator.formula}.`, latest(items));
  return { answer, numbersPayload: items, sources: [{ ...source, sourceRef: indicator.readModel }], snapshotAt: latest(items) };
}

const RESOLVERS = Object.freeze({
  diretoria_saude: saudeDaEmpresa,
  diretoria_riscos: listarRiscos,
  diretoria_prioridades: sugerirPrioridades,
  diretoria_explicar_indicador: explicarIndicador,
});

module.exports = { RESOLVERS };
