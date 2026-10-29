'use strict';

// M9-D046 — ai.release_gates: registro do item (escopo, evidência, idempotência, auditoria), isolamento por empresa/grupo e RLS FORCE.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const K = require('../_helpers/iaPortaoProducao');

let tenantA; let tenantB;
before(async () => { ({ tenantA, tenantB } = await K.prepararTenants()); await K.carregarPessoas(); });
after(async () => { await K.sequelize.close(); });

test('m9d046_registro_valida_escopo_status_e_evidencia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = K.ctxAdmin(tenantA);
    const recusa = async (body, code) => assert.equal((await K.service.register(ctx, body, tx).then(() => null, (e) => e)).code, code, JSON.stringify(body));
    await recusa({ item: 'NADA' }, 'AI_GATE_INVALID');
    await recusa({ item: 'RED_TEAM', scopeRef: 'x' }, 'AI_GATE_INVALID');
    await recusa({ item: 'AGENT_EVALUATION' }, 'AI_GATE_INVALID');
    await recusa({ item: 'PROVIDER_REVIEW', scopeRef: 'a b' }, 'AI_GATE_INVALID');
    await recusa({ item: 'PENTEST', status: 'TALVEZ' }, 'AI_GATE_INVALID');
    await recusa({ item: 'PENTEST', level: 'MUNDO' }, 'AI_GATE_INVALID');
    await recusa({ item: 'LAB_VALIDATION', status: 'APPROVED' }, 'AI_GATE_EVIDENCE_REQUIRED');
    await recusa(null, 'AI_GATE_INVALID');
    const ok = await K.service.register(ctx, { item: 'LAB_VALIDATION', status: 'APPROVED', evidenceRef: 'relatorio-lab-20261029', notes: 'ok' }, tx);
    assert.equal(ok.gate.status, 'APPROVED');
    assert.equal(ok.gate.approvedBy, tenantA.userId);
    assert.ok(ok.gate.approvedAt);
    assert.equal(ok.gate.level, 'COMPANY');
  });
});

test('m9d046_registrar_de_novo_atualiza_a_mesma_linha_e_audita_antes_e_depois', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = K.ctxAdmin(tenantA);
    const a = await K.service.register(ctx, { item: 'PENTEST', status: 'PENDING' }, tx);
    const b = await K.service.register(ctx, { item: 'PENTEST', status: 'APPROVED', evidenceRef: 'pentest-2026' }, tx);
    assert.equal(b.gate.id, a.gate.id, 'uma linha por (empresa, escopo, item)');
    const c = await K.service.register(ctx, { item: 'PENTEST', status: 'REJECTED' }, tx);
    assert.equal(c.gate.approvedBy, null, 'REJECTED não guarda aprovador');
    const audit = await K.q("SELECT action, before_json, after_json FROM audit.audit_log WHERE entity_type = 'AiReleaseGate' AND entity_id = :id ORDER BY created_at, id", { id: a.gate.id }, tx);
    assert.deepEqual(audit.map((x) => x.action), ['ai.release_gate.created', 'ai.release_gate.updated', 'ai.release_gate.updated']);
    assert.equal(audit[1].before_json.status, 'PENDING');
    assert.equal(audit[1].after_json.status, 'APPROVED');
    assert.ok(!JSON.stringify(audit).includes('pentest-2026'), 'a auditoria não guarda a referência da evidência nem o texto livre');
  });
});

test('m9d046_idempotency_key_repetida_devolve_a_mesma_linha', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = K.ctxAdmin(tenantA);
    const primeira = await K.service.register(ctx, { item: 'RED_TEAM', status: 'APPROVED', idempotencyKey: 'k-d046-1' }, tx);
    assert.equal(primeira.replayed, false);
    const repetida = await K.service.register(ctx, { item: 'RED_TEAM', status: 'REJECTED', idempotencyKey: 'k-d046-1' }, tx);
    assert.equal(repetida.replayed, true);
    assert.equal(repetida.gate.id, primeira.gate.id);
    assert.equal(repetida.gate.status, 'APPROVED', 'repetir não altera o resultado');
  });
});

test('m9d046_isolamento_entre_empresas_e_aprovacao_do_grupo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = K.ctxAdmin(tenantA);
    await K.service.register(ctx, { item: 'PRIVACY_REVIEW', status: 'APPROVED' }, tx);
    await K.service.register(ctx, { item: 'PENTEST', status: 'APPROVED', level: 'GROUP' }, tx);
    const vistaA = await K.service.list(ctx, {}, tx);
    assert.deepEqual(vistaA.gates.map((g) => [g.item, g.level]).sort(), [['PENTEST', 'GROUP'], ['PRIVACY_REVIEW', 'COMPANY']]);
    assert.equal(vistaA.environment, 'LAB');
    assert.equal(vistaA.complete, false);
    assert.ok(vistaA.missing.includes('DEV_DEPLOY') && !vistaA.missing.includes('PENTEST'));
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    // Outro grupo: nada do grupo de A aparece; a empresa B não enxerga a linha COMPANY de A.
    assert.deepEqual((await K.service.list(K.ctxAdmin(tenantB), {}, tx)).gates, []);
  });
});

test('m9d046_rls_force_e_politica_na_tabela', async () => {
  const [t] = await K.q(
    `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'release_gates'`
  );
  assert.deepEqual([t.relrowsecurity, t.relforcerowsecurity, t.policies], [true, true, ['tenant_isolation']]);
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const err = await K.sequelize.query(
      'INSERT INTO ai.release_gates (group_id, company_id, scope_type, item, status) VALUES (:g, :c, \'GLOBAL\', \'PENTEST\', \'PENDING\')',
      { replacements: { g: tenantA.groupId, c: tenantB.companyId }, transaction: tx }
    ).then(() => null, (e) => e);
    assert.ok(err, 'a empresa A não grava linha da empresa B (RLS WITH CHECK)');
  });
});
