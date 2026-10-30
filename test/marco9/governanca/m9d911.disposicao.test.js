'use strict';

// M9-D911 — as disposições: anonimização irreversível que mantém as chaves técnicas (e usa a máscara do registro via maskSpecFor) e arquivamento com cópia e hash.
// Banco descartável: ver m9d911.politica.test.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d911Env');
const maskSpec = require('../../../src/features/core-governance/data-quality/retention.maskSpec');

let tenants;
const A = () => tenants.A;
const NOW = new Date('2026-03-10T15:00:00Z');
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetRetention(A()); } });
afterEach(() => { maskSpec.resetProvider(); env.holdGuard.resetProvider(); });
after(async () => { if (env.DISPOSABLE) await env.resetRetention(A()); await env.sequelize.close(); });
const tag = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ownLead = (report, id) => report.targets.find((t) => t.target === 'LEADS').sample.includes(id);

test('m9d911 anonimização é irreversível e mantém as chaves técnicas: pessoa, oportunidade, contato e endereço continuam ligados, sem o dado pessoal', { skip: env.skip() }, async () => {
  const t = tag();
  const old = await env.insertLead(A(), { name: `Maria Silva ${t}`, taxId: `1111${t}`.slice(0, 14), lastContact: '2023-01-10T12:00:00Z', phone: '11977776666' });
  const old2 = await env.insertLead(A(), { name: `João Souza ${t}`, taxId: `2222${t}`.slice(0, 14), lastContact: '2023-01-11T12:00:00Z' });
  const recent = await env.insertLead(A(), { name: `Ana Recente ${t}`, taxId: `3333${t}`.slice(0, 14), lastContact: '2026-03-01T12:00:00Z' });
  const dry = await env.dryRun(A(), { policyCodes: ['LEADS'], now: NOW });
  const leads = env.policyReport(dry, 'LEADS');
  assert.equal(leads.wouldAnonymize >= 2, true);
  const queued = (await env.items(dry.id)).map((item) => item.record_id);
  assert.ok(queued.includes(old) && queued.includes(old2) && !queued.includes(recent), 'só o lead sem contato recente entra');
  await env.apply(A(), dry.id, { now: NOW });
  const after1 = await env.personRow(old);
  assert.equal(after1.id, old, 'a chave técnica continua');
  assert.equal(after1.legal_name, '[ANONIMIZADO]');
  assert.equal(after1.preferred_name, '[ANONIMIZADO]');
  assert.match(after1.tax_id_normalized, /^ANON-[0-9a-f]+$/);
  assert.notEqual(after1.tax_id_normalized, `1111${t}`.slice(0, 14));
  const max = (await env.adminQuery("SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_schema = 'people' AND table_name = 'persons' AND column_name = 'tax_id_normalized'")).rows[0].n;
  assert.equal(after1.tax_id_normalized.length <= max, true, 'cabe na coluna');
  const after2 = await env.personRow(old2);
  assert.notEqual(after2.tax_id_normalized, after1.tax_id_normalized, 'o valor derivado não repete (índice único do documento)');
  const contact = (await env.adminQuery('SELECT value_normalized, person_id FROM people.person_contacts WHERE person_id = $1', [old])).rows[0];
  assert.deepEqual([contact.value_normalized, contact.person_id], ['[ANONIMIZADO]', old]);
  const address = (await env.adminQuery('SELECT street, number, zip_code FROM people.person_addresses WHERE person_id = $1', [old])).rows[0];
  assert.deepEqual([address.street, address.number], ['[ANONIMIZADO]', '[ANONIMIZADO]']);
  const opp = (await env.adminQuery('SELECT count(*)::int AS n FROM crm.opportunities WHERE person_id = $1', [old])).rows[0].n;
  assert.equal(opp, 1, 'a oportunidade (agregado estatístico) fica');
  assert.equal((await env.personRow(recent)).legal_name, `Ana Recente ${t}`, 'quem tem contato recente não é tocado');
  const again = await env.dryRun(A(), { policyCodes: ['LEADS'], now: NOW });
  assert.equal(ownLead(env.policyReport(again, 'LEADS'), old), false, 'o já anonimizado não volta à fila');
  assert.equal((await env.items(again.id)).some((item) => item.record_id === old), false);
});

test('m9d911 a anonimização usa a máscara do registro via maskSpecFor: HASH vira hash com sal descartado, outras máscaras caem para FULL', { skip: env.skip() }, async () => {
  const seen = [];
  maskSpec.setProvider(async (schema, table, column) => { seen.push(`${schema}.${table}.${column}`); return column === 'legal_name' ? { masking: 'HASH' } : { masking: 'PARTIAL' }; });
  const t = tag();
  const id = await env.insertLead(A(), { name: `Pedro Hash ${t}`, taxId: `4444${t}`.slice(0, 14), lastContact: '2023-02-01T12:00:00Z' });
  const dry = await env.dryRun(A(), { policyCodes: ['LEADS'], now: NOW });
  await env.apply(A(), dry.id, { now: NOW });
  const row = await env.personRow(id);
  assert.match(row.legal_name, /^[0-9a-f]{64}$|^[0-9a-f]+$/, 'HASH: só hexadecimal');
  assert.notEqual(row.legal_name, `Pedro Hash ${t}`);
  assert.equal(row.preferred_name, '[ANONIMIZADO]', 'PARTIAL não anonimiza: tratada como FULL');
  assert.ok(seen.includes('people.persons.legal_name') && seen.includes('people.person_contacts.value_normalized'), 'a máscara foi pedida ao registro por coluna');
});

test('m9d911 disposição ARCHIVE copia o registro com o hash para o arquivo de retenção (uma vez) e o arquivo não aceita alteração', { skip: env.skip() }, async () => {
  const action = `qa.m9d911.${tag()}`;
  for (let i = 0; i < 3; i += 1) await env.adminQuery("INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, occurred_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'QA', '2019-05-05T10:00:00Z')", [A().groupId, A().companyId, A().userId, action]);
  const dry = await env.dryRun(A(), { policyCodes: ['AUDITORIA_SEGURANCA'], now: NOW });
  assert.equal(env.policyReport(dry, 'AUDITORIA_SEGURANCA').wouldArchive >= 3, true);
  await env.apply(A(), dry.id, { now: NOW });
  const { rows } = await env.adminQuery("SELECT a.record_id, a.content_hash, a.content->>'action' AS action FROM governance.retention_archives a WHERE a.company_id = $1 AND a.target_code = 'AUDIT_LOG' AND a.content->>'action' = $2", [A().companyId, action]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.content_hash)));
  const stillThere = await env.adminQuery('SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = $2', [A().companyId, action]);
  assert.equal(stillThere.rows[0].n, 3, 'arquivar copia: a trilha de auditoria continua intacta');
  await assert.rejects(env.adminQuery("UPDATE governance.retention_archives SET content_hash = 'x' WHERE company_id = $1", [A().companyId]), /só recebe novas cópias/);
  const again = await env.dryRun(A(), { policyCodes: ['AUDITORIA_SEGURANCA'], now: NOW });
  assert.equal((await env.items(again.id)).some((item) => rows.some((r) => r.record_id === item.record_id)), false, 'o arquivado não é arquivado outra vez');
});
