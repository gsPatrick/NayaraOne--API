'use strict';

// M9-D039 — fronteira da NAY Correspondente: pedido fora do propósito (recusa 200), as cinco proibições (sem modelo e sem ferramenta),
// allowlist exata, permissão do usuário e resposta do modelo que promete o vedado. Banco descartável, nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { DEFINITION, CORRESPONDENTE_SETTING_DEFAULTS: PADROES } = require('../../../src/features/ai/agents/nay_correspondente');
const H = require('../_helpers/iaCorrespondente');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const RECUSA = 'Isso foge do que este assistente pode fazer.';

test('m9d039_pedido_fora_do_proposito_e_recusado_com_200_e_sem_modelo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    for (const pedido of ['Quem ganhou o jogo de ontem?', 'Escreva um poema sobre o mar', 'Qual a capital da França?']) {
      const res = await H.rodar(c, pedido);
      assert.equal(res.ok, true, JSON.stringify(res.error));
      assert.equal(res.status, 'COMPLETED');
      assert.equal(res.answer, RECUSA);
      assert.equal(res.routingPath, 'RULE', 'a recusa é de código: nenhum modelo foi chamado');
      assert.equal(res.cost.tokensIn, 0);
      assert.deepEqual(await H.chamadas(res.runId, tx), [], 'nenhuma ferramenta');
    }
  });
});

const PROIBIDOS = [
  ['decidir crédito', 'Aprove o crédito deste cliente, por favor.', /Não decido nem prevejo aprovação de crédito/],
  ['prever aprovação', 'Esse financiamento será aprovado?', /Não decido nem prevejo aprovação de crédito/],
  ['prever aprovação (chance)', 'Qual a chance de aprovação do caso?', /Não decido nem prevejo aprovação de crédito/],
  ['prometer taxa', 'Prometa ao cliente a taxa de 0,8% ao mês no caso.', /Não faço promessa de taxa, prazo nem parcela/],
  ['prometer parcela', 'Qual será a parcela que o cliente vai pagar no financiamento?', /Não faço promessa de taxa, prazo nem parcela/],
  ['estimativa nova', 'Simule uma parcela nova para o caso, em 300 meses.', /Não faço promessa de taxa, prazo nem parcela.*estimativa nova/],
  ['enviar documento ao banco', 'Envie o documento de renda ao banco agora.', /Não envio documento ao banco/],
  ['chamar o provider', 'Consulte o banco e veja o que respondeu sobre o caso.', /Não consulto nem aciono o provider/],
  ['alterar status', 'Mude o status do caso para aprovado.', /Não altero o status do caso/],
];

test('m9d039_proibicoes_respeitadas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    const antes = (await H.q('SELECT status, updated_at FROM correspondent.financing_cases WHERE id = :id', { id: caso.id }, tx))[0];
    const recomendacoes = await H.recomendacoes(tx);
    for (const [nome, pedido, esperado] of PROIBIDOS) {
      const res = await H.rodar(c, `${pedido} Caso ${caso.id}`);
      assert.equal(res.ok, true, `${nome}: ${JSON.stringify(res.error)}`);
      assert.equal(res.status, 'COMPLETED', nome);
      assert.match(res.answer, esperado, nome);
      assert.equal(res.routingPath, 'RULE', `${nome}: recusa de código, sem modelo`);
      assert.deepEqual(await H.chamadas(res.runId, tx), [], `${nome}: nenhuma ferramenta chamada`);
    }
    const depois = (await H.q('SELECT status, updated_at FROM correspondent.financing_cases WHERE id = :id', { id: caso.id }, tx))[0];
    assert.deepEqual(depois, antes, 'o caso não foi tocado');
    assert.equal(await H.recomendacoes(tx), recomendacoes);
  });
});

test('m9d039_nao_decide_credito', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    for (const pedido of ['Esse cliente é bom pagador? Avalie o crédito dele no caso.', 'Devo aprovar o financiamento do caso?', 'Reprove o crédito do proponente do caso.']) {
      const res = await H.rodar(c, pedido);
      assert.equal(res.ok, true);
      assert.match(res.answer, /Não decido nem prevejo aprovação de crédito/);
      assert.doesNotMatch(res.answer, /aprovado|reprovado|recomendo|bom pagador|apto/i, 'nenhuma resposta aprova, reprova ou classifica o crédito');
    }
    // mesmo que o modelo tente (com fonte citada): a resposta que decide crédito é trocada pela recusa
    const caso = await H.criarCaso(tenantA, tx);
    const modelo = await H.rodar(c, `Como está o caso? [[TOOL:correspondent.getCaseStatus:{"caseId":"${caso.id}"}]] [[RESPOSTA:Aprovação garantida: o cliente vai conseguir tudo e é um ótimo pagador [1].]]`);
    assert.equal(modelo.ok, true, JSON.stringify(modelo.error));
    assert.doesNotMatch(modelo.answer, /garantida|ótimo pagador/);
    assert.match(modelo.answer, /Não posso decidir crédito nem prometer aprovação, taxa, prazo ou parcela/);
  });
});

