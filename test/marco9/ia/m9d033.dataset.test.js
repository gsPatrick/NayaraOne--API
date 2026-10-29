'use strict';

// M9-D033 — golden dataset por agente: categorias cobertas, versionado e imutável (gatilho), dados sintéticos, isolamento entre
// empresas, candidato aprovado e a avaliação rodando o dataset pela porta registerCaseSource. nayara_runtime (RLS real), com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const G = require('../_helpers/iaGolden');
const { linhasDoSeed, AGENTES } = require('../../../migrations/_helpers/aiGoldenSeed');
const { piiTypesIn } = G.golden;
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenantA;
let tenantB;
let pessoas;
before(async () => {
  ({ tenantA, tenantB } = await G.prepararTenants());
  await G.carregarPessoas();
  pessoas = [G.ctxDe(tenantA), G.ctxDe(tenantA), G.ctxDe(tenantA)].map((c) => c.userId);
});
after(async () => { await G.sequelize.close(); });

const AI_EVAL = 'ai:evaluate';

test('m9d033_golden_cobre_todas_as_categorias', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Os oito agentes do sistema nascem com ao menos um caso ACTIVE por categoria aplicável (sem ferramenta: grounding, hallucination, custo, latência).
    for (const code of AGENTES) {
      const casos = await G.golden.listCases(G.como(tenantA, pessoas[0]), code, {}, tx);
      const categorias = new Set(casos.map((c) => c.category));
      for (const c of ['GROUNDING', 'HALLUCINATION', 'COST', 'LATENCY']) assert.ok(categorias.has(c), `${code} sem ${c}`);
      assert.ok(casos.every((c) => c.scope === 'SYSTEM' && c.status === 'ACTIVE'));
    }
    // Agente novo da empresa, com ferramenta: com o parâmetro de dataset próprio ligado, falta cobertura até cadastrar as seis categorias.
    const [criador, outra] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    await upsertSetting('ia.golden.exigir_dataset_cadastrado', true, G.como(tenantA, criador), criador, tx);
    const err = await G.rejeita(G.svc.request(G.como(tenantA, outra, AI_EVAL), { agentCode: code, suite: 'golden' }, tx), 409, 'AI_GOLDEN_INSUFFICIENT');
    assert.equal(err.message, 'O conjunto de testes do agente não cobre todas as categorias aplicáveis.');
    assert.deepEqual([...err.details.faltam].sort(), ['COST', 'GROUNDING', 'HALLUCINATION', 'LATENCY', 'PERMISSIONS', 'TOOL_SELECTION']);
    await G.cadastrarSeis(G.como(tenantA, criador), code, tx, ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST']);
    await G.rejeita(G.svc.request(G.como(tenantA, outra, AI_EVAL), { agentCode: code, suite: 'all' }, tx), 409, 'AI_GOLDEN_INSUFFICIENT');
    await G.golden.saveCase(G.como(tenantA, criador), code, G.CASOS.LATENCY, tx);
    const ok = await G.svc.request(G.como(tenantA, outra, AI_EVAL), { agentCode: code, suite: 'all' }, tx);
    assert.equal(ok.evaluation.status, 'QUEUED');
    // A suíte adversarial não depende do golden.
    const adv = await G.svc.request(G.como(tenantA, outra, AI_EVAL), { agentCode: code, suite: 'adversarial' }, tx);
    assert.equal(adv.evaluation.status, 'QUEUED');
  });
});

test('m9d033_golden_versionado_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    const v1 = await G.golden.saveCase(G.como(tenantA, criador), code, G.CASOS.GROUNDING, tx);
    assert.equal(v1.version, 1);
    const IMUTAVEL = /AI_GOLDEN_IMMUTABLE/;
    await G.expectDbError(tx, "UPDATE ai.golden_cases SET input = 'outra' WHERE id = :id", { id: v1.id }, IMUTAVEL);
    await G.expectDbError(tx, "UPDATE ai.golden_cases SET expected = '{}'::jsonb WHERE id = :id", { id: v1.id }, IMUTAVEL);
    await G.expectDbError(tx, 'UPDATE ai.golden_cases SET version = 9 WHERE id = :id', { id: v1.id }, IMUTAVEL);
    await G.expectDbError(tx, "UPDATE ai.golden_cases SET must_not = '[\"x\"]'::jsonb WHERE id = :id", { id: v1.id }, IMUTAVEL);
    await G.expectDbError(tx, 'DELETE FROM ai.golden_cases WHERE id = :id', { id: v1.id }, IMUTAVEL);
    // Corrigir cria a versão seguinte; a anterior é aposentada e continua legível.
    const v2 = await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.GROUNDING, expected: { contains: ['7 parcelas'] } }, tx);
    assert.equal(v2.version, 2);
    const historico = await G.golden.listCases(G.como(tenantA, criador), code, { history: true }, tx);
    assert.deepEqual(historico.map((c) => [c.version, c.status]), [[1, 'RETIRED'], [2, 'ACTIVE']]);
    // Caso aposentado não volta a ACTIVE nem muda.
    await G.expectDbError(tx, "UPDATE ai.golden_cases SET status = 'ACTIVE', retired_at = NULL WHERE id = :id", { id: v1.id }, IMUTAVEL);
    // Caso do sistema: a empresa não escreve nem aposenta (RLS).
    const sistema = (await G.golden.listCases(G.como(tenantA, criador), 'NAY_COMERCIAL', {}, tx))[0];
    await G.rejeita(G.golden.retireCase(G.como(tenantA, criador), 'NAY_COMERCIAL', sistema.caseKey, tx), 404, 'AI_GOLDEN_CASE_NOT_FOUND');
    const aposentado = await G.golden.retireCase(G.como(tenantA, criador), code, G.CASOS.GROUNDING.caseKey, tx);
    assert.equal(aposentado.status, 'RETIRED');
  });
});

