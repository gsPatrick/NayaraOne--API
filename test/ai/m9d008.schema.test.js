'use strict';

// M9-D008 — ai.knowledge_entries no banco: colunas, CHECKs, índice único parcial de versão homologada, RLS e GRANT.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../testHelpers');
const { sequelize, uid, q, run, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../helpers/aiRuns');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const COLUNAS = ['version', 'status', 'homologated_by', 'homologated_at', 'revoked_by', 'revoked_at', 'revoke_reason', 'content_hash', 'owner_user_id', 'source_id', 'title', 'body_structured'];

async function inserir(tx, fk, over = {}) {
  const id = uid();
  await run(
    `INSERT INTO ai.knowledge_entries (id, group_id, company_id, subject_type, fact_key, fact_value_json, classification, version, title, content_hash, created_by)
     VALUES (:id, :g, :c, 'politica', :fk, '{"a":1}'::jsonb, :cls, :v, 'T', repeat('b', 64), :by)`,
    { id, g: tenantA.groupId, c: tenantA.companyId, fk, cls: over.cls || 'INTERNAL', v: over.version || 1, by: over.by || null }, tx
  );
  return id;
}

test('m9d008_migrations_criam_colunas_checks_gatilho_rls_force_e_grant', async () => {
  const achadas = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'knowledge_entries'")).map((r) => r.column_name);
  for (const c of COLUNAS) assert.ok(achadas.includes(c), `ai.knowledge_entries.${c} não existe`);
  const [r] = await q(
    `SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege('nayara_runtime', c.oid, 'INSERT') AS ins, has_table_privilege('nayara_runtime', c.oid, 'UPDATE') AS upd
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'knowledge_entries'`
  );
  assert.equal(r.relrowsecurity, true); assert.equal(r.relforcerowsecurity, true); assert.ok(r.ins && r.upd);
  const [{ n }] = await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'ai.knowledge_entries'::regclass AND NOT tgisinternal");
  assert.ok(n >= 1);
});

test('m9d008_banco_unicidade_checks_e_classificacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const pessoas = [ctxDe(tenantA).userId, ctxDe(tenantA).userId];
    const fk = `fato.${uid().slice(0, 8)}`;
    const v1 = await inserir(tx, fk, { by: pessoas[0] });
    await expectDbError(tx, `INSERT INTO ai.knowledge_entries (id, group_id, company_id, subject_type, fact_key, fact_value_json, version, title, content_hash)
      VALUES (:id, :g, :c, 'politica', :fk, '{}'::jsonb, 1, 'T', repeat('b', 64))`, { id: uid(), g: tenantA.groupId, c: tenantA.companyId, fk }, /ai_knowledge_fact_version_uq/);
    await expectDbError(tx, `INSERT INTO ai.knowledge_entries (id, group_id, company_id, subject_type, fact_key, fact_value_json, classification, version, title, content_hash)
      VALUES (:id, :g, :c, 'politica', :fk, '{}'::jsonb, 'SECRETO', 9, 'T', repeat('b', 64))`, { id: uid(), g: tenantA.groupId, c: tenantA.companyId, fk }, /knowledge_classification_chk/);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'HOMOLOGATED' WHERE id = :id", { id: v1 }, /AI_KNOWLEDGE_NOT_HOMOLOGATED|knowledge_homologation_chk/);
    // Duas homologadas do mesmo fact_key: o índice único parcial recusa a segunda.
    const v2 = await inserir(tx, fk, { version: 2, by: pessoas[0] });
    await run("UPDATE ai.knowledge_entries SET status = 'HOMOLOGATED', homologated_by = :u, homologated_at = now() WHERE id = :id", { id: v1, u: pessoas[1] }, tx);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'HOMOLOGATED', homologated_by = :u, homologated_at = now() WHERE id = :id", { id: v2, u: pessoas[1] }, /ai_knowledge_one_homologated_uq/);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'REVOKED', revoked_by = :u, revoked_at = now() WHERE id = :id", { id: v1, u: pessoas[1] }, /knowledge_revocation_chk/);
  });
});
