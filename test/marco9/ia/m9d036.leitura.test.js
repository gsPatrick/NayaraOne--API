'use strict';

// M9-D036 — as quatro capacidades do livro ("fluxo, inadimplência, anomalias e projeções") pelo caminho de regra e pela conversa com ferramentas:
// números do read model escritos pelo servidor, fonte e snapshot, limiar da regra FIN-005 e projeção rotulada REALIZADO/PREVISTO/ESTIMADO.
// nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const H = require('../_helpers/iaFinanceira');
const Dados = require('../_helpers/iaNayDados');
const B = require('../_helpers/iaNayBase');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

/** Cenário com dados da empresa; `c.fin` é o relatório semanal lido por fora DEPOIS dos dados, e a diferença para ANTES é exatamente o que o teste criou. */
async function com(tx, opts = {}) {
  const c = await H.cenario(tenantA, tx, opts);
  const antes = await B.financeiro(tx);
  await Dados.criarRecebiveis(tenantA, tx, [{ dias: -10, valor: 1000 }, { dias: -3, valor: 500.5 }, { dias: 5, valor: 2000 }]);
  await Dados.criarPagavel(tenantA, tx, { dias: 3, valor: 321.45 });
  c.fin = await B.financeiro(tx);
  assert.equal(B.round2(c.fin.overdue.receivable.total - antes.overdue.receivable.total), 1500.5);
  assert.equal(c.fin.overdue.receivable.count - antes.overdue.receivable.count, 2);
  assert.equal(B.round2(c.fin.receivablePending.total - antes.receivablePending.total), 3500.5);
  assert.equal(B.round2(c.fin.payablePending.total - antes.payablePending.total), 321.45);
  assert.equal(B.round2(c.fin.dueNextSevenDays.receivable.total - antes.dueNextSevenDays.receivable.total), 2000);
  return c;
}
const regra = async (c, texto, taskType, over = {}) => {
  const res = await H.rodarNay(c, texto, { taskType, ...over });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.routingPath, 'RULE', 'sem modelo');
  assert.equal(res.cost.tokensIn, 0);
  assert.equal(res.groundingStatus, 'GROUNDED');
  assert.ok(res.snapshotAt, 'snapshot');
  assert.ok(res.sources.length >= 1, 'fonte');
  return res;
};

test('m9d036_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const res = await H.rodarNay(c, 'Como está o fluxo de caixa desta semana? [[TOOL:finance.getDelinquency:{}]] [[RESPOSTA:A inadimplência soma {{num:inadimplencia_valor}} em {{num:inadimplencia_parcelas}} parcelas [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.ok(res.answer.includes(`A inadimplência soma ${B.brl(c.fin.overdue.receivable.total)} em ${c.fin.overdue.receivable.count} parcelas`), res.answer);
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.ok(res.snapshotAt && res.sources.length >= 1);
    assert.deepEqual((await H.chamadas(res.runId, tx)).map((l) => [l.tool_name, l.status]), [['finance.getDelinquency', 'SUCCEEDED']]);
    // O modelo não escreve número: valor inventado é barrado pelo auditor de números.
    const falso = await H.rodarNay(c, 'Qual a inadimplência? [[TOOL:finance.getDelinquency:{}]] [[RESPOSTA:A inadimplência soma R$ 9.999,99 [1].]]');
    if (falso.ok) assert.doesNotMatch(falso.answer, /9\.999,99/); else assert.equal(falso.error.code, 'AI_NUMBER_NOT_FROM_SOURCE');
  });
});

test('m9d036_fluxo_semanal_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const res = await regra(c, 'Como está o fluxo desta semana?', 'financeira_fluxo');
    assert.match(res.answer, /Fluxo da semana \(valores PREVISTOS/);
    const f = c.fin;
    assert.ok(res.answer.includes(`a receber ${B.brl(f.dueNextSevenDays.receivable.total)} e a pagar ${B.brl(f.dueNextSevenDays.payable.total)} nos próximos dias`), res.answer);
    assert.ok(res.answer.includes(`no total pendente, a receber ${B.brl(f.receivablePending.total)} e a pagar ${B.brl(f.payablePending.total)}, com saldo líquido projetado de ${B.brl(f.projectedNetBalance)}`), res.answer);
    assert.match(res.sources[0].title, /Saúde financeira da semana/);
  });
});

