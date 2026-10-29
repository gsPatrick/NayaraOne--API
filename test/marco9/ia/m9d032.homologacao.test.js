'use strict';

// M9-D032 — AI-015: avaliação verde só torna a versão "elegível"; ativar exige homologação humana da avaliação por pessoa
// diferente de quem a disparou. Tudo com nayara_runtime em transação com rollback (a corrida usa o cluster descartável).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withRollbackTenantTransaction, withTenantTransaction } = require('../../testHelpers');
const agents = require('../../../src/features/ai/agents');
const { AiEvaluationService, registerCaseSource } = require('../../../src/features/ai/evaluations');
const H = require('../_helpers/iaAvaliacao');
const { SKIP, admin } = require('../_helpers/aiHttpEnv');

const svc = new AiEvaluationService();
let tenantA;
let pessoas;
before(async () => {
  ({ tenantA } = await H.prepararTenants());
  await H.carregarPessoas();
  pessoas = [H.ctxDe(tenantA), H.ctxDe(tenantA), H.ctxDe(tenantA)].map((c) => c.userId);
  assert.equal(new Set(pessoas).size, 3);
});
after(async () => { await H.sequelize.close(); });

const como = (userId, ...permissions) => ({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId, permissions });

test('inv_ai_015_avaliacao_nao_homologa_sozinha_ativacao_exige_humano', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, agenteHomolog] = pessoas;
    const alvo = H.codigoNovo();
    await agents.createVersion(como(criador), alvo, { purpose: 'Responder sobre pipeline.', systemPolicy: 'Cite as fontes.', modelPolicy: { capability: 'chat' }, dataScopes: ['crm.opportunities'], limits: {}, criticality: 'NON_CRITICAL', tools: [H.FERRAMENTA_LEITURA] }, tx);
    const ev = await H.avaliar(svc, como(disparador, 'ai:evaluate'), tx, { agentCode: alvo, suite: 'all' });
    assert.equal(ev.status, 'PASSED');
    // A versão passa na avaliação e pode ser HOMOLOGADA como versão (ciclo da D004), mas isso não a ativa.
    await agents.homologate(como(agenteHomolog), alvo, 1, { note: 'ok' }, tx);
    await H.rejeita(agents.activate(como(disparador), alvo, 1, tx), 409, 'AI_AGENT_NOT_HOMOLOGATED');
    const aindaHomologada = await agents.getVersion(como(criador), alvo, 1, tx);
    assert.equal(aindaHomologada.status, 'HOMOLOGATED', 'avaliação PASSED não promove a ACTIVE');
    // Uma pessoa homologa a avaliação; só então a ativação passa.
    const h = await svc.homologate(como(criador, 'ai:evaluate'), ev.id, { note: 'conferi os casos' }, tx);
    assert.equal(h.replayed, false);
    assert.equal(h.evaluation.homologatedBy, criador);
    const ativa = await agents.activate(como(disparador), alvo, 1, tx);
    assert.equal(ativa.status, 'ACTIVE');
  });
});

