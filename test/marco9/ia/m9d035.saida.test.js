'use strict';

// M9-D035 — as quatro entregas do livro ("saúde da empresa, riscos, prioridades e explicações") pelo caminho de regra: números dos read
// models escritos pelo servidor, fonte e snapshot em cada resposta, severidade por parâmetro, sem modelo. nayara_runtime, rollback.

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

const CONTRATOS = [{ dias: 10, valor: 4000 }, { dias: 20, valor: 4000 }, { dias: 25, valor: 4000 }, { dias: 40, valor: 5000 }, { dias: 55, valor: 3500 }];

/** Cenário com dados da empresa; `c.ref` guarda o read model lido antes e depois (a diferença é exatamente o que o teste criou). */
async function com(tx, params = {}) {
  const c = await H.cenario(tenantA, tx, { params });
  const antes = { fin: await B.financeiro(tx), bandas: await B.bandas(tx) };
  await Dados.criarContratos(tenantA, tx, CONTRATOS);
  await Dados.criarRecebiveis(tenantA, tx, [{ dias: -10, valor: 1000 }, { dias: -3, valor: 500.5 }, { dias: 5, valor: 2000 }]);
  const depois = { fin: await B.financeiro(tx), bandas: await B.bandas(tx) };
  assert.equal(depois.fin.overdue.receivable.count - antes.fin.overdue.receivable.count, 2);
  assert.equal(B.round2(depois.fin.overdue.receivable.total - antes.fin.overdue.receivable.total), 1500.5);
  assert.equal(B.round2(depois.fin.receivablePending.total - antes.fin.receivablePending.total), 3500.5);
  assert.deepEqual([depois.bandas.bands[0].count - antes.bandas.bands[0].count, B.round2(depois.bandas.bands[0].total - antes.bandas.bands[0].total)], [3, 12000]);
  assert.deepEqual([depois.bandas.bands[1].count - antes.bandas.bands[1].count, B.round2(depois.bandas.bands[1].total - antes.bandas.bands[1].total)], [2, 8500]);
  c.ref = { antes, depois };
  return c;
}
const sevInad = (fin) => { const p = Number(fin.delinquencyRatio) * 100; return p >= 10 ? 'alta' : p >= 5 ? 'média' : 'baixa'; };
const rodar = (c, texto, taskType, over = {}) => H.rodarNay(c, texto, { taskType, ...over });
const sem = (res) => { assert.equal(res.ok, true, JSON.stringify(res.error)); assert.equal(res.routingPath, 'RULE', 'sem modelo'); assert.equal(res.cost.tokensIn, 0); return res; };

test('m9d035_saude_da_empresa_resume_areas_com_fonte_e_snapshot', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const { fin, bandas } = c.ref.depois;
    const res = sem(await rodar(c, 'Como está a empresa esta semana?', 'diretoria_saude'));
    assert.ok(res.answer.includes(`Financeiro: a receber ${B.brl(fin.receivablePending.total)}, a pagar ${B.brl(fin.payablePending.total)}, saldo líquido projetado ${B.brl(fin.projectedNetBalance)} e total vencido ${B.brl(fin.overdue.total)}.`), res.answer);
    const [f1, f2, f3] = bandas.bands;
    assert.ok(res.answer.includes(`Jurídico: ${f1.count} contratos vencem em até 30 dias (${B.brl(f1.total)}), ${f2.count} contratos vencem em até 60 dias (${B.brl(f2.total)}), ${f3.count} contratos vencem em até 90 dias (${B.brl(f3.total)}).`), res.answer);
    for (const area of ['Comercial', 'Obras', 'Correspondente', 'Estoque']) assert.match(res.answer, new RegExp(`${area}: `), area);
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.ok(res.snapshotAt, 'snapshot');
    const refs = res.sources.map((s) => s.title || s.sourceRef).join('|');
    assert.match(refs, /Saúde financeira da semana/);
    assert.match(refs, /Contratos a vencer/);
    assert.ok(res.sources.length >= 6, 'uma fonte por área');
  });
});