test('m9d036_inadimplencia_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const antes = await H.fotografia(tx);
    const res = await regra(c, 'Quem está inadimplente e quanto?', 'financeira_inadimplencia');
    assert.ok(res.answer.includes(`${c.fin.overdue.receivable.count} parcelas em atraso, somando ${B.brl(c.fin.overdue.receivable.total)}`), res.answer);
    assert.ok(res.answer.includes(`${B.pct(c.fin.delinquencyRatio)} do total elegível`), res.answer);
    assert.match(res.answer, /só informa: não cobra nem negocia/);
    assert.deepEqual(await H.fotografia(tx), antes, 'leitura pura: nada cobrado, negociado nem alterado');
    assert.deepEqual(await H.chamadas(res.runId, tx), []);
  });
});

test('m9d036_anomalias_com_limiar_fin_005_e_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx, { params: {} });
    const abertas = async () => (await H.q("SELECT count(*)::int AS n FROM finance.anomaly_cases WHERE status = 'OPEN'", {}, tx))[0].n;
    const base = await abertas();
    await Dados.criarAnomalia(tenantA, tx, { risco: 'HIGH', tipo: 'AMOUNT_OUTLIER', motivo: 'Valor fora do padrão do favorecido.' });
    await Dados.criarAnomalia(tenantA, tx, { risco: 'CRITICAL', tipo: 'BENEFICIARY_CHANGED', motivo: 'Conta do favorecido trocada após a aprovação.' });
    const res = await regra(c, 'Quais as anomalias abertas?', 'financeira_anomalias');
    assert.equal(await abertas(), base + 2);
    assert.ok(res.answer.includes(`Anomalias financeiras abertas: ${base + 2}.`), res.answer);
    assert.match(res.answer, /- Risco crítico \(BENEFICIARY_CHANGED\): Conta do favorecido trocada após a aprovação\./);
    assert.match(res.answer, /- Risco alto \(AMOUNT_OUTLIER\): Valor fora do padrão do favorecido\./);
    // Limiar da regra FIN-005 em vigor (padrão da DEC-007: 3 vezes o histórico, R$ 5.000,00 para conta nova — antes 10.000 —, 48 horas de resfriamento).
    assert.match(res.answer, /FIN-005.*acima de 3 vezes o histórico.*acima de R\$ 5\.000,00 para conta nova.*resfriamento de 48 horas/);
    assert.match(res.sources[0].title, /Anomalias financeiras abertas/);
    // O limiar vem do parâmetro da empresa (finance.antifraud_*), não do código.
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx, { params: { 'ia.financeira.anomalias_max_itens': 1 } });
    const base = (await H.q("SELECT count(*)::int AS n FROM finance.anomaly_cases WHERE status = 'OPEN'", {}, tx))[0].n;
    await Dados.criarAnomalia(tenantA, tx, { risco: 'HIGH' });
    await Dados.criarAnomalia(tenantA, tx, { risco: 'MEDIUM' });
    const res = await regra(c, 'Quais as anomalias abertas?', 'financeira_anomalias');
    assert.ok(res.answer.includes(`Anomalias financeiras abertas: ${base + 2}.`), 'o total é o real');
    assert.equal(res.answer.split('\n').filter((l) => l.startsWith('- Risco')).length, 1, 'lista limitada pelo parâmetro da empresa');
  });
});