test('inv_ai_015_alto_impacto_exige_mesmo_com_avaliacao_dispensada_e_parametro_todos', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [criador, disparador, agenteHomolog] = pessoas;
    const ctx = como(criador);
    await H.dispensarAvaliacaoVerde(ctx, tx);
    // agente comum com a exigência dispensada: ativa sem avaliação nenhuma
    const comum = H.codigoNovo();
    await agents.createVersion(ctx, comum, { purpose: 'Comum.', systemPolicy: 'x', modelPolicy: {}, dataScopes: [], limits: {}, criticality: 'NON_CRITICAL', tools: [H.FERRAMENTA_LEITURA] }, tx);
    await agents.homologate(como(agenteHomolog), comum, 1, {}, tx);
    assert.equal((await agents.activate(como(disparador), comum, 1, tx)).status, 'ACTIVE');
    // agente com tool HIGH é de alto impacto: a dispensa não vale
    const alto = H.codigoNovo();
    await agents.createVersion(ctx, alto, { purpose: 'Alto impacto.', systemPolicy: 'x', modelPolicy: {}, dataScopes: [], limits: {}, criticality: 'NON_CRITICAL', tools: [H.FERRAMENTA_ALTA] }, tx);
    await agents.homologate(como(agenteHomolog), alto, 1, {}, tx);
    await H.rejeita(agents.activate(como(disparador), alto, 1, tx), 409, 'AI_AGENT_NOT_HOMOLOGATED');
    // com a exigência verde ligada e `homologacao_humana_todos` desligado, o agente comum não exige a homologação da avaliação
    await H.ajustar('ia.agente.avaliacao_verde_obrigatoria', true, ctx, tx);
    await H.ajustar('ia.avaliacao.homologacao_humana_todos', false, ctx, tx);
    const outro = H.codigoNovo();
    await agents.createVersion(ctx, outro, { purpose: 'Outro.', systemPolicy: 'x', modelPolicy: {}, dataScopes: [], limits: {}, criticality: 'NON_CRITICAL', tools: [H.FERRAMENTA_LEITURA] }, tx);
    await H.avaliar(svc, como(disparador, 'ai:evaluate'), tx, { agentCode: outro, suite: 'all' });
    await agents.homologate(como(agenteHomolog), outro, 1, {}, tx);
    assert.equal((await agents.activate(como(disparador), outro, 1, tx)).status, 'ACTIVE');
    // ligado de novo (padrão), a mesma situação em outro agente é recusada
    await H.ajustar('ia.avaliacao.homologacao_humana_todos', true, ctx, tx);
    const quarto = H.codigoNovo();
    await agents.createVersion(ctx, quarto, { purpose: 'Quarto.', systemPolicy: 'x', modelPolicy: {}, dataScopes: [], limits: {}, criticality: 'NON_CRITICAL', tools: [H.FERRAMENTA_LEITURA] }, tx);
    await H.avaliar(svc, como(disparador, 'ai:evaluate'), tx, { agentCode: quarto, suite: 'all' });
    await agents.homologate(como(agenteHomolog), quarto, 1, {}, tx);
    await H.rejeita(agents.activate(como(disparador), quarto, 1, tx), 409, 'AI_AGENT_NOT_HOMOLOGATED');
  });
});

test('inv_ai_015_nenhum_codigo_de_avaliacao_ativa_versao', () => {
  const dir = path.join(__dirname, '../../../src/features/ai/evaluations');
  const arquivos = [];
  const varrer = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? varrer(path.join(d, e.name)) : arquivos.push(path.join(d, e.name))));
  varrer(dir);
  for (const arq of arquivos.filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(arq, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /markActive|markHomologated|agentLifecycle|\.activate\(|status\s*=\s*'ACTIVE'/, `${path.basename(arq)} não pode ativar nem homologar versão de agente`);
  }
});

test('m9d032_homologacao_exige_outra_pessoa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [disparador, outra, terceira] = pessoas;
    const { code } = await H.criarAgente(tenantA, tx);
    const ev = await H.avaliar(svc, como(disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all' });
    assert.equal(ev.triggeredBy, disparador);
    const proprio = await H.rejeita(svc.homologate(como(disparador, 'ai:evaluate'), ev.id, { note: 'eu mesmo' }, tx), 403, 'AI_HOMOLOGATION_SELF_BLOCKED');
    assert.equal(proprio.message, 'Quem disparou a avaliação não pode homologá-la.');
    // o banco também recusa: homologador igual ao disparador
    await H.expectDbError(tx, 'UPDATE ai.evaluations SET homologated_by = :u, homologated_at = now() WHERE id = :id', { u: disparador, id: ev.id }, /evaluations_homologation_segregation_chk/);
    // identidade de serviço nunca homologa
    await H.rejeita(svc.homologate({ ...como(outra, 'ai:evaluate'), serviceIdentity: true }, ev.id, {}, tx), 403, 'AI_EVALUATION_HUMAN_ONLY');
    const ok = await svc.homologate(como(outra, 'ai:evaluate'), ev.id, { note: 'conferi' }, tx);
    assert.equal(ok.evaluation.homologatedBy, outra); assert.equal(ok.evaluation.homologationNote, 'conferi'); assert.ok(ok.evaluation.homologatedAt);
    assert.equal((await svc.homologate(como(outra, 'ai:evaluate'), ev.id, {}, tx)).replayed, true);
    await H.rejeita(svc.homologate(como(terceira, 'ai:evaluate'), ev.id, {}, tx), 409, 'AI_EVALUATION_STATE');
    const auditoria = await H.q("SELECT action FROM audit.audit_log WHERE entity_type = 'AiEvaluation' AND entity_id = :id ORDER BY created_at", { id: ev.id }, tx);
    assert.ok(auditoria.some((a) => a.action === 'ai.evaluation.homologated'));
    const eventos = await H.q("SELECT 1 FROM integration.outbox_events WHERE event_type = 'ai.evaluation.homologated' AND aggregate_id = :id", { id: ev.id }, tx);
    assert.equal(eventos.length, 1);
  });
});

