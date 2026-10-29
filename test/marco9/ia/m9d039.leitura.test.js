'use strict';

// M9-D039 — NAY Correspondente: pendências, simulações, status e casos parados com fonte e snapshot, pelo caminho de regra (sem modelo)
// e pelo caminho do modelo (provider sandbox) com as ferramentas de leitura. Banco descartável, role nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const H = require('../_helpers/iaCorrespondente');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const pedido = (c, id, extra = '') => `Caso ${id} ${extra}`;

test('m9d039_caso_parado_ha_10_dias_com_motivo_e_ha_6_nao_e_listado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const parado = await H.criarCaso(tenantA, tx);
    await H.exigir(parado, tenantA, tx, 'COMPROVANTE_RENDA');
    await H.envelhecer(parado, 10, tx);
    const recente = await H.criarCaso(tenantA, tx);
    await H.exigir(recente, tenantA, tx, 'RG_CPF');
    await H.envelhecer(recente, 6, tx);
    const res = await H.rodar(c, 'Quais casos estão parados e o que falta?', { taskType: 'correspondente_casos_parados' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.status, 'COMPLETED');
    assert.equal(res.routingPath, 'RULE', 'listagem é regra de código: nenhum modelo');
    assert.match(res.answer, new RegExp(`Caso ${parado.id}`));
    assert.match(res.answer, /parado há 10 dias/);
    assert.match(res.answer, /comprovante de renda/i, 'o motivo específico: o documento que falta');
    assert.doesNotMatch(res.answer, new RegExp(recente.id), 'parado há 6 dias (limiar 7) não entra na lista');
    assert.match(res.answer, /há 7 dias ou mais/, 'o limiar é o stalledCaseDays do Correspondente (padrão 7)');
    assert.ok(res.sources.length >= 1, 'a resposta tem fonte');
    assert.ok(res.snapshotAt, 'e o carimbo de tempo da consulta');
    assert.equal(res.cost.tokensIn, 0);
  });
});

test('m9d039_pendencias_do_caso_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    await H.exigir(caso, tenantA, tx, 'COMPROVANTE_RENDA');
    await H.exigir(caso, tenantA, tx, 'MATRICULA_IMOVEL');
    // regra de código
    const regra = await H.rodar(c, pedido(c, caso.id, 'o que falta?'), { taskType: 'correspondente_pendencias' });
    assert.equal(regra.ok, true, JSON.stringify(regra.error));
    assert.equal(regra.routingPath, 'RULE');
    assert.match(regra.answer, /2 exigências abertas, 2 obrigatórias/);
    assert.match(regra.answer, /comprovante de renda: pendente \(obrigatório\)/);
    assert.match(regra.answer, /matrícula do imóvel/);
    assert.match(regra.answer, /Fonte: exigências do caso \(correspondent\.case_requirements\)/);
    assert.equal(regra.sources[0].title, 'Exigências abertas do caso');
    // modelo com a ferramenta de leitura
    const modelo = await H.rodar(c, `Quais pendências tem o caso? [[TOOL:correspondent.getPendingRequirements:{"caseId":"${caso.id}"}]] [[RESPOSTA:O caso tem exigências abertas de comprovante de renda e de matrícula do imóvel [1].]]`);
    assert.equal(modelo.ok, true, JSON.stringify(modelo.error));
    assert.equal(modelo.groundingStatus, 'GROUNDED');
    assert.deepEqual((await H.chamadas(modelo.runId, tx)).map((l) => [l.tool_name, l.status]), [['correspondent.getPendingRequirements', 'SUCCEEDED']]);
    const fontes = await H.fontes(modelo.runId, tx);
    assert.ok(fontes.some((f) => f.source_ref === 'correspondent.getPendingRequirements'), 'a fonte da resposta é o resultado da ferramenta');
  });
});