test('m9d033_dados_sinteticos_sem_pii', async () => {
  // O seed do sistema e os casos de base não têm dado pessoal nem segredo.
  for (const c of linhasDoSeed()) assert.deepEqual([...piiTypesIn({ i: c.input, f: c.fixtures, e: c.expected, m: c.mustNot })], [], c.caseKey);
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    const ctx = G.como(tenantA, criador);
    const cpf = '[[ECO]] O cliente de CPF 529.982.247-25 deve R$ 100,00 [1].';
    const err = await G.rejeita(G.golden.saveCase(ctx, code, { ...G.CASOS.GROUNDING, input: cpf }, tx), 400, 'AI_GOLDEN_PII');
    assert.ok(err.details.tipos.length > 0);
    await G.rejeita(G.golden.saveCase(ctx, code, { ...G.CASOS.GROUNDING, mustNot: ['contato: pessoa.real@empresa.com.br'] }, tx), 400, 'AI_GOLDEN_PII');
    await G.rejeita(G.golden.saveCase(ctx, code, { ...G.CASOS.GROUNDING, fixtures: { sources: [{ ...G.FONTE, excerpt: 'Telefone (11) 91234-5678.' }] } }, tx), 400, 'AI_GOLDEN_PII');
    await G.rejeita(G.golden.saveCase(ctx, code, { ...G.CASOS.GROUNDING, category: 'XYZ' }, tx), 400, 'AI_GOLDEN_INVALID');
    await G.rejeita(G.golden.saveCase(ctx, code, { ...G.CASOS.GROUNDING, caseKey: 'Chave Inválida' }, tx), 400, 'AI_GOLDEN_INVALID');
    await G.rejeita(G.golden.saveCase(ctx, code, { ...G.CASOS.GROUNDING, expected: { campoSolto: 1 } }, tx), 400, 'AI_GOLDEN_INVALID');
    await G.rejeita(G.golden.saveCase(ctx, 'NAY_INEXISTENTE', G.CASOS.GROUNDING, tx), 400, 'AI_GOLDEN_INVALID');
  });
});

test('m9d033_empresa_b_nao_enxerga_golden_da_a_e_limite_por_agente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    await G.golden.saveCase(G.como(tenantA, criador), code, G.CASOS.GROUNDING, tx);
    await upsertSetting('ia.golden.max_casos_por_agente', 10, G.como(tenantA, criador), criador, tx);
    for (let i = 0; i < 9; i += 1) await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.COST, caseKey: `c_${i}` }, tx);
    await G.rejeita(G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.COST, caseKey: 'c_extra' }, tx), 409, 'AI_GOLDEN_LIMIT');
    // corrigir um caso existente (versão seguinte) não conta como novo
    assert.equal((await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.COST, caseKey: 'c_0' }, tx)).version, 2);
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const visiveis = await G.q("SELECT count(*)::int AS n FROM ai.golden_cases WHERE company_id IS NOT NULL AND company_id <> :c", { c: tenantB.companyId }, tx);
    assert.equal(visiveis[0].n, 0, 'a empresa B só enxerga os próprios casos e os do sistema');
  });
});

