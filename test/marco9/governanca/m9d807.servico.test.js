'use strict';

// M9-D807 — campo crítico exige source/evidence: regras dos serviços com banco. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d807.servico.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d807Env');
const { adminQuery } = require('../../m9d801.helpers');
const personService = require('../../../src/features/people/person.service');
const bankAccountsService = require('../../../src/features/finance/bankAccounts.service');
const propertiesService = require('../../../src/features/properties/properties.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const fail = (promise) => promise.then(() => null, (err) => err);
const PIX = 'nova-chave-secreta@qa-m9.test';
const CPF = env.cpf();

test('m9d807 campo crítico sem evidência é recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    const err = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX }, A().userId, tx));
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'GOV_EVIDENCE_REQUIRED');
    assert.equal(err.message, 'Informe a origem e o comprovante desta alteração.');
    assert.equal((await bankAccountsService.getBankAccount(account.id, tx)).pixKey, 'antiga@qa-m9.test', 'nada foi gravado');
    const person = await fail(personService.updatePerson(owner.id, { taxIdNormalized: CPF }, A().userId, tx));
    assert.equal(person.code, 'GOV_EVIDENCE_REQUIRED');
    const prop = await env.property(A(), tx, { registryNumber: 'MAT-1' });
    const registry = await fail(propertiesService.updateProperty(prop.id, { registryNumber: 'MAT-2' }, A().userId, tx, A()));
    assert.equal(registry.code, 'GOV_EVIDENCE_REQUIRED');
    assert.equal((await env.evidenceRows(account.id, tx)).length, 0);
  });
});

test('m9d807 campo não crítico passa sem evidência', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const updated = await personService.updatePerson(owner.id, { preferredName: 'Apelido novo' }, A().userId, tx);
    assert.equal(updated.preferredName, 'Apelido novo');
    const account = await env.bankAccount(A(), tx, owner.id);
    const same = await bankAccountsService.updateBankAccount(account.id, { pixKey: 'antiga@qa-m9.test' }, A().userId, tx);
    assert.equal(same.pixKey, 'antiga@qa-m9.test', 'mesmo valor não é alteração: sem evidência exigida');
    assert.equal((await env.evidenceRows(account.id, tx)).length, 0, 'e nenhuma linha nova');
  });
});

test('m9d807 DOCUMENT exige arquivo da mesma empresa', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    const noFile = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'DOCUMENT' } }, A().userId, tx));
    assert.equal(noFile.code, 'GOV_EVIDENCE_FILE_REQUIRED');
    assert.equal(noFile.message, 'Anexe o documento que comprova a alteração.');
    const registry = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'OFFICIAL_REGISTRY' } }, A().userId, tx));
    assert.equal(registry.code, 'GOV_EVIDENCE_FILE_REQUIRED');
  });
  // Arquivo de OUTRA empresa, confirmado no banco (fora de transação de teste): a empresa A não pode usá-lo como comprovante.
  const { rows: [foreign] } = await adminQuery(
    `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, checksum_sha256, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 'outra-empresa.pdf', 'application/pdf', 10, $4, $5) RETURNING id`,
    [tenants.B.groupId, tenants.B.companyId, `qa-m9/${env.suffix()}`, 'b'.repeat(64), tenants.B.userId]
  );
  try {
    await run(async (tx) => {
      const owner = await env.person(A(), tx);
      const account = await env.bankAccount(A(), tx, owner.id);
      const err = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'DOCUMENT', evidenceFileId: foreign.id } }, A().userId, tx));
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'GOV_NOT_FOUND');
      assert.equal(err.message, 'Arquivo não encontrado.');
      const own = await env.file(A(), tx);
      const ok = await bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'DOCUMENT', evidenceFileId: own.id } }, A().userId, tx);
      assert.equal(ok.pixKey, PIX);
      const rows = await env.evidenceRows(account.id, tx);
      assert.deepEqual(rows.map((r) => [r.field, r.source, r.evidence_file_id]), [['pixKey', 'DOCUMENT', own.id]]);
    });
  } finally {
    await adminQuery('DELETE FROM people.files WHERE id = $1', [foreign.id]);
  }
});