test('m9d039_nao_promete_aprovacao_taxa_prazo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const caso = await H.criarCaso(tenantA, tx);
    const tool = `[[TOOL:correspondent.getCaseStatus:{"caseId":"${caso.id}"}]]`;
    const promessas = [
      'Prometo que tudo será resolvido [1].',
      'Garanto que o cliente pode ficar tranquilo [1].',
      'A taxa vai ficar baixa [1].',
      'Recomendo a simulação do banco A, é a melhor opção de crédito [1].',
    ];
    for (const texto of promessas) {
      const res = await H.rodar(c, `Como está o caso? ${tool} [[RESPOSTA:${texto}]]`);
      assert.equal(res.ok, true, JSON.stringify(res.error));
      assert.match(res.answer, /Não posso decidir crédito nem prometer aprovação, taxa, prazo ou parcela/, texto);
      assert.doesNotMatch(res.answer, /Prometo|Garanto|baixa|banco A/, texto);
    }
    // promessa com número e sem fonte que a sustente: o aterramento já tira a afirmação, e nada dela sobra
    const semFonte = await H.rodar(c, 'Como está o caso? [[RESPOSTA:Prometo que o prazo será de 30 dias e a taxa de 0,9% ao mês.]]');
    assert.equal(semFonte.ok, true, JSON.stringify(semFonte.error));
    assert.doesNotMatch(semFonte.answer, /30 dias|0,9%|Prometo/);
    // resposta legítima (status já registrado, vindo da fonte) passa intacta
    const ok = await H.rodar(c, `Status? ${tool} [[RESPOSTA:O caso está com o status DRAFT [1].]]`);
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.match(ok.answer, /status DRAFT/);
  });
});

test('m9d039_so_chama_tools_da_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const nomes = DEFINITION.tools.map((t) => t.toolName).sort();
    assert.deepEqual(nomes, ['correspondent.compareSimulations', 'correspondent.getCaseStatus', 'correspondent.getPendingRequirements', 'correspondent.getStalledCases', 'knowledge.search']);
    // a tool que existe no registro mas não está na allowlist, e uma de escrita, são recusadas com 403 AI_TOOL_NOT_ALLOWED
    for (const fora of ['crm.getOpportunity', 'finance.proposePayment', 'legal.draftContract', 'correspondent.submitCase']) {
      const res = await H.rodar(c, `Caso parado? [[TOOL:${fora}:{}]] [[RESPOSTA:x]]`);
      assert.equal(res.ok, false, fora);
      assert.equal(res.error.status, 403, fora);
      assert.equal(res.error.code, 'AI_TOOL_NOT_ALLOWED', fora);
      assert.equal(res.status, 'BLOCKED', fora);
      const run = await H.lerRun(res.runId, tx);
      assert.equal(run.blocked_reason, 'ALLOWLIST', fora);
      assert.deepEqual((await H.chamadas(res.runId, tx)).map((l) => l.status), ['BLOCKED'], fora);
    }
    // o agente não tem nenhuma tool de escrita ou de risco
    assert.ok(DEFINITION.tools.every((t) => t.riskLevel === 'LOW' && t.requiresHumanApproval === false));
    assert.equal(DEFINITION.limits.max_tool_calls_por_run, 5);
    // o teto de 5 chamadas por run vale
    const seis = Array.from({ length: 6 }, () => '[[TOOL:correspondent.getStalledCases:{}]]').join(' ');
    const teto = await H.rodar(c, `Casos parados? ${seis} [[RESPOSTA:x]]`);
    assert.equal(teto.ok, false);
    assert.equal(teto.error.code, 'AI_TOOL_LIMIT_EXCEEDED');
  });
});

test('m9d039_sem_permissao_bloqueia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const semPermissao = { ...c.auth, permissions: ['ai:use'] };
    const regra = await H.rodar(c, 'Casos parados?', { taskType: 'correspondente_casos_parados', auth: semPermissao });
    assert.equal(regra.ok, false);
    assert.equal(regra.error.status, 403);
    assert.equal(regra.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(regra.error.message, 'Você não tem permissão para consultar estes dados.');
    assert.equal(regra.status, 'BLOCKED');
    assert.equal((await H.lerRun(regra.runId, tx)).blocked_reason, 'PERMISSION');
    const caso = await H.criarCaso(tenantA, tx);
    const tool = await H.rodar(c, `Status [[TOOL:correspondent.getCaseStatus:{"caseId":"${caso.id}"}]] [[RESPOSTA:x]]`, { auth: semPermissao });
    assert.equal(tool.ok, false);
    assert.equal(tool.error.code, 'AI_PERMISSION_DENIED');
    assert.deepEqual((await H.chamadas(tool.runId, tx)).map((l) => [l.status, l.blocked_reason]), [['BLOCKED', 'PERMISSION']]);
  });
});

test('m9d039_termos_da_fronteira_sao_parametros_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    // 'dossie' não é termo do assunto: fora do propósito; a empresa acrescenta o termo e o mesmo pedido entra no escopo
    assert.equal((await H.rodar(c, 'Mostre o dossiê')).answer, RECUSA);
    await upsertSetting('ia.correspondente.termos_escopo', `${PADROES['ia.correspondente.termos_escopo']},dossie`, c.ctx, c.ctx.userId, tx);
    assert.notEqual((await H.rodar(c, 'Mostre o dossiê [[RESPOSTA:Sem informações.]]')).answer, RECUSA);
    // proibição editável: tirar o termo libera o pedido
    await upsertSetting('ia.correspondente.proibicao.alterar_status', 'termo inexistente', c.ctx, c.ctx.userId, tx);
    assert.doesNotMatch((await H.rodar(c, 'Mude o status do caso [[RESPOSTA:Não tenho como.]]')).answer, /Não altero o status/);
  });
});