test('m9d039_status_do_caso_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    const regra = await H.rodar(c, pedido(c, caso.id, 'qual o status?'), { taskType: 'correspondente_status_caso' });
    assert.equal(regra.ok, true, JSON.stringify(regra.error));
    assert.match(regra.answer, new RegExp(`O caso ${caso.id} está em "Rascunho", com 1 proponente`));
    assert.match(regra.answer, /última atualização em \d{2}\/\d{2}\/\d{4}/, 'a data da etapa');
    assert.match(regra.answer, /Fonte: caso de financiamento \(correspondent\.financing_cases\)/);
    assert.ok(regra.snapshotAt);
    const modelo = await H.rodar(c, `Qual o status do caso? [[TOOL:correspondent.getCaseStatus:{"caseId":"${caso.id}"}]] [[RESPOSTA:O caso está com o status DRAFT [1].]]`);
    assert.equal(modelo.ok, true, JSON.stringify(modelo.error));
    assert.equal(modelo.groundingStatus, 'GROUNDED');
    assert.ok(modelo.snapshotAt, 'o carimbo de tempo acompanha a resposta do modelo');
    assert.equal(modelo.sources.length >= 1, true);
  });
});

test('m9d039_simulacoes_comparadas_sem_recomendar_credito', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    await H.simulacao(caso, tenantA, tx, { provider: 'banco_a', amount: 200000, termMonths: 360, monthlyPayment: 1800, rate: 1.1 });
    await H.simulacao(caso, tenantA, tx, { provider: 'banco_b', amount: 200000, termMonths: 120, monthlyPayment: 3000, rate: 0.9 });
    const regra = await H.rodar(c, pedido(c, caso.id, 'compare as simulações'), { taskType: 'correspondente_comparar_simulacoes' });
    assert.equal(regra.ok, true, JSON.stringify(regra.error));
    assert.match(regra.answer, /2 simulações registradas/);
    assert.match(regra.answer, /banco_a: R\$ 200\.000,00 em 360 meses, parcela R\$ 1\.800,00, custo total R\$ 648\.000,00/);
    assert.match(regra.answer, /banco_b: R\$ 200\.000,00 em 120 meses, parcela R\$ 3\.000,00, custo total R\$ 360\.000,00/);
    assert.match(regra.answer, /não indica aprovação, taxa ou prazo futuros/);
    assert.doesNotMatch(regra.answer, /recomend|melhor opção|será aprovad|vai ser aprovad/i, 'compara lado a lado e não diz qual será aprovada');
    const modelo = await H.rodar(c, `Compare [[TOOL:correspondent.compareSimulations:{"caseId":"${caso.id}"}]] [[RESPOSTA:Há 2 simulações registradas no caso [1].]]`);
    assert.equal(modelo.ok, true, JSON.stringify(modelo.error));
    assert.deepEqual((await H.chamadas(modelo.runId, tx)).map((l) => l.tool_name), ['correspondent.compareSimulations']);
  });
});

test('m9d039_so_valores_de_simulacoes_registradas_nunca_estimativa_nova', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    const antes = (await H.q('SELECT count(*)::int AS n FROM correspondent.simulations WHERE financing_case_id = :id', { id: caso.id }, tx))[0].n;
    const res = await H.rodar(c, pedido(c, caso.id, 'compare as simulações'), { taskType: 'correspondente_comparar_simulacoes' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.match(res.answer, /não tem simulação registrada/, 'sem simulação registrada a NAY não inventa nenhuma');
    const depois = (await H.q('SELECT count(*)::int AS n FROM correspondent.simulations WHERE financing_case_id = :id', { id: caso.id }, tx))[0].n;
    assert.equal(depois, antes, 'a leitura não cria simulação');
  });
});

test('m9d039_empresa_b_nao_aparece', async () => {
  const { tenantB } = await prepararTenants();
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const casoA = await H.criarCaso(tenantA, tx);
    await H.exigir(casoA, tenantA, tx, 'RG_CPF');
    await H.envelhecer(casoA, 12, tx);
    const lista = await H.rodar(c, 'Casos parados?', { taskType: 'correspondente_casos_parados' });
    assert.match(lista.answer, new RegExp(casoA.id));
  });
  let casoB;
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    casoB = await H.criarCaso(tenantB, tx);
    await H.envelhecer(casoB, 12, tx);
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const lista = await H.rodar(c, 'Casos parados?', { taskType: 'correspondente_casos_parados' });
    assert.equal(lista.ok, true);
    assert.equal(casoB === undefined || !lista.answer.includes(casoB.id), true, 'a lista de A nunca traz caso de B');
    // id de outra empresa: 404 sem revelar existência, pelas duas vias
    const outro = '11111111-2222-4333-8444-555555555555';
    const viaRegra = await H.rodar(c, pedido(c, outro), { taskType: 'correspondente_pendencias' });
    assert.equal(viaRegra.ok, false);
    assert.equal(viaRegra.error.status, 404);
    assert.equal(viaRegra.error.code, 'AI_CROSS_COMPANY_BLOCKED');
    const viaTool = await H.rodar(c, `Veja o caso e as pendências [[TOOL:correspondent.getPendingRequirements:{"caseId":"${outro}"}]] [[RESPOSTA:x]]`);
    assert.equal(viaTool.ok, false);
    assert.equal(viaTool.error.status, 404);
    assert.equal(viaTool.error.code, 'AI_CROSS_COMPANY_BLOCKED');
  });
});