test('m9d807 evidência e campo são atômicos', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    const q = (sql) => env.sequelize.query(sql, { transaction: tx });
    await q('SAVEPOINT m9d807_atomico');
    await bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'PERSON_STATEMENT', note: 'Pedido do proprietário por e-mail.' } }, A().userId, tx);
    assert.equal((await env.evidenceRows(account.id, tx)).length, 1, 'dentro da transação a evidência existe');
    assert.equal((await bankAccountsService.getBankAccount(account.id, tx)).pixKey, PIX);
    await q('ROLLBACK TO SAVEPOINT m9d807_atomico'); // a falha no meio desfaz campo e evidência juntos
    assert.equal((await env.evidenceRows(account.id, tx)).length, 0, 'sem campo, sem evidência');
    assert.equal((await bankAccountsService.getBankAccount(account.id, tx)).pixKey, 'antiga@qa-m9.test');
  });
});

test('m9d807 valor em claro não é duplicado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    await bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'PERSON_STATEMENT', note: 'Pedido do proprietário por e-mail.' } }, A().userId, tx);
    const [row] = await env.evidenceRows(account.id, tx);
    assert.match(row.value_before_hash, /^[0-9a-f]{64}$/);
    assert.match(row.value_after_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.value_before_hash, row.value_after_hash);
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(PIX) && !serialized.includes('antiga@qa-m9.test'), 'a linha de evidência não guarda o valor em claro');
    assert.ok(row.audit_log_id, 'ligada à auditoria');
    const [audit] = await env.sequelize.query('SELECT before_json, after_json FROM audit.audit_log WHERE id = :id', { type: 'SELECT', transaction: tx, replacements: { id: row.audit_log_id } });
    assert.ok(JSON.stringify(audit.after_json).includes(PIX), 'o antes e o depois legíveis ficam na auditoria');
    assert.ok(JSON.stringify(audit.before_json).includes('antiga@qa-m9.test'));
  });
});

test('m9d807 SYSTEM_IMPORT fora de importação recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    const err = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'SYSTEM_IMPORT' } }, A().userId, tx));
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'GOV_EVIDENCE_SOURCE_INVALID');
    assert.equal(err.message, 'Origem inválida para esta operação.');
    const bogus = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'ALGO' } }, A().userId, tx));
    assert.equal(bogus.code, 'GOV_EVIDENCE_SOURCE_INVALID');
  });
});

test('m9d807 PERSON_STATEMENT com nota curta é recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    for (const source of ['PERSON_STATEMENT', 'OTHER']) {
      const err = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source, note: 'ok' } }, A().userId, tx));
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, 'GOV_EVIDENCE_NOTE_TOO_SHORT');
      assert.equal(err.message, 'Descreva a origem com pelo menos 10 caracteres.');
    }
    const edge = await bankAccountsService.updateBankAccount(account.id, { pixKey: PIX, changeEvidence: { source: 'OTHER', note: '1234567890' } }, A().userId, tx);
    assert.equal(edge.pixKey, PIX, 'exatamente 10 caracteres passa');
  });
});

test('m9d807 imóvel e pessoa gravam a evidência por campo crítico alterado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const prop = await env.property(A(), tx, { registryNumber: 'MAT-1' });
    const evidence = { source: 'OTHER', note: 'Retificação da matrícula pelo cartório.' };
    await propertiesService.updateProperty(prop.id, { registryNumber: 'MAT-2', title: 'Outro título', changeEvidence: evidence }, A().userId, tx, A());
    assert.deepEqual((await env.evidenceRows(prop.id, tx)).map((r) => r.field), ['registryNumber']);
    const owner = await env.person(A(), tx, { legalName: 'Nome Antigo Silva' });
    await personService.updatePerson(owner.id, { legalName: 'Nome Novo Silva', taxIdNormalized: CPF, changeEvidence: evidence }, A().userId, tx);
    assert.deepEqual((await env.evidenceRows(owner.id, tx)).map((r) => r.field), ['legalName', 'taxIdNormalized']);
    await personService.updatePerson(owner.id, { legalName: 'Nome Novo Silva', taxIdNormalized: CPF }, A().userId, tx);
    assert.equal((await env.evidenceRows(owner.id, tx)).length, 2, 'repetir o mesmo PATCH não grava evidência nova nem exige uma');
  });
});
