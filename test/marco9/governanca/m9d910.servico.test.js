'use strict';

// M9-D910 — o serviço do registro: alteração auditada, política de retenção obrigatória, isolamento, classe padrão com finding, máscara do registro na anonimização (D911) e
// resolvedor do guard de DLP lendo o registro real (M9-D821). Banco descartável: ver m9d910.registro.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d910Env');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const maskSpec = require('../../../src/features/core-governance/data-quality/retention.maskSpec');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const A = () => tenants.A;
const B = () => tenants.B;
const refused = (promise) => promise.then(() => null, (err) => [err.statusCode, err.code, err.message]);
const COL = { schema: 'people', table: 'persons', column: 'preferred_name' };
const NOW = new Date('2026-03-10T15:00:00Z');

before(async () => {
  if (!env.DISPOSABLE) return;
  tenants = await env.loadTenants();
  for (const t of [A(), B()]) { await env.resetRetention(t); await env.ensure(t); }
  env.wiring.install();
});
after(async () => {
  resolver.resetResolver(); maskSpec.resetProvider();
  if (env.DISPOSABLE) for (const t of [A(), B()]) await env.resetRetention(t);
  await env.sequelize.close();
});

test('m9d910 alteração audita antes e depois, sobe a versão, marca MANUAL e PUT igual não altera nada', { skip: env.skip() }, async () => {
  const before = await env.rowOf(A(), COL.schema, COL.table, COL.column);
  const first = await env.put(A(), { ...COL, classification: 'RESTRICTED', purpose: 'SEGURANCA', masking: 'FULL', exportability: 'FORBIDDEN', ai_allowed: false });
  assert.equal(first.changed, true);
  assert.deepEqual([first.entry.classification, first.entry.version, first.entry.source, first.entry.updatedBy], ['RESTRICTED', before.version + 1, 'MANUAL', A().userId]);
  const { rows } = await env.adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.classification.changed' AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1", [A().companyId, before.id]);
  assert.deepEqual([rows[0].before_json.classification, rows[0].after_json.classification, rows[0].after_json.masking], [before.classification, 'RESTRICTED', 'FULL']);
  const same = await env.put(A(), { ...COL, classification: 'RESTRICTED', purpose: 'SEGURANCA', masking: 'FULL' });
  assert.equal(same.changed, false);
  assert.equal((await env.rowOf(A(), COL.schema, COL.table, COL.column)).version, before.version + 1, 'PUT igual não sobe a versão');
  await env.put(A(), { ...COL, classification: before.classification, purpose: before.purpose, masking: before.masking, exportability: before.exportability, ai_allowed: before.ai_allowed });
});

test('m9d910 sem retention_policy é recusada (422 GOV_CLASS_RETENTION_REQUIRED), inclusive política inexistente ou de outra empresa; coluna inexistente é 404', { skip: env.skip() }, async () => {
  const policyOfB = (await env.policyOf(B(), 'FISCAL')).id;
  assert.deepEqual(await refused(env.put(A(), { ...COL, retention_policy_id: null })), [422, 'GOV_CLASS_RETENTION_REQUIRED', 'Informe a política de retenção.']);
  assert.equal((await refused(env.put(A(), { ...COL, retention_policy_id: '00000000-0000-4000-8000-000000000000' })))[1], 'GOV_CLASS_RETENTION_REQUIRED');
  assert.equal((await refused(env.put(A(), { ...COL, retention_policy_id: policyOfB })))[1], 'GOV_CLASS_RETENTION_REQUIRED', 'política de outra empresa');
  const ok = await env.put(A(), { ...COL, retention_policy_id: (await env.policyOf(A(), 'FISCAL')).id });
  assert.equal(ok.entry.retentionPolicyId, (await env.policyOf(A(), 'FISCAL')).id);
  await env.put(A(), { ...COL, retention_policy_id: (await env.policyOf(A(), 'LEADS')).id });
  assert.deepEqual(await refused(env.put(A(), { schema: 'people', table: 'persons', column: 'nao_existe_qa', classification: 'LOW' })), [404, 'GOV_NOT_FOUND', 'Coluna não encontrada.']);
  assert.equal((await refused(env.put(A(), { ...COL, classification: 'SECRETO' })))[0], 400);
  assert.equal((await refused(env.put(A(), { ...COL, campo_novo: 1 })))[0], 400);
});

test('m9d910 isolamento entre grupos: o ajuste da empresa A não muda a B e a listagem só traz as linhas da própria empresa', { skip: env.skip() }, async () => {
  const bBefore = await env.rowOf(B(), COL.schema, COL.table, COL.column);
  await env.put(A(), { ...COL, classification: 'LOW', exportability: 'ALLOWED' });
  try {
    const bAfter = await env.rowOf(B(), COL.schema, COL.table, COL.column);
    assert.deepEqual([bAfter.classification, bAfter.version], [bBefore.classification, bBefore.version]);
    const listB = await env.inTx(B(), (tx) => env.classification.listRegistry(B(), { schema: 'people', table: 'persons', pageSize: '200' }, tx));
    assert.ok(listB.items.length > 0 && listB.items.every((row) => row.id !== undefined));
    const idsOfA = new Set((await env.adminQuery('SELECT id FROM governance.data_classification_registry WHERE company_id = $1', [A().companyId])).rows.map((r) => r.id));
    assert.equal(listB.items.some((row) => idsOfA.has(row.id)), false);
    const asB = await env.inTx(B(), (tx) => env.classification.resolveColumn(B(), COL.schema, COL.table, COL.column, tx));
    assert.equal(asB.classification, bBefore.classification);
  } finally { await env.put(A(), { ...COL, classification: (await env.rowOf(B(), COL.schema, COL.table, COL.column)).classification, exportability: bBefore.exportability }); }
});

