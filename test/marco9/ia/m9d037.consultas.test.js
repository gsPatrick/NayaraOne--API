'use strict';

// M9-D037 — NAY Obras: progresso, custos (orçado x realizado), diário, qualidade e pós-obra respondidos com fonte e carimbo de tempo,
// pelas tools de leitura (modelo sandbox) e pelo caminho de regra (listagem e cálculo, sem modelo). Os números são escritos pelo servidor.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { tag } = require('../../../src/features/ai/agents/nay_obras/obras.numbers');
const H = require('../_helpers/m9d037Agente');
const O = require('../_helpers/m9d037Obras');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'construction:read'];
const pedido = (tool, obra, resposta) => `Resuma [[TOOL:${tool}:{"projectId":"${obra.id}"}]] [[RESPOSTA:${resposta}]]`;

/** Roda a tool pelo orquestrador e confere: ok, tool SUCCEEDED, fonte citada, carimbo de tempo e resposta com os números do servidor. */
async function consultar(c, tx, tool, obra, resposta) {
  const res = await H.perguntar(c, pedido(tool, obra, resposta));
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.groundingStatus, 'GROUNDED', res.answer);
  assert.ok(res.snapshotAt, 'a resposta traz o carimbo de tempo do dado');
  assert.ok(res.sources.length >= 1 && JSON.stringify(res.sources).includes(tool), 'a fonte é o resultado da tool');
  const linhas = await H.chamadas(res.runId, tx);
  assert.deepEqual(linhas.map((l) => [l.tool_name, l.status]), [[tool, 'SUCCEEDED']]);
  return res;
}

test('m9d037_progresso_da_obra_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const obra = await O.criarObra(tenantA, tx, { atrasoDias: 10 });
    const t = tag(obra.id);
    const res = await consultar(c, tx, 'construction.getProjectProgress', obra, `Avanço físico {{num:obra_${t}_avanco_fisico}} contra {{num:obra_${t}_avanco_planejado}} planejado, com atraso de {{num:obra_${t}_atraso_dias}} dias [1].`);
    assert.match(res.answer, /Avanço físico 0,00% contra 0,00% planejado, com atraso de 10 dias/);
  });
});

test('m9d037_custos_orcado_x_realizado_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const obra = await O.criarObra(tenantA, tx, { orcado: '100000.00', realizado: '112500.00' });
    const t = tag(obra.id);
    const res = await consultar(c, tx, 'construction.getBudgetVsActual', obra, `Orçado {{num:obra_${t}_orcado}}, realizado {{num:obra_${t}_realizado}}, desvio {{num:obra_${t}_desvio}} ({{num:obra_${t}_desvio_pct}}) [1].`);
    assert.match(res.answer, /Orçado R\$ 100\.000,00, realizado R\$ 112\.500,00, desvio R\$ 12\.500,00 \(12,50%\)/);
    // Número escrito pelo modelo, fora do read model, não passa.
    const inventado = await H.perguntar(c, pedido('construction.getBudgetVsActual', obra, 'O desvio é R$ 99.999,00 [1].'));
    assert.doesNotMatch(inventado.ok ? inventado.answer : '', /99\.999/);
  });
});

test('m9d037_diario_de_obra_resumido_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const obra = await O.criarObra(tenantA, tx);
    const rdo = await O.diario(tenantA, tx, obra.id, { blockages: 'Chuva forte parou a concretagem.', occurrences: 'Entrega de aço atrasada.' });
    const t = tag(obra.id);
    const res = await consultar(c, tx, 'construction.getDailyReports', obra, `Há {{num:obra_${t}_diarios_na_janela}} diário na janela, com {{num:obra_${t}_diarios_com_bloqueio}} bloqueio [1].`);
    assert.match(res.answer, /Há 1 diário na janela, com 1 bloqueio/);
    const [chamada] = await H.chamadas(res.runId, tx);
    assert.match(JSON.stringify(chamada), new RegExp(rdo.id), 'a referência ao diário vem no resultado da tool');
  });
});

test('m9d037_qualidade_nao_conformidades_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const obra = await O.criarObra(tenantA, tx);
    const nc = await O.naoConformidade(tenantA, tx, obra.id);
    const t = tag(obra.id);
    const res = await consultar(c, tx, 'construction.getQualityNonConformities', obra, `Há {{num:obra_${t}_nc_abertas}} não conformidade aberta [1].`);
    assert.match(res.answer, /Há 1 não conformidade aberta/);
    assert.match(JSON.stringify((await H.chamadas(res.runId, tx))[0]), new RegExp(nc.id));
  });
});

