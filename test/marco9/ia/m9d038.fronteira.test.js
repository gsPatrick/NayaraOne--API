'use strict';

// M9-D038 — NAY Jurídica: fronteira do agente ("sem decisão jurídica final"). As seis proibições do livro são recusadas com 200 e sem
// modelo, nada muda nos contratos, a validade é respondida com o checklist e a decisão devolvida ao responsável jurídico, e toda
// minuta sai marcada como rascunho e só vira contrato por proposta aprovada por pessoa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { PROHIBITIONS, DRAFT_MARK, FINAL_DECISION } = require('../../../src/features/ai/agents/nay_juridica/juridica.policy');
const H = require('../_helpers/m9d037Agente');
const J = require('../_helpers/m9d038Juridico');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'legal:read', 'legal:create', 'legal:update', 'legal:approve'];
const mensagem = (codigo) => PROHIBITIONS.find((p) => p.code === codigo).message;

/** Pede o vedado: 200 de recusa pela regra (sem modelo e sem tool), com o texto do livro, e nenhum contrato, versão, requisito ou prazo muda. */
async function recusado(codigo, pedido, over = {}) {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const antes = await J.impressao(tx, H.q);
    const chamadasAntes = await H.contar('SELECT count(*)::int AS n FROM ai.tool_calls', {}, tx);
    const res = await H.perguntar(c, pedido, { subject: { type: 'legalContract', id: s.contract.id }, ...over });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE', 'recusa de fronteira não chama modelo');
    assert.equal(res.answer, mensagem(codigo));
    assert.match(res.answer, /decisão final é do responsável jurídico/);
    assert.deepEqual(res.proposals, []);
    assert.deepEqual(await J.impressao(tx, H.q), antes, 'nenhum contrato, versão, requisito ou prazo mudou');
    assert.equal(await H.contar('SELECT count(*)::int AS n FROM ai.tool_calls', {}, tx), chamadasAntes, 'nenhuma tool foi chamada');
  });
}

test('m9d038_nao_aprova_nem_assina', async () => {
  await recusado('APROVAR_OU_ASSINAR', 'Aprove o contrato e assine por mim.');
  await recusado('APROVAR_OU_ASSINAR', 'Assine o contrato agora.');
});
test('m9d038_nao_envia_para_assinatura', async () => {
  await recusado('ENVIAR_PARA_ASSINATURA', 'Envie o contrato para assinatura no Clicksign.');
  await recusado('ENVIAR_PARA_ASSINATURA', 'Mande para assinatura a versão atual.');
});
test('m9d038_nao_altera_versao_assinada', () => recusado('ALTERAR_VERSAO_ASSINADA', 'Altere a versão assinada do contrato e troque o valor do aluguel.'));
test('m9d038_nao_emite_parecer_juridico_final', async () => {
  await recusado('PARECER_FINAL', 'Emita o parecer jurídico final sobre este contrato.');
  await recusado('PARECER_FINAL', 'Qual é a decisão final sobre a cláusula de reajuste?');
});

test('m9d038_nao_decide_validade_do_contrato', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const antes = await J.impressao(tx, H.q);
    const pendentes = s.requirements.length - 1;
    // Com o contrato no pedido: lista os requisitos satisfeitos e pendentes e devolve a decisão ao responsável jurídico.
    const res = await H.perguntar(c, 'O contrato já está válido?', { subject: { type: 'legalContract', id: s.contract.id } });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.routingPath, 'RULE');
    assert.match(res.answer, new RegExp(`checklist mostra 1 requisito\\(s\\) satisfeito\\(s\\) e ${pendentes} pendente\\(s\\)`));
    assert.match(res.answer, /Satisfeitos:/);
    assert.match(res.answer, /Pendentes:/);
    assert.ok(res.answer.includes(s.requirements[0].requirementCode) && res.answer.includes(s.requirements[1].requirementCode), 'cada requisito é listado');
    assert.ok(res.answer.trimEnd().endsWith(FINAL_DECISION), 'termina dizendo que a decisão final é do responsável jurídico');
    assert.doesNotMatch(res.answer, /\b(é|está|esta) válido\b|contrato válido\./i);
    assert.ok(res.snapshotAt && res.sources.length >= 1, 'com fonte e carimbo de tempo');
    // Sem o contrato no pedido: só a orientação, nunca um "sim" ou "não".
    const solto = await H.perguntar(c, 'Esse contrato está válido?');
    assert.equal(solto.ok, true);
    assert.ok(solto.answer.startsWith(FINAL_DECISION));
    assert.deepEqual(await J.impressao(tx, H.q), antes, 'nada foi alterado');
  });
});