test('m9d910 coluna sem registro resolve a classe padrão HIGH com máscara PARTIAL e gera finding de cobertura (a classe padrão é o parâmetro governanca.dlp.classificacao_padrao)', { skip: env.skip() }, async () => {
  const resolved = await env.inTx(A(), (tx) => env.classification.resolveColumn(A(), 'people', 'persons', 'qa_sem_registro_d910', tx));
  assert.deepEqual([resolved.classification, resolved.masking, resolved.isDefault, resolved.finding.code], ['HIGH', 'PARTIAL', true, 'GOV_CLASSIFICATION_MISSING']);
  const audits = await env.adminQuery("SELECT after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.classification.coverage_finding' AND after_json->>'column' = 'people.persons.qa_sem_registro_d910'", [A().companyId]);
  assert.equal(audits.rowCount, 1, 'o finding foi registrado uma vez');
  await env.inTx(A(), (tx) => env.classification.resolveColumn(A(), 'people', 'persons', 'qa_sem_registro_d910', tx));
  assert.equal((await env.adminQuery("SELECT 1 FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.classification.coverage_finding' AND after_json->>'column' = 'people.persons.qa_sem_registro_d910'", [A().companyId])).rowCount, 1, 'sem inundar a auditoria');
  await env.inTx(A(), (tx) => upsertSetting('governanca.dlp.classificacao_padrao', 'MEDIUM', A(), A().userId, tx));
  try {
    const medium = await env.inTx(A(), (tx) => env.classification.resolveColumn(A(), 'people', 'persons', 'qa_sem_registro_d910_b', tx));
    assert.equal(medium.classification, 'MEDIUM');
  } finally { await env.adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = 'governanca.dlp.classificacao_padrao'", [A().companyId]); }
  const technical = await env.inTx(A(), (tx) => env.classification.resolveColumn(A(), 'people', 'persons', 'created_at', tx));
  assert.deepEqual([technical.isTechnical, technical.finding], [true, null]);
});

test('m9d910 a anonimização de M9-D911 usa a máscara do registro via maskSpecFor (HASH do registro vira hash; sem ajuste vale FULL)', { skip: env.skip() }, async () => {
  const spec = await env.inTx(A(), (tx) => env.classification.maskSpecFor(A(), 'people', 'persons', 'legal_name', tx));
  assert.equal(typeof spec.masking, 'string');
  await env.put(A(), { schema: 'people', table: 'persons', column: 'legal_name', masking: 'HASH' });
  const tag = `${Date.now()}`;
  const hashed = await env.insertLead(A(), { name: `Carla Hash ${tag}`, taxId: `5555${tag}`.slice(0, 14), lastContact: '2023-02-01T12:00:00Z' });
  try {
    const dry = await env.dryRun(A(), { policyCodes: ['LEADS'], now: NOW });
    await env.apply(A(), dry.id, { now: NOW });
    const row = await env.personRow(hashed);
    assert.match(row.legal_name, /^[0-9a-f]+$/, 'HASH definido no registro');
    assert.equal(row.preferred_name === '[ANONIMIZADO]' || /^[0-9a-f]+$/.test(row.preferred_name), true);
    assert.notEqual(row.legal_name, `Carla Hash ${tag}`);
  } finally { await env.put(A(), { schema: 'people', table: 'persons', column: 'legal_name', masking: 'PARTIAL' }); }
});

test('m9d910 o resolvedor do guard de DLP lê o registro real: pedido misto LOW/RESTRICTED resolve RESTRICTED, recurso sem linha recebe a classe padrão', { skip: env.skip() }, async () => {
  const low = { type: 'real_estate.property_offers.asking_price' };
  const restricted = { type: 'people.persons.tax_id_normalized' };
  const resolve = (resources) => env.inTx(A(), (tx) => resolver.resolveClassification(A(), resources, tx));
  assert.equal(await resolve([low]), 'LOW');
  assert.equal(await resolve([restricted]), 'RESTRICTED');
  assert.equal(await resolve([low, restricted]), 'RESTRICTED', 'a mais alta prevalece');
  assert.equal(await resolve([{ type: 'people.persons' }]), 'RESTRICTED', 'a tabela vale pela coluna mais alta');
  assert.equal(await resolve([{ type: 'finance_entries' }, low]), 'HIGH', 'tipo fora do registro recebe a classe padrão (HIGH) e prevalece sobre LOW');
  assert.equal(await resolve([{ type: 'people.persons.qa_sem_linha' }, low]), 'HIGH');
  const classes = await env.inTx(A(), (tx) => env.classification.resolveResources(A(), [low, restricted], tx));
  assert.deepEqual(classes, ['LOW', 'RESTRICTED'], 'uma classe por recurso pedido');
});