test('m9d035_lista_riscos_com_fonte_e_severidade', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const { fin, bandas } = c.ref.depois;
    const res = sem(await rodar(c, 'Quais são os riscos da empresa?', 'diretoria_riscos'));
    const linhas = res.answer.split('\n').filter((l) => l.startsWith('- '));
    const inad = linhas.find((l) => l.includes('Inadimplência:'));
    const contr = linhas.find((l) => l.includes('Contratos a vencer:'));
    assert.ok(inad && contr, res.answer);
    assert.equal(inad, `- Severidade ${sevInad(fin)} | Inadimplência: ${fin.overdue.receivable.count} parcelas a receber vencidas, somando ${B.brl(fin.overdue.receivable.total)}, ${B.pct(fin.delinquencyRatio)} do total elegível. Fonte: finance.getWeeklyHealthReport.`);
    const sevContr = bandas.bands[0].count >= 5 ? 'alta' : 'média';
    assert.equal(contr, `- Severidade ${sevContr} | Contratos a vencer: ${bandas.bands[0].count} contratos vencem em até 30 dias, somando ${B.brl(bandas.bands[0].total)}. Fonte: legal.contracts.`);
    assert.ok(snapshot(res));
    assert.ok(res.sources.some((s) => /Read model: legal\.contracts/.test(s.excerpt)) && res.sources.some((s) => /Read model: finance\.getWeeklyHealthReport/.test(s.excerpt)), 'fonte do read model em cada risco');
    // Severidade decrescente: nenhuma linha "alta" depois de "média" ou "baixa".
    const ordem = linhas.map((l) => ({ alta: 3, média: 2, baixa: 1 })[/Severidade (\S+)/.exec(l)[1]]);
    assert.deepEqual(ordem, [...ordem].sort((a, b) => b - a));
  });
});
const snapshot = (res) => res.snapshotAt;

test('m9d035_severidade_e_ordem_vem_de_parametros_da_empresa', async () => {
  // Teto de riscos por parâmetro: só o mais grave aparece.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx, { 'ia.diretoria.max_riscos': 1 });
    const res = sem(await rodar(c, 'Quais são os riscos da empresa?', 'diretoria_riscos'));
    assert.equal(res.answer.split('\n').filter((l) => l.startsWith('- ')).length, 1, 'teto de riscos por parâmetro');
  });
  // Limites de severidade por parâmetro: inadimplência de 43% fica baixa com limite alto de 50%, e três contratos viram risco alto com limite de três itens.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx, { 'ia.diretoria.risco_alto_min_itens': 3, 'ia.diretoria.inadimplencia_alta_pct': 100, 'ia.diretoria.inadimplencia_media_pct': 100 });
    const res = sem(await rodar(c, 'Quais são os riscos da empresa?', 'diretoria_riscos'));
    assert.match(res.answer, /Severidade alta \| Contratos a vencer/, 'três contratos atingem o novo limite de itens');
    const esperada = Number(c.ref.depois.fin.delinquencyRatio) * 100 >= 100 ? 'alta' : 'baixa'; // limite de 100%: só a inadimplência total o atinge
    assert.match(res.answer, new RegExp(`Severidade ${esperada} \\| Inadimplência`), 'a severidade da inadimplência obedece ao limite configurado');
    if (esperada === 'baixa') assert.ok(res.answer.indexOf('Contratos a vencer') < res.answer.indexOf('Inadimplência'), 'ordem por severidade');
  });
});

test('m9d035_limite_zero_de_inadimplencia_e_respeitado', async () => {
  // Reabertura: 0 é valor válido do parâmetro e não pode virar o padrão (5%): com limite médio 0, qualquer inadimplência acima de 0% é "média".
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx, { 'ia.diretoria.inadimplencia_media_pct': 0, 'ia.diretoria.inadimplencia_alta_pct': 100 });
    await Dados.criarRecebiveis(tenantA, tx, [{ dias: 30, valor: 100000 }]); // dilui o índice abaixo do padrão de 5%, mas acima de 0%
    const fin = await B.financeiro(tx);
    const res = sem(await rodar(c, 'Quais são os riscos da empresa?', 'diretoria_riscos'));
    const pct = Number(fin.delinquencyRatio) * 100;
    assert.ok(pct > 0 && pct < 5, `índice entre 0% e o padrão de 5%: ${pct}`);
    assert.match(res.answer, new RegExp(`Severidade ${pct >= 100 ? 'alta' : 'média'} \\| Inadimplência`), res.answer);
  });
});