test('m9d032_homologar_avaliacao_reprovada_409_e_nota_de_alto_impacto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [disparador, outra] = pessoas;
    const { code } = await H.criarAgente(tenantA, tx, { tools: [] });
    const sai = registerCaseSource(() => [{ id: 'HALLUCINATION:falha', category: 'HALLUCINATION', suite: 'GOLDEN', input: '[[ECO]] O saldo é R$ 10,00 [1].', sources: [{ sourceType: 'READ_MODEL', title: 'Saldo', excerpt: 'Saldo R$ 10,00.', relevanceScore: 1 }] }]);
    try {
      const reprovada = await H.avaliar(svc, como(disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'golden' });
      assert.equal(reprovada.status, 'FAILED');
      const err = await H.rejeita(svc.homologate(como(outra, 'ai:evaluate'), reprovada.id, {}, tx), 409, 'AI_EVALUATION_NOT_PASSED');
      assert.equal(err.message, 'A avaliação não passou e não pode ser homologada.');
    } finally { sai(); }
    // agente de alto impacto: a nota é obrigatória
    const { code: alto } = await H.criarAgente(tenantA, tx, { tools: [H.FERRAMENTA_ALTA] });
    const ev = await H.avaliar(svc, como(disparador, 'ai:evaluate'), tx, { agentCode: alto, suite: 'all' });
    assert.equal(ev.status, 'PASSED', JSON.stringify(ev.metrics));
    await H.rejeita(svc.homologate(como(outra, 'ai:evaluate'), ev.id, {}, tx), 400, 'AI_HOMOLOGATION_NOTE_REQUIRED');
    assert.equal((await svc.homologate(como(outra, 'ai:evaluate'), ev.id, { note: 'revisado pelo jurídico' }, tx)).evaluation.homologationNote, 'revisado pelo jurídico');
    // avaliação de outra empresa ou inexistente: 404 igual
    await H.rejeita(svc.homologate(como(outra, 'ai:evaluate'), H.uid(), {}, tx), 404, 'AI_EVALUATION_NOT_FOUND');
  });
});

test('m9d032_homologacao_duas_conexoes_so_uma_vence', { skip: SKIP }, async () => {
  const [disparador, a, b] = pessoas;
  const code = H.codigoNovo();
  const id = H.uid();
  await admin(
    "INSERT INTO ai.evaluations (id, group_id, company_id, agent_code, agent_version, suite, status, triggered_by) VALUES ($1, $2, $3, $4, 1, 'ALL', 'PASSED', $5)",
    [id, tenantA.groupId, tenantA.companyId, code, disparador]
  );
  try {
    const tentar = (userId) => withTenantTransaction(tenantA, (tx) => svc.homologate(como(userId, 'ai:evaluate'), id, { note: 'ok' }, tx)).then((r) => ({ ok: r }), (e) => ({ erro: e }));
    const [r1, r2] = await Promise.all([tentar(a), tentar(b)]);
    const vencedoras = [r1, r2].filter((r) => r.ok && !r.ok.replayed);
    const perdedoras = [r1, r2].filter((r) => r.erro);
    assert.equal(vencedoras.length, 1, JSON.stringify([r1, r2]));
    assert.equal(perdedoras.length, 1);
    assert.equal(perdedoras[0].erro.code, 'AI_EVALUATION_STATE');
    const { rows } = await admin('SELECT homologated_by FROM ai.evaluations WHERE id = $1', [id]);
    assert.ok([a, b].includes(rows[0].homologated_by));
  } finally {
    await admin("DELETE FROM audit.audit_log WHERE entity_type = 'AiEvaluation' AND entity_id = $1", [id]).catch(() => {});
    await admin("DELETE FROM integration.outbox_events WHERE aggregate_id = $1", [id]).catch(() => {});
    await admin('DELETE FROM ai.evaluations WHERE id = $1', [id]);
  }
});