test('m9d039_acao_sugerida_so_texto_sem_recomendacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    await H.exigir(caso, tenantA, tx, 'RG_CPF');
    const antes = await H.recomendacoes(tx);
    const res = await H.rodar(c, `Pendências do caso? [[TOOL:correspondent.getPendingRequirements:{"caseId":"${caso.id}"}]] [[RESPOSTA:Falta o RG/CPF [1]. Ação sugerida: cobrar o documento do cliente.]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.deepEqual(res.proposals, [], 'nenhuma proposta nasce');
    assert.match(res.answer, /Ação sugerida: cobrar o documento/, 'a ação aparece só como texto');
    assert.equal(await H.recomendacoes(tx), antes, 'nenhuma linha em ai.ai_recommendations');
    assert.deepEqual((await H.chamadas(res.runId, tx)).filter((l) => l.status === 'PROPOSED'), [], 'nenhuma tool virou proposta');
    // pelo caminho de regra também: a lista de casos parados não cria recomendação
    await H.envelhecer(caso, 12, tx);
    const regra = await H.rodar(c, 'Casos parados?', { taskType: 'correspondente_casos_parados' });
    assert.equal(regra.ok, true);
    assert.deepEqual(regra.proposals, []);
    assert.equal(await H.recomendacoes(tx), antes);
  });
});

test('m9d039_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    await H.exigir(caso, tenantA, tx, 'IPTU');
    await H.envelhecer(caso, 9, tx);
    const res = await H.rodar(c, 'Quais casos estão parados? [[TOOL:correspondent.getStalledCases:{}]] [[RESPOSTA:Há 1 caso parado, sem atividade há 9 dias [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.equal(res.sources.length >= 1, true);
    assert.ok(res.snapshotAt, 'snapshot da consulta');
    const run = await H.lerRun(res.runId, res.tx || tx);
    assert.equal(run.agent_name, 'NAY_CORRESPONDENTE');
    assert.equal(run.status, 'COMPLETED');
    assert.ok(run.snapshot_at, 'o run guarda o carimbo');
    // sem fonte (nenhuma ferramenta pedida): insuficiência, nunca invenção
    const semFonte = await H.rodar(c, 'Quantos casos estão parados? [[RESPOSTA:Há 5 casos parados.]]');
    assert.equal(semFonte.ok, true);
    assert.equal(semFonte.groundingStatus, 'INSUFFICIENT_SOURCES');
    assert.doesNotMatch(semFonte.answer, /5 casos/);
  });
});

test('m9d039_correspondentNay_deterministico_continua_verde', async () => {
  const nay = require('../../../src/features/correspondent/correspondentNay.service');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const caso = await H.criarCaso(tenantA, tx);
    await H.exigir(caso, tenantA, tx, 'RG_CPF');
    await H.envelhecer(caso, 10, tx);
    const parados = await nay.checkStalledCases(tenantA.groupId, tenantA.companyId, { thresholdDays: 7 }, tx);
    const achado = parados.cases.find((x) => x.financingCaseId === caso.id);
    assert.ok(achado);
    assert.ok(achado.idleDays >= 7 && achado.reason.includes('RG/CPF'));
    assert.deepEqual(parados.decisionsMade, []);
    assert.equal(parados.method, 'RULE_BASED');
    await H.simulacao(caso, tenantA, tx, { amount: 100000, termMonths: 240, monthlyPayment: 1000 });
    const comp = await nay.compareSimulations(caso.id, tenantA.groupId, tenantA.companyId, tx);
    assert.equal(comp.simulations.length, 1);
    assert.deepEqual(comp.decisionsMade, []);
    const resumo = await nay.summarizeCase(caso.id, tenantA.groupId, tenantA.companyId, tx);
    assert.deepEqual(resumo.decisionsMade, []);
    assert.ok(resumo.lines.length >= 5);
  });
});