test('m9d035_prioridades_sugeridas_apenas_em_texto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const antes = await H.recomendacoes(tx);
    const res = sem(await rodar(c, 'Quais são as prioridades da diretoria?', 'diretoria_prioridades'));
    assert.match(res.answer, new RegExp(`Prioridade ${sevInad(c.ref.depois.fin)}: tratar "inadimplência"`));
    assert.match(res.answer, /Prioridade (alta|média): tratar "contratos a vencer"/);
    assert.match(res.answer, /nenhuma ação foi executada nem proposta/);
    assert.deepEqual(res.proposals, []);
    assert.equal(await H.recomendacoes(tx), antes, 'nada em ai.recommendations');
    assert.deepEqual(await H.chamadas(res.runId, tx), [], 'nenhuma ferramenta de escrita (nem de leitura) pelo modelo');
  });
});

test('m9d035_explica_indicador_com_fonte_e_formula', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const res = sem(await rodar(c, 'Explique o indicador de inadimplência', 'diretoria_explicar_indicador'));
    const { fin, bandas } = c.ref.depois;
    assert.ok(res.answer.includes(`Inadimplência: índice de ${B.pct(fin.delinquencyRatio)}, com ${B.brl(fin.overdue.receivable.total)} vencidos.`), res.answer);
    assert.match(res.answer, /Read model: finance\.getWeeklyHealthReport\./);
    assert.match(res.answer, /Período: posição na data da consulta/);
    assert.match(res.answer, /Fórmula: recebíveis próprios vencidos divididos pelo total elegível a receber, em percentual\./);
    assert.ok(res.snapshotAt);
    assert.equal(res.groundingStatus, 'GROUNDED');
    const contratos = sem(await rodar(c, 'Explique o indicador de contratos a vencer', 'diretoria_explicar_indicador'));
    assert.ok(contratos.answer.includes(`${bandas.bands[0].count} contratos até 30 dias (${B.brl(bandas.bands[0].total)}); ${bandas.bands[1].count} contratos até 60 dias (${B.brl(bandas.bands[1].total)})`), contratos.answer);
    assert.match(contratos.answer, /Fórmula: contagem e soma do valor dos contratos ativos por faixa de dias/);
    // Sem permissão da área: o indicador não é explicado com número algum.
    const bloqueado = sem(await rodar(c, 'Explique o indicador de inadimplência', 'diretoria_explicar_indicador', { auth: H.authSem(c, 'finance:read') }));
    assert.match(bloqueado.answer, /Financeiro: sem acesso\./);
    assert.doesNotMatch(bloqueado.answer, new RegExp(B.brl(fin.overdue.receivable.total).replace(/[$.]/g, '\\$&')));
  });
});

test('m9d035_saude_omite_area_sem_permissao_com_aviso', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await com(tx);
    const res = sem(await rodar(c, 'Como está a empresa esta semana?', 'diretoria_saude', { auth: H.authSem(c, 'finance:read', 'legal:read') }));
    assert.match(res.answer, /Financeiro: sem acesso\./);
    assert.match(res.answer, /Jurídico: sem acesso\./);
    assert.doesNotMatch(res.answer, new RegExp(`${B.brl(c.ref.depois.fin.receivablePending.total).replace(/[$.]/g, '\\$&')}|${B.brl(c.ref.depois.bandas.bands[0].total).replace(/[$.]/g, '\\$&')}`), 'nenhum número das áreas sem acesso');
    assert.match(res.answer, /Comercial: /);
  });
});