test('m9d036_projecao_rotulada_realizado_previsto_estimado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const res = await regra(c, 'Qual a projeção de caixa?', 'financeira_projecao');
    const linhas = res.answer.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(linhas.length, 3);
    assert.match(linhas[0], /^- REALIZADO \(já aconteceu\): Caixa livre .*Recebido no mês .*Pago no mês /);
    const f = c.fin;
    assert.ok(linhas[1].startsWith(`- PREVISTO (lançamentos pendentes por vencimento): A receber na próxima semana ${B.brl(f.dueNextSevenDays.receivable.total)}; A pagar na próxima semana ${B.brl(f.dueNextSevenDays.payable.total)};`), linhas[1]);
    assert.ok(linhas[1].includes(`Saldo líquido projetado ${B.brl(f.projectedNetBalance)}`), linhas[1]);
    assert.match(linhas[1], /A receber em até dois meses /);
    assert.match(linhas[2], /^- ESTIMADO \(estimativa do relatório\): Necessidade de caixa para a próxima semana /);
    // A mesma projeção pela conversa com ferramentas: cada item sai com a natureza.
    const chat = await H.rodarNay(c, 'Qual a projeção de caixa? [[TOOL:finance.getCashflowProjection:{}]] [[RESPOSTA:O saldo líquido projetado (PREVISTO) é {{num:fluxo_saldo_projetado}} [1].]]');
    assert.equal(chat.ok, true, JSON.stringify(chat.error));
    assert.ok(chat.answer.includes(`PREVISTO) é ${B.brl(c.fin.projectedNetBalance)}`), chat.answer);
    const saida = (await H.q("SELECT count(*)::int AS n FROM ai.tool_calls WHERE run_id = :r AND status = 'SUCCEEDED'", { r: chat.runId }, tx))[0].n;
    assert.equal(saida, 1);
  });
});

test('m9d036_acao_sugerida_vira_recomendacao_ou_proposta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // O teto de sugestões vai a 50 para as nossas entrarem mesmo num banco com outros recebíveis vencidos.
    const c = await H.cenario(tenantA, tx, { params: { 'ia.financeira.sugestoes_max_itens': 50 } });
    const [curto, longo] = await Dados.criarRecebiveis(tenantA, tx, [{ dias: -10, valor: 700 }, { dias: -45, valor: 1300 }]);
    const antes = await H.fotografia(tx);
    const minhas = () => H.q("SELECT recommendation_type, status, proposed_action, ai_run_id, related_entity_id, risk_level FROM ai.ai_recommendations WHERE related_entity_id IN (:ids) ORDER BY recommendation_type", { ids: [curto.id, longo.id] }, tx);
    const res = await regra(c, 'Quem está inadimplente e o que fazer?', 'financeira_inadimplencia');
    assert.match(res.answer, /Ações sugeridas \(viram recomendações para a equipe decidir; nada foi cobrado\)/);
    assert.match(res.answer, /- Cobrança: título de R\$ 700,00 vencido há (10|11) dias\./); // 10 ou 11: o dia útil é o de São Paulo e a data do teste é UTC
    assert.match(res.answer, /- Renegociação: título de R\$ 1\.300,00 vencido há (45|46) dias\./);
    const recs = await minhas();
    assert.deepEqual(recs.map((r) => [r.recommendation_type, r.status, r.proposed_action, r.risk_level]), [['COLLECTION_SUGGESTION', 'PENDING', null, 'LOW'], ['RENEGOTIATION_SUGGESTION', 'PENDING', null, 'LOW']]);
    assert.ok(recs.every((r) => r.ai_run_id === res.runId), 'ligadas ao run');
    // O mesmo dia, a mesma sugestão: não duplica.
    await regra(c, 'Quem está inadimplente? Repita', 'financeira_inadimplencia');
    assert.equal((await minhas()).length, 2);
    // Nada foi cobrado, negociado nem pago: o Financeiro está exatamente como estava.
    assert.deepEqual(await H.fotografia(tx), antes);
    // O limite de dias para renegociar é parâmetro da empresa: com 60 dias, os 45 viram cobrança.
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { params: { 'ia.financeira.sugestoes_max_itens': 50, 'ia.financeira.dias_renegociacao': 60 } });
    const [, longo] = await Dados.criarRecebiveis(tenantA, tx, [{ dias: -10, valor: 700 }, { dias: -45, valor: 1300 }]);
    await regra(c, 'Quem está inadimplente e o que fazer?', 'financeira_inadimplencia');
    const [r] = await H.q("SELECT recommendation_type FROM ai.ai_recommendations WHERE related_entity_id = :id", { id: longo.id }, tx);
    assert.equal(r.recommendation_type, 'COLLECTION_SUGGESTION');
  });
});
