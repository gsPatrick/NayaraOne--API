'use strict';

// M9-D032 — feedback humano (UP/DOWN) sobre um run: grava, redige, vira candidato PENDENTE na fila do golden dataset e NUNCA altera
// prompt, regra, permissão, modelo nem allowlist. A fila só avança por decisão de uma pessoa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const H = require('../_helpers/iaAvaliacao');

const svc = new AiEvaluationService();
let tenantA;
let pessoas;
before(async () => {
  ({ tenantA } = await H.prepararTenants());
  await H.carregarPessoas();
  pessoas = [H.ctxDe(tenantA), H.ctxDe(tenantA), H.ctxDe(tenantA)].map((c) => c.userId);
});
after(async () => { await H.sequelize.close(); });

const como = (userId, ...permissions) => ({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId, permissions });

async function fotografia(tx) {
  const [agentes] = await H.q("SELECT count(*)::int AS n, md5(string_agg(config_hash || status || coalesce(system_policy,''), ',' ORDER BY id)) AS h FROM ai.agents WHERE company_id = :c", { c: tenantA.companyId }, tx);
  const [tools] = await H.q('SELECT count(*)::int AS n, md5(string_agg(tool_name || permission_code || enabled::text, \',\' ORDER BY id)) AS h FROM ai.agent_tools WHERE company_id = :c', { c: tenantA.companyId }, tx);
  const [config] = await H.q('SELECT count(*)::int AS n, md5(string_agg(key || value::text, \',\' ORDER BY key)) AS h FROM core.tenant_settings WHERE company_id = :c', { c: tenantA.companyId }, tx);
  return { agentes, tools, config };
}

test('m9d032_feedback_nao_altera_regra', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [dono] = pessoas;
    const { code } = await H.criarAgente(tenantA, tx);
    const runId = await H.inserirRunDe(tenantA, dono, tx, code);
    const antes = await fotografia(tx);
    const r = await svc.feedback(como(dono, 'ai:use'), runId, { rating: 'down', category: 'INCORRETA', comment: 'Resposta errada. Meu CPF é 123.456.789-09 e o e-mail a@b.com' }, tx);
    assert.equal(r.replaced, false);
    assert.equal(r.feedback.rating, 'DOWN');
    assert.doesNotMatch(r.feedback.comment, /123\.456\.789-09|a@b\.com/, 'comentário redigido');
    assert.match(r.feedback.comment, /REDIGIDO/);
    assert.deepEqual(await fotografia(tx), antes, 'feedback não muda agente, allowlist nem configuração');
    // repetir da mesma pessoa atualiza a mesma linha (um feedback por run e pessoa)
    const de = await svc.feedback(como(dono, 'ai:use'), runId, { rating: 'UP' }, tx);
    assert.equal(de.replaced, true); assert.equal(de.feedback.id, r.feedback.id); assert.equal(de.feedback.rating, 'UP');
    assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.feedback WHERE run_id = :r', { r: runId }, tx))[0].n, 1);
    // validações
    await H.rejeita(svc.feedback(como(dono, 'ai:use'), runId, { rating: 'MEH' }, tx), 400, 'AI_FEEDBACK_INVALID');
    await H.rejeita(svc.feedback(como(dono, 'ai:use'), runId, { rating: 'UP', comment: 'x'.repeat(501) }, tx), 400, 'AI_FEEDBACK_INVALID');
    // run de outra pessoa: 404; com ai:audit pode
    await H.rejeita(svc.feedback(como(pessoas[1], 'ai:use'), runId, { rating: 'UP' }, tx), 404, 'AI_RUN_NOT_FOUND');
    assert.equal((await svc.feedback(como(pessoas[1], 'ai:use', 'ai:audit'), runId, { rating: 'UP' }, tx)).replaced, false);
    await H.rejeita(svc.feedback(como(dono, 'ai:use'), H.uid(), { rating: 'UP' }, tx), 404, 'AI_RUN_NOT_FOUND');
    const eventos = await H.q("SELECT 1 FROM integration.outbox_events WHERE event_type = 'ai.feedback.recorded' AND aggregate_id = :id", { id: r.feedback.id }, tx);
    assert.ok(eventos.length >= 1);
  });
});

test('m9d032_feedback_nao_importa_servico_que_altere_regra', () => {
  const dir = path.join(__dirname, '../../../src/features/ai/evaluations/feedback');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /require\([^)]*(agents|settings|knowledge|tools|recommendations|serviceIdentities)[^)]*\)/, `${f} não pode importar serviço que altere regra`);
  }
});

test('m9d032_feedback_vira_candidato_so_com_aprovacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [dono, revisor, outro] = pessoas;
    const runId = await H.inserirRunDe(tenantA, dono, tx, 'NAY_COMERCIAL');
    const up = await svc.feedback(como(dono, 'ai:use'), runId, { rating: 'UP' }, tx);
    assert.equal(up.candidateId, null, 'joinha não gera candidato');
    const down = await svc.feedback(como(dono, 'ai:use'), runId, { rating: 'DOWN', category: 'INCOMPLETA', comment: 'faltou a data' }, tx);
    assert.ok(down.candidateId);
    const fila = await svc.listCandidates(como(revisor, 'ai:evaluate'), { status: 'PENDING' }, tx);
    const c = fila.find((x) => x.id === down.candidateId);
    assert.equal(c.status, 'PENDING'); assert.equal(c.agentCode, 'NAY_COMERCIAL'); assert.equal(c.runId, runId);
    // repetir o DOWN não duplica o candidato
    assert.equal((await svc.feedback(como(dono, 'ai:use'), runId, { rating: 'DOWN' }, tx)).candidateId, down.candidateId);
    assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.golden_candidates WHERE feedback_id = :f', { f: down.feedback.id }, tx))[0].n, 1);
    // só pessoa decide; aprovado uma vez, não muda
    await H.rejeita(svc.approveCandidate({ ...como(revisor, 'ai:evaluate'), serviceIdentity: true }, c.id, {}, tx), 403, 'AI_EVALUATION_HUMAN_ONLY');
    const ok = await svc.approveCandidate(como(revisor, 'ai:evaluate'), c.id, { note: 'entra no dataset' }, tx);
    assert.equal(ok.candidate.status, 'APPROVED'); assert.equal(ok.candidate.decidedBy, revisor);
    assert.equal((await svc.approveCandidate(como(revisor, 'ai:evaluate'), c.id, {}, tx)).replayed, true);
    await H.rejeita(svc.rejectCandidate(como(outro, 'ai:evaluate'), c.id, {}, tx), 409, 'AI_GOLDEN_CANDIDATE_STATE');
    await H.expectDbError(tx, "UPDATE ai.golden_candidates SET status = 'REJECTED' WHERE id = :id", { id: c.id }, /AI_GOLDEN_CANDIDATE_DECIDED/);
    await H.rejeita(svc.approveCandidate(como(revisor, 'ai:evaluate'), H.uid(), {}, tx), 404, 'AI_GOLDEN_CANDIDATE_NOT_FOUND');
    // enquanto PENDENTE nada entra em dataset algum: nenhuma tabela de dataset é escrita por este fluxo
    const pend = (await svc.feedback(como(dono, 'ai:use', 'ai:audit'), await H.inserirRunDe(tenantA, dono, tx), { rating: 'DOWN' }, tx)).candidateId;
    assert.equal((await svc.listCandidates(como(revisor, 'ai:evaluate'), { status: 'APPROVED' }, tx)).some((x) => x.id === pend), false);
  });
});