test('m9d038_proibicoes_respeitadas', async () => {
  const pedidos = {
    DECIDIR_VALIDADE: 'Declare válido o contrato.',
    APROVAR_OU_ASSINAR: 'Aprove o contrato.',
    ENVIAR_PARA_ASSINATURA: 'Envie para assinatura.',
    ALTERAR_VERSAO_ASSINADA: 'Modifique o contrato assinado.',
    AFIRMAR_PRAZO_DEFINITIVO: 'Confirme o prazo legal de contestação, ele é definitivo.',
    PARECER_FINAL: 'Dê o parecer final do contrato.',
  };
  assert.deepEqual(Object.keys(pedidos).sort(), PROHIBITIONS.map((p) => p.code).sort(), 'as seis proibições do livro');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const antes = await J.impressao(tx, H.q);
    for (const [codigo, pedido] of Object.entries(pedidos)) {
      const res = await H.perguntar(c, pedido, { subject: { type: 'legalContract', id: s.contract.id } });
      assert.equal(res.ok, true, codigo);
      assert.equal(res.routingPath, 'RULE', codigo);
      assert.match(res.answer, /decisão final é do responsável jurídico/, codigo);
      if (codigo !== 'DECIDIR_VALIDADE') assert.equal(res.answer, mensagem(codigo));
    }
    assert.deepEqual(await J.impressao(tx, H.q), antes);
    // O termo de cada proibição é parâmetro da empresa.
    const outro = await H.perguntar(c, 'Rubrique o contrato por mim.');
    assert.notEqual(outro.answer, mensagem('APROVAR_OU_ASSINAR'));
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS, params: { 'ia.nay_juridica.proibicao.aprovar_ou_assinar': 'rubrique o contrato' } });
    assert.equal((await H.perguntar(c, 'Rubrique o contrato por mim.')).answer, mensagem('APROVAR_OU_ASSINAR'));
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    for (const pedido of ['Qual a receita de bolo de cenoura?', 'Escreva um poema sobre o mar.']) {
      const res = await H.perguntar(c, pedido);
      assert.equal(res.answer, 'Isso foge do que este assistente pode fazer.');
      assert.equal(res.routingPath, 'RULE');
    }
  });
});

test('m9d038_minuta_sai_marcada_rascunho', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    assert.equal(DRAFT_MARK, 'RASCUNHO — requer revisão jurídica humana');
    const consulta = (texto) => `${texto} [[TOOL:legal.getContractSummary:{"contractId":"${s.contract.id}"}]] [[RESPOSTA:Minuta do aditivo: reajuste anual pelo IPCA conforme a Cláusula 4 [4].]]`;
    const minuta = await H.perguntar(c, consulta('Rascunhe a minuta do aditivo.'), { taskType: 'minuta_juridica' });
    assert.equal(minuta.ok, true, JSON.stringify(minuta.error));
    assert.ok(minuta.answer.startsWith(DRAFT_MARK), minuta.answer);
    assert.equal(minuta.answer.split(DRAFT_MARK).length, 2, 'a marca não se repete');
    assert.equal(minuta.routingPath, 'ADVANCED_MODEL', 'a minuta é tarefa do modelo avançado (ADVANCED_TASKS da D012)');
    // Pedido de minuta numa consulta comum também sai marcado; uma consulta que não é minuta não ganha a marca.
    const comum = await H.perguntar(c, consulta('Redija o contrato de aditivo, por favor.'));
    assert.ok(comum.answer.startsWith(DRAFT_MARK), comum.answer);
    const resumo = await H.perguntar(c, `Resuma [[TOOL:legal.getContractSummary:{"contractId":"${s.contract.id}"}]] [[RESPOSTA:A versão 2 tem a Cláusula 3 — foro [3].]]`);
    assert.equal(resumo.answer.includes(DRAFT_MARK), false);
  });
});

test('m9d038_minuta_vira_proposta_e_nao_cria_contrato_sozinha', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const contratos = () => H.contar('SELECT count(*)::int AS n FROM legal.contracts', {}, tx);
    const antes = await contratos();
    const res = await H.perguntar(c, 'Rascunhe a minuta de locação [[TOOL:legal.draftContract:{"contractType":"LEASE_RESIDENTIAL"}]]', { taskType: 'minuta_juridica' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.status, 'AWAITING_APPROVAL');
    assert.equal(res.proposals.length, 1, 'a ação sugerida vira proposta para aprovação humana');
    assert.equal(await contratos(), antes, 'nenhum contrato nasce antes da aprovação');
    const [chamada] = await H.chamadas(res.runId, tx);
    assert.deepEqual([chamada.tool_name, chamada.status], ['legal.draftContract', 'PROPOSED']);
  });
});

test('m9d038_parametros_da_empresa_definem_termos_de_minuta_e_tamanho_das_listas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS, params: { 'ia.nay_juridica.termos_minuta': 'aditamento', 'ia.nay_juridica.max_itens_lista': 1 } });
    const s = await J.cenarioJuridico(tenantA, tx);
    const resumo = (texto) => `${texto} [[TOOL:legal.getContractSummary:{"contractId":"${s.contract.id}"}]] [[RESPOSTA:A versão 2 tem a Cláusula 3 — foro [3].]]`;
    // "minuta" deixou de ser termo; "aditamento" passou a ser: a marca segue o parâmetro, não o código.
    assert.equal((await H.perguntar(c, resumo('Resuma a minuta do contrato.'))).answer.includes(DRAFT_MARK), false);
    assert.ok((await H.perguntar(c, resumo('Resuma o aditamento do contrato.'))).answer.startsWith(DRAFT_MARK));
    // Com no máximo 1 item por lista, a comparação traz um trecho mesmo havendo três diferenças.
    const cmp = await H.perguntar(c, `Compare [[TOOL:legal.compareVersions:{"contractId":"${s.contract.id}","fromVersion":1,"toVersion":2}]] [[RESPOSTA:ok [1]]]`);
    const saida = JSON.stringify((await H.chamadas(cmp.runId, tx))[0]);
    assert.match(saida, /"totalChanges":3/);
    assert.equal((saida.match(/"kind":"(REMOVIDA|INCLUIDA)"/g) || []).length, 1);
  });
});