test('m9d037_pos_obra_garantias_com_fonte', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const obra = await O.criarObra(tenantA, tx);
    const caso = await O.garantia(tenantA, tx, obra.id);
    const t = tag(obra.id);
    const res = await consultar(c, tx, 'construction.getWarrantyCases', obra, `Há {{num:obra_${t}_garantias_abertas}} chamado de garantia aberto [1].`);
    assert.match(res.answer, /Há 1 chamado de garantia aberto/);
    assert.match(JSON.stringify((await H.chamadas(res.runId, tx))[0]), new RegExp(caso.id));
  });
});

test('m9d037_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    // O exemplo do livro: prazo em 30/09, ainda em andamento em 10/10 (10 dias de atraso), orçado R$ 100.000,00 e realizado R$ 112.500,00.
    const obra = await O.criarObra(tenantA, tx, { name: 'Obra Aurora', atrasoDias: 10, orcado: '100000.00', realizado: '112500.00' });
    await O.diario(tenantA, tx, obra.id, { blockages: 'Chuva forte parou a concretagem.' });
    const res = await H.perguntar(c, 'Quais obras estão atrasadas e por quê?', { taskType: 'listar_obras_atrasadas' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE', 'listagem por regra, sem modelo');
    assert.equal(res.cost.tokensIn + res.cost.tokensOut, 0);
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.ok(res.snapshotAt, 'snapshot do dado');
    assert.ok(res.sources.length >= 1);
    for (const trecho of ['Obra Aurora', 'atraso de 10 dias', 'Chuva forte parou a concretagem', 'orçado R$ 100.000,00', 'realizado R$ 112.500,00', 'desvio R$ 12.500,00 (12,50%)']) assert.ok(res.answer.includes(trecho), `falta "${trecho}" em: ${res.answer}`);
    // O cálculo do desvio da obra também é sempre por regra.
    const calc = await H.perguntar(c, 'Qual o desvio de custo da obra?', { taskType: 'calcular_desvio_custo_obra', subject: { type: 'constructionProject', id: obra.id } });
    assert.equal(calc.ok, true, JSON.stringify(calc.error));
    assert.equal(calc.routingPath, 'RULE');
    assert.match(calc.answer, /desvio de custo R\$ 12\.500,00 \(12,50%\)/);
    const semObra = await H.perguntar(c, 'Qual o desvio de custo?', { taskType: 'calcular_desvio_custo_obra' });
    assert.equal(semObra.ok, false);
    assert.equal(semObra.error.code, 'AI_RULE_UNRESOLVED');
  });
});

test('m9d037_parametros_da_empresa_definem_tamanho_das_listas_e_janela_do_diario', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS, params: { 'ia.nay_obras.max_itens_lista': 1, 'ia.nay_obras.diario_janela_dias': 60 } });
    const obra = await O.criarObra(tenantA, tx);
    await O.naoConformidade(tenantA, tx, obra.id, { description: 'Primeira não conformidade.' });
    await O.naoConformidade(tenantA, tx, obra.id, { description: 'Segunda não conformidade.' });
    await O.diario(tenantA, tx, obra.id, { reportDate: O.dia(-40), blockages: 'Bloqueio antigo.' });
    const nc = await consultar(c, tx, 'construction.getQualityNonConformities', obra, 'Há não conformidades [1].');
    const [chamada] = await H.chamadas(nc.runId, tx);
    const saida = JSON.parse(JSON.stringify(chamada.output_json || chamada.output || chamada));
    assert.match(JSON.stringify(saida), /"total":2/);
    assert.equal((JSON.stringify(saida).match(/não conformidade\./g) || []).length, 1, 'a lista respeita ia.nay_obras.max_itens_lista = 1');
    const diario = await consultar(c, tx, 'construction.getDailyReports', obra, 'Há diários [1].');
    assert.match(JSON.stringify((await H.chamadas(diario.runId, tx))[0]), /Bloqueio antigo/, 'o diário de 40 dias atrás entra na janela configurada de 60 dias');
  });
});