test('m9d033_candidato_aprovado_vira_caso_so_por_pessoa_e_uma_vez', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, revisor] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    const runId = await G.inserirRunDe(tenantA, criador, tx, code);
    const fb = G.uid();
    await G.run("INSERT INTO ai.feedback (id, group_id, company_id, run_id, user_id, rating, comment) VALUES (:id, :g, :c, :r, :u, 'DOWN', 'resposta sem fonte')", { id: fb, g: tenantA.groupId, c: tenantA.companyId, r: runId, u: criador }, tx);
    const cand = G.uid();
    await G.run("INSERT INTO ai.golden_candidates (id, group_id, company_id, feedback_id, run_id, agent_code) VALUES (:id, :g, :c, :f, :r, :a)", { id: cand, g: tenantA.groupId, c: tenantA.companyId, f: fb, r: runId, a: code }, tx);
    const ctx = G.como(tenantA, revisor, AI_EVAL);
    // pendente não entra
    await G.rejeita(G.golden.promoteCandidate(ctx, cand, G.CASOS.HALLUCINATION, tx), 409, 'AI_GOLDEN_CANDIDATE_NOT_APPROVED');
    const { decideCandidate } = require('../../../src/features/ai/evaluations');
    await decideCandidate(ctx, cand, 'APPROVED', { note: 'procede' }, tx);
    // identidade de serviço não promove
    await G.rejeita(G.golden.promoteCandidate({ ...ctx, serviceIdentity: true }, cand, G.CASOS.HALLUCINATION, tx), 400, 'AI_GOLDEN_INVALID');
    const caso = await G.golden.promoteCandidate(ctx, cand, G.CASOS.HALLUCINATION, tx);
    assert.equal(caso.sourceCandidateId, cand);
    assert.equal(caso.agentCode, code);
    await G.rejeita(G.golden.promoteCandidate(ctx, cand, { ...G.CASOS.HALLUCINATION, caseKey: 'h_outro' }, tx), 409, 'AI_GOLDEN_STATE');
    // rejeitado nunca entra
    const fb2 = G.uid();
    const run2 = await G.inserirRunDe(tenantA, criador, tx, code);
    await G.run("INSERT INTO ai.feedback (id, group_id, company_id, run_id, user_id, rating) VALUES (:id, :g, :c, :r, :u, 'DOWN')", { id: fb2, g: tenantA.groupId, c: tenantA.companyId, r: run2, u: criador }, tx);
    const cand2 = G.uid();
    await G.run("INSERT INTO ai.golden_candidates (id, group_id, company_id, feedback_id, run_id, agent_code) VALUES (:id, :g, :c, :f, :r, :a)", { id: cand2, g: tenantA.groupId, c: tenantA.companyId, f: fb2, r: run2, a: code }, tx);
    await decideCandidate(ctx, cand2, 'REJECTED', {}, tx);
    await G.rejeita(G.golden.promoteCandidate(ctx, cand2, G.CASOS.HALLUCINATION, tx), 409, 'AI_GOLDEN_CANDIDATE_NOT_APPROVED');
  });
});

test('m9d033_avaliacao_roda_o_dataset_pela_porta_registerCaseSource_com_resultado_por_categoria', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador] = pessoas;
    const { code } = await G.criarAgente(tenantA, tx, criador);
    await G.cadastrarSeis(G.como(tenantA, criador), code, tx);
    const ev = await G.avaliar(G.svc, G.como(tenantA, disparador, AI_EVAL), tx, { agentCode: code, suite: 'golden' });
    assert.equal(ev.status, 'PASSED', JSON.stringify(ev.metrics));
    const doDataset = ev.items.filter((i) => i.caseId.startsWith('golden:'));
    assert.deepEqual(doDataset.map((i) => i.category).sort(), ['COST', 'GROUNDING', 'HALLUCINATION', 'LATENCY', 'PERMISSIONS', 'TOOL_SELECTION']);
    assert.ok(doDataset.every((i) => i.passed));
    for (const c of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY']) assert.equal(ev.metrics[c].ok, true, c);
    // O caso do dataset é medido de verdade: um trecho obrigatório que a resposta não traz reprova a categoria e a avaliação inteira.
    await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.GROUNDING, expected: { contains: ['999 parcelas'] } }, tx);
    const ruim = await G.avaliar(G.svc, G.como(tenantA, disparador, AI_EVAL), tx, { agentCode: code, suite: 'golden' });
    assert.equal(ruim.status, 'FAILED');
    assert.equal(ruim.metrics.GROUNDING.ok, false);
    assert.equal(ruim.metrics.COST.ok, true);
    assert.notEqual(ruim.metrics.casesHash, ev.metrics.casesHash, 'corrigir o caso muda o conjunto avaliado');
    // Um número proibido na resposta também reprova (must_not).
    await G.golden.saveCase(G.como(tenantA, criador), code, G.CASOS.GROUNDING, tx);
    await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.GROUNDING, caseKey: 'g_proibido', mustNot: ['18.432,50'] }, tx);
    const proibido = await G.avaliar(G.svc, G.como(tenantA, disparador, AI_EVAL), tx, { agentCode: code, suite: 'golden' });
    assert.equal(proibido.status, 'FAILED');
    assert.equal(proibido.items.find((i) => i.caseId.startsWith('golden:g_proibido')).passed, false);
    // Custo acima do teto do caso reprova COST.
    await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.GROUNDING, caseKey: 'g_proibido', mustNot: [] }, tx);
    await G.golden.saveCase(G.como(tenantA, criador), code, { ...G.CASOS.COST, expected: { maxCostMicros: 1 } }, tx);
    const caro = await G.avaliar(G.svc, G.como(tenantA, disparador, AI_EVAL), tx, { agentCode: code, suite: 'golden' });
    assert.equal(caro.metrics.COST.ok, false);
    assert.equal(caro.status, 'FAILED');
  });
});
