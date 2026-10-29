'use strict';

// M9-D035 — conversa com ferramentas (modelo sandbox): resposta com fontes e snapshot, área sem permissão omitida com aviso, tools
// compartilhadas só com agregados para a Diretoria e agente somente leitura (nenhuma recomendação nem proposta). nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const H = require('../_helpers/iaDiretoria');
const Dados = require('../_helpers/iaNayDados');
const B = require('../_helpers/iaNayBase');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

// 3 contratos em até 30 dias (R$ 12.000,00) e 2 entre 31 e 60 dias (R$ 8.500,00): o exemplo numérico da demanda.
const CONTRATOS = [{ dias: 10, valor: 4000 }, { dias: 20, valor: 4000 }, { dias: 25, valor: 4000 }, { dias: 40, valor: 5000 }, { dias: 55, valor: 3500 }];
const FRASE = 'Contratos a vencer: {{num:contratos_f1_qtd}} contratos vencem em {{num:contratos_f1_dias}} ({{num:contratos_f1_valor}}) e {{num:contratos_f2_qtd}} em {{num:contratos_f2_dias}} ({{num:contratos_f2_valor}}) [1].';

test('m9d035_responde_com_fontes_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const antes = await B.bandas(tx);
    await Dados.criarContratos(tenantA, tx, CONTRATOS);
    const depois = await B.bandas(tx);
    // Os contratos do teste mudam o read model em exatamente 3 (R$ 12.000,00) na primeira faixa e 2 (R$ 8.500,00) na segunda.
    assert.deepEqual([depois.bands[0].count - antes.bands[0].count, B.round2(depois.bands[0].total - antes.bands[0].total)], [3, 12000]);
    assert.deepEqual([depois.bands[1].count - antes.bands[1].count, B.round2(depois.bands[1].total - antes.bands[1].total)], [2, 8500]);
    const res = await H.rodarNay(c, `Como estão os contratos a vencer da empresa? [[TOOL:legal.getExpiringContracts:{}]] [[RESPOSTA:${FRASE}]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.status, 'COMPLETED');
    assert.ok(res.answer.includes(`${depois.bands[0].count} contratos vencem em 30 dias (${B.brl(depois.bands[0].total)}) e ${depois.bands[1].count} em 60 dias (${B.brl(depois.bands[1].total)})`), res.answer);
    assert.doesNotMatch(res.answer, /QA-M9|contractNumber|contractId/, 'sem número de contrato nem nome');
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.ok(res.sources.length >= 1, 'fonte citada');
    assert.ok(res.snapshotAt, 'snapshot da resposta');
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.agent_name || 'NAY_DIRETORIA', 'NAY_DIRETORIA');
    assert.equal((await H.chamadas(res.runId, tx))[0].status, 'SUCCEEDED');
  });
});

test('m9d035_area_sem_permissao_e_omitida_com_aviso', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await Dados.criarContratos(tenantA, tx, CONTRATOS);
    const auth = H.authSem(c, 'finance:read');
    const pedido = `Resuma a empresa [[TOOL:finance.getWeeklyHealth:{}]] [[TOOL:legal.getExpiringContracts:{}]] [[RESPOSTA:${FRASE}]]`;
    const res = await H.rodarNay(c, pedido, { auth });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.status, 'COMPLETED', 'o bloqueio de uma tool não derruba o run');
    assert.match(res.answer, /Financeiro: sem acesso\./);
    assert.match(res.answer, /contratos vencem em 30 dias/, 'segue com as demais tools permitidas');
    const linhas = await H.chamadas(res.runId, tx);
    assert.deepEqual(linhas.map((l) => [l.tool_name, l.status]), [['finance.getWeeklyHealth', 'BLOCKED'], ['legal.getExpiringContracts', 'SUCCEEDED']]);
  });
});

test('m9d035_tools_de_contratos_e_casos_so_devolvem_agregados_para_a_diretoria', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const antes = await B.bandas(tx);
    await Dados.criarContratos(tenantA, tx, CONTRATOS);
    const { buildToolServices } = require('../../../src/features/ai/toolServices');
    const { definitionOf } = require('../../../src/features/ai/agents/kit/readTool');
    const scope = (dataScopes) => ({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId: c.ctx.userId, dataScopes });
    const ler = async (tool, dataScopes) => definitionOf(tool).execute({ services: buildToolServices(tx, scope(dataScopes)).services }, {});
    // Diretoria (escopo .summary): contagens e totais por faixa, sem identificação.
    const sumario = await ler('legal.getExpiringContracts', H.D.DATA_SCOPES);
    assert.equal(sumario.mode, 'SUMMARY');
    assert.equal(sumario.contracts, undefined, 'sem lista nominal');
    assert.deepEqual(sumario.bands.map((b, i) => [b.fromDays, b.toDays, b.count - antes.bands[i].count, B.round2(b.total - antes.bands[i].total)]), [[0, 30, 3, 12000], [31, 60, 2, 8500], [61, 90, 0, 0]]);
    assert.doesNotMatch(JSON.stringify(sumario), /QA-M9|contractNumber|contractId/);
    // Agente do jurídico (escopo nominal): a MESMA tool entrega a lista.
    const nominal = await ler('legal.getExpiringContracts', ['legal.contracts']);
    assert.equal(nominal.mode, 'DETAIL');
    assert.equal(nominal.contracts.length - (antes.bands.reduce((n, b) => n + b.count, 0)), 5);
    assert.ok(nominal.contracts.every((x) => x.contractId && x.contractNumber));
    // Casos parados: a Diretoria recebe a quantidade por etapa; a lista com o motivo é do correspondente.
    const parados = await ler('correspondent.getStalledCases', H.D.DATA_SCOPES);
    assert.equal(parados.mode, 'SUMMARY');
    assert.equal(parados.items, undefined);
    assert.ok(Array.isArray(parados.byStage));
    // Sem declarar escopo nenhum, a falha é fechada: agregado.
    assert.equal((await ler('legal.getExpiringContracts', [])).mode, 'SUMMARY');
  });
});

test('m9d035_acao_sugerida_so_texto_sem_recomendacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    await Dados.criarContratos(tenantA, tx, CONTRATOS);
    const antes = await H.recomendacoes(tx);
    const res = await H.rodarNay(c, 'Quais as prioridades desta semana?', { taskType: 'diretoria_prioridades' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.match(res.answer, /Prioridade/);
    assert.match(res.answer, /sugestões em texto: nenhuma ação foi executada nem proposta/);
    assert.deepEqual(res.proposals, []);
    assert.equal(await H.recomendacoes(tx), antes, 'nenhuma linha em ai.recommendations');
    assert.equal(await H.propostas(tx), 0, 'nenhuma proposta');
    // Nenhuma tool de escrita existe na allowlist e uma tentativa de usá-la é bloqueada.
    const escrita = await H.rodarNay(c, 'Resuma a empresa [[TOOL:crm.createFollowUpTask:{"opportunityId":"00000000-0000-4000-8000-000000000000","title":"x"}]] [[RESPOSTA:x]]');
    assert.equal(escrita.ok, false);
    assert.equal(escrita.error.code, 'AI_TOOL_NOT_ALLOWED');
    assert.equal(await H.recomendacoes(tx), antes);
  });
});
