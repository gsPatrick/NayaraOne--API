'use strict';

// M9-D036 — resolvedores RULE da NAY Financeira (caminho sem modelo do ModelRouter, D012): fluxo da semana, inadimplência, anomalias e
// projeção. Os números saem do Financeiro (as mesmas definições de tool de leitura), o servidor os escreve ({{num:ref}}) e a resposta leva a
// fonte e o carimbo de tempo. O modelo, quando entra, só redige a explicação. Nenhuma ação é executada: só leitura.
const { permissionDenied } = require('../../orchestrator/toolSecurity.errors');
const { readToolOutput, servicesFor } = require('../kit/readTool');
const { itemsFromReport, itemsFromDelinquency } = require('../../tools/numbers/financeNumbers');
const { cashflowItems, anomalyItems, tag } = require('./financeira.numbers');
const { CODE, DATA_SCOPES } = require('./financeira.policy');

const isMine = (ruleInput) => Boolean(ruleInput) && String(ruleInput.agentCode || '').toUpperCase() === CODE;
const latest = (items) => items.map((i) => i.asOf).filter(Boolean).sort().pop();
const only = (items, refs) => items.filter((i) => refs.includes(i.ref));

/** Lê a tool com a permissão do ator; sem permissão é 403 AI_PERMISSION_DENIED (o run termina BLOCKED, como na conversa com ferramentas). */
async function read(toolName, ruleInput, env) {
  const services = servicesFor({ ruleInput, tenant: env.tenant, transaction: env.transaction, dataScopes: DATA_SCOPES });
  const r = await readToolOutput({ toolName, ruleInput, tenant: env.tenant, transaction: env.transaction, services });
  if (r.denied) throw permissionDenied();
  return r.output;
}

const sourceOf = (ref, title, items) => ({ sourceType: 'READ_MODEL', sourceRef: ref, title, text: items.map((i) => `${i.label}: ${i.value}`).join('\n'), retrievedAt: latest(items) });

async function fluxoDaSemana(ruleInput, env) {
  if (!isMine(ruleInput)) return null;
  const items = only(itemsFromReport(await read('finance.getWeeklyHealth', ruleInput, env)), ['receber_7d', 'pagar_7d', 'saldo_projetado', 'a_receber_valor', 'a_pagar_valor']);
  const answer = 'Fluxo da semana (valores PREVISTOS, de lançamentos pendentes): a receber {{num:receber_7d}} e a pagar {{num:pagar_7d}} nos próximos dias; '
    + 'no total pendente, a receber {{num:a_receber_valor}} e a pagar {{num:a_pagar_valor}}, com saldo líquido projetado de {{num:saldo_projetado}}.';
  return { answer, numbersPayload: items, sources: [sourceOf(items[0].source, 'Saúde financeira da semana', items)], snapshotAt: latest(items) };
}

async function inadimplencia(ruleInput, env) {
  if (!isMine(ruleInput)) return null;
  const items = itemsFromDelinquency(await read('finance.getDelinquency', ruleInput, env));
  const answer = 'Inadimplência (valores REALIZADOS, a receber vencido): {{num:inadimplencia_parcelas}} parcelas em atraso, somando {{num:inadimplencia_valor}}'
    + `${items.some((i) => i.ref === 'inadimplencia_percentual') ? ', o que é {{num:inadimplencia_percentual}} do total elegível' : ''}. Esta resposta só informa: não cobra nem negocia.`;
  return { answer, numbersPayload: items, sources: [sourceOf(items[0].source, 'Inadimplência', items)], snapshotAt: latest(items) };
}

const RISK_LABEL = { LOW: 'baixo', MEDIUM: 'médio', HIGH: 'alto', CRITICAL: 'crítico' };

async function anomalias(ruleInput, env) {
  if (!isMine(ruleInput)) return null;
  const out = await read('finance.getAnomalies', ruleInput, env);
  const items = anomalyItems(out);
  const cases = out.items.map((c) => `- Risco ${RISK_LABEL[String(c.riskLevel).toUpperCase()] || c.riskLevel} (${c.caseType}): ${c.reason}`);
  const answer = ['Anomalias financeiras abertas: {{num:anomalias_abertas}}.', ...cases,
    'Limiar da regra FIN-005 em vigor: pagamento acima de {{num:fin005_multiplicador}} vezes o histórico do favorecido, ou acima de {{num:fin005_conta_nova}} para conta nova, e resfriamento de {{num:fin005_resfriamento}} horas.'].join('\n');
  const src = sourceOf('finance.anomaly_cases', 'Anomalias financeiras abertas', items);
  return { answer, numbersPayload: items, sources: [{ ...src, text: `${src.text}\n${out.items.map((c) => c.reason).join('\n')}` }], snapshotAt: latest(items) };
}

const NATURE_TEXT = { REALIZADO: 'REALIZADO (já aconteceu)', PREVISTO: 'PREVISTO (lançamentos pendentes por vencimento)', ESTIMADO: 'ESTIMADO (estimativa do relatório)' };

async function projecao(ruleInput, env) {
  if (!isMine(ruleInput)) return null;
  const out = await read('finance.getCashflowProjection', ruleInput, env);
  const items = cashflowItems(out);
  const lines = ['REALIZADO', 'PREVISTO', 'ESTIMADO'].map((nature) => {
    const parts = out.items.filter((i) => i.nature === nature).map((i) => `${i.label} {{num:fluxo_${i.indicator}}}`);
    return parts.length ? `- ${NATURE_TEXT[nature]}: ${parts.join('; ')}.` : null;
  }).filter(Boolean);
  return { answer: ['Projeção de fluxo de caixa, cada valor rotulado:', ...lines].join('\n'), numbersPayload: items, sources: [sourceOf(out.source, 'Projeção de fluxo de caixa', items)], snapshotAt: latest(items) };
}

const RESOLVERS = Object.freeze({
  financeira_fluxo: fluxoDaSemana, financeira_inadimplencia: inadimplencia, financeira_anomalias: anomalias, financeira_projecao: projecao,
});

module.exports = { RESOLVERS, tag };
