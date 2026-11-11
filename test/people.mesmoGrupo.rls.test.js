'use strict';

// Isolamento de Pessoas entre DUAS empresas do MESMO grupo (achado ao vivo na homologação em 10/11/2026: um usuário da
// empresa B do grupo lia, listava e tentava gravar consentimento na pessoa da empresa A). Os testes antigos usavam duas
// empresas de GRUPOS diferentes, onde o group_id já barrava tudo, por isso não pegaram.
// Livro: Caderno §26 (persons_company_select com company_scope_allows), §7 ("segregação obrigatória por group_id e
// company_id"), checklist do Marco 3 ("RLS bloqueia outra empresa"). Correção: migration 20260101009965.
// Tudo roda numa transação com rollback: a segunda empresa nasce e morre dentro do teste.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Company } = require('../src/models');
const peopleService = require('../src/features/people/people.service');
const consents = require('../src/features/people/personConsents.service');
const contacts = require('../src/features/people/personContacts.service');
const { mergePersons } = require('../src/features/people/personMerge.service');

let tenant;

before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

function randomCpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}

const q = (transaction, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction });
const usarEmpresa = (transaction, companyId) => q(transaction, "SELECT set_config('app.company_id', :c, true)", { c: companyId || '' });

/** Roda fn dentro de um SAVEPOINT; devolve o erro (e desfaz só o savepoint) ou null. */
async function tentar(transaction, fn) {
  await q(transaction, 'SAVEPOINT iso');
  try {
    const valor = await fn();
    await q(transaction, 'RELEASE SAVEPOINT iso');
    return { erro: null, valor };
  } catch (erro) {
    await q(transaction, 'ROLLBACK TO SAVEPOINT iso');
    return { erro, valor: null };
  }
}

/** Empresa B no MESMO grupo da empresa semente (A) + uma pessoa com contato e consentimento na empresa A. */
async function cenario(transaction) {
  const suf = uniqueSuffix();
  const empresaB = await Company.create({ groupId: tenant.groupId, name: `Mesmo grupo B ${suf}`, status: 'ACTIVE' }, { transaction });
  const cpf = randomCpf();
  const pessoaA = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa da empresa A ${suf}`, taxIdNormalized: cpf },
    tenant.userId, transaction
  );
  await contacts.createContact(pessoaA.id, { contactType: 'EMAIL', valueNormalized: `a${suf}@exemplo.test`, isPrimary: true }, tenant.userId, transaction);
  await consents.recordConsent(pessoaA.id, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction);
  return { empresaB, pessoaA, cpf, suf };
}

test('mesmo grupo: empresa B não lê a pessoa da empresa A (por id, na lista, nos consentimentos e nos contatos)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { empresaB, pessoaA } = await cenario(transaction);
    await usarEmpresa(transaction, empresaB.id);

    const [porId] = await q(transaction, 'SELECT id FROM people.persons WHERE id = :id', { id: pessoaA.id });
    assert.equal(porId.length, 0, 'SELECT direto por id da pessoa de A, no contexto de B, tem de voltar vazio');
    const [outras] = await q(transaction, 'SELECT count(*)::int AS n FROM people.persons WHERE company_id <> :b', { b: empresaB.id });
    assert.equal(outras[0].n, 0, 'no contexto de B nenhuma pessoa de outra empresa do grupo pode ser visível');

    await assert.rejects(peopleService.getPerson(pessoaA.id, transaction), (e) => e.code === 'PERSON_NOT_FOUND');
    const lista = await peopleService.listPersons(transaction);
    assert.ok(!lista.some((p) => p.id === pessoaA.id), 'a lista de B não pode trazer a pessoa de A');
    await assert.rejects(consents.listConsents(pessoaA.id, transaction), (e) => e.code === 'PERSON_NOT_FOUND');
    await assert.rejects(contacts.listContacts(pessoaA.id, transaction), (e) => e.statusCode === 404);
  });
});

test('mesmo grupo: empresa B não grava na pessoa da empresa A (consentimento, edição, exclusão, INSERT/UPDATE/DELETE direto)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { empresaB, pessoaA } = await cenario(transaction);
    await usarEmpresa(transaction, empresaB.id);

    await assert.rejects(
      consents.recordConsent(pessoaA.id, { channel: 'PHONE', purpose: 'ISOLAMENTO', status: 'OPT_IN' }, tenant.userId, transaction),
      (e) => e.code === 'PERSON_NOT_FOUND' && e.statusCode === 404
    );
    await assert.rejects(peopleService.updatePerson(pessoaA.id, { preferredName: 'Invasor' }, tenant.userId, transaction), (e) => e.code === 'PERSON_NOT_FOUND');
    await assert.rejects(peopleService.deletePerson(pessoaA.id, tenant.userId, transaction), (e) => e.statusCode === 404);

    // UPDATE/DELETE "às cegas" (sem WHERE que leia coluna): sem o escopo de empresa nas políticas de escrita, só o grupo barraria.
    const [, upd] = await q(transaction, "UPDATE people.persons SET preferred_name = 'Invasor'");
    const [, del] = await q(transaction, 'DELETE FROM people.persons');
    assert.equal(upd.rowCount, 0, 'UPDATE sem WHERE no contexto de B não pode alcançar pessoas de A');
    assert.equal(del.rowCount, 0, 'DELETE sem WHERE no contexto de B não pode alcançar pessoas de A');

    // INSERT com company_id de A a partir do contexto de B: recusado pelo WITH CHECK (sem RETURNING, para não depender do SELECT).
    const ins = await tentar(transaction, () => q(transaction,
      "INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :a, 'PF', 'Pessoa plantada', 'ACTIVE')",
      { g: tenant.groupId, a: tenant.companyId }));
    assert.ok(ins.erro, 'INSERT de pessoa na empresa A a partir do contexto de B tem de falhar');
    assert.equal(ins.erro.parent && ins.erro.parent.code, '42501');
    const cons = await tentar(transaction, () => q(transaction,
      "INSERT INTO people.communication_consents (id, group_id, company_id, person_id, channel, purpose, status, recorded_at) VALUES (gen_random_uuid(), :g, :a, :p, 'PHONE', 'ISOLAMENTO', 'OPT_IN', now())",
      { g: tenant.groupId, a: tenant.companyId, p: pessoaA.id }));
    assert.equal(cons.erro && cons.erro.parent && cons.erro.parent.code, '42501', 'consentimento na empresa A a partir de B tem de ser recusado pelo RLS');

    await usarEmpresa(transaction, tenant.companyId);
    const [depois] = await q(transaction, 'SELECT preferred_name, deleted_at FROM people.persons WHERE id = :id', { id: pessoaA.id });
    assert.equal(depois.length, 1);
    assert.equal(depois[0].preferred_name, null, 'a pessoa de A não pode ter sido alterada');
    assert.equal(depois[0].deleted_at, null, 'a pessoa de A não pode ter sido apagada');
    const [isol] = await q(transaction, "SELECT count(*)::int AS n FROM people.communication_consents WHERE person_id = :p AND purpose = 'ISOLAMENTO'", { p: pessoaA.id });
    assert.equal(isol[0].n, 0, 'nenhum consentimento pode ter sido gravado em A pela empresa B');
  });
});

test('recusa limpa: gravação barrada pelo RLS vira 403 TENANT_SCOPE_DENIED; GRANT ausente continua erro do servidor', async () => {
  const { mapRlsViolation } = require('../src/middlewares/errorHandler');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { empresaB, pessoaA } = await cenario(transaction);
    await usarEmpresa(transaction, empresaB.id);
    const r = await tentar(transaction, () => q(transaction,
      "INSERT INTO people.communication_consents (id, group_id, company_id, person_id, channel, purpose, status, recorded_at) VALUES (gen_random_uuid(), :g, :a, :p, 'PHONE', 'ISOLAMENTO', 'OPT_IN', now())",
      { g: tenant.groupId, a: tenant.companyId, p: pessoaA.id }));
    assert.deepEqual(mapRlsViolation(r.erro), { statusCode: 403, code: 'TENANT_SCOPE_DENIED', message: 'Este registro não pertence à empresa em uso.' });
  });
  assert.equal(mapRlsViolation({ parent: { code: '42501', message: 'permission denied for table persons' } }), null);
  assert.equal(mapRlsViolation(new Error('qualquer')), null);
});

test('mesmo grupo: sem empresa no contexto não se lê nem se grava pessoa (falha fechada)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await cenario(transaction);
    await usarEmpresa(transaction, null);
    const [vis] = await q(transaction, 'SELECT count(*)::int AS n FROM people.persons');
    assert.equal(vis[0].n, 0, 'só com o grupo no contexto nenhuma pessoa é visível');
    const ins = await tentar(transaction, () => q(transaction,
      "INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :a, 'PF', 'Sem empresa', 'ACTIVE')",
      { g: tenant.groupId, a: tenant.companyId }));
    assert.equal(ins.erro && ins.erro.parent && ins.erro.parent.code, '42501');
  });
});

test('mesmo grupo: o mesmo CPF em outra empresa do grupo é recusado com 409 sem revelar a pessoa (UNIQUE por grupo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { empresaB, cpf } = await cenario(transaction);
    await usarEmpresa(transaction, empresaB.id);
    const r = await tentar(transaction, () => peopleService.createPerson(
      { groupId: tenant.groupId, companyId: empresaB.id, personType: 'PF', legalName: 'Mesmo CPF em B', taxIdNormalized: cpf },
      tenant.userId, transaction
    ));
    assert.ok(r.erro, 'criar o mesmo CPF em B tem de ser recusado');
    assert.equal(r.erro.code, 'PERSON_DUPLICATE_TAX_ID');
    assert.equal(r.erro.statusCode, 409);
    assert.ok(!r.erro.details || !r.erro.details.existingPersonId, 'a recusa não pode entregar o id da pessoa da empresa A');
  });
});

test('fluxo legítimo intacto: cada empresa cria, lê, edita, deduplica, registra consentimento e mescla as próprias pessoas', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { empresaB, pessoaA, cpf, suf } = await cenario(transaction);

    // Empresa A: lê, edita, consentimento e dedup por CPF dentro da própria empresa.
    const lida = await peopleService.getPerson(pessoaA.id, transaction);
    assert.equal(lida.id, pessoaA.id);
    const editada = await peopleService.updatePerson(pessoaA.id, { preferredName: 'Nome de uso' }, tenant.userId, transaction);
    assert.equal(editada.preferredName, 'Nome de uso');
    const optOut = await consents.recordConsent(pessoaA.id, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_OUT' }, tenant.userId, transaction);
    assert.equal(optOut.companyId, tenant.companyId);
    assert.equal((await consents.listConsents(pessoaA.id, transaction)).length, 2);
    const dup = await tentar(transaction, () => peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: 'Duplicada', taxIdNormalized: cpf }, tenant.userId, transaction));
    assert.equal(dup.erro && dup.erro.code, 'PERSON_DUPLICATE');
    assert.equal(dup.erro.details.existingPersonId, pessoaA.id, 'dentro da mesma empresa o dedup continua oferecendo o cadastro existente');

    // Empresa B: cria e lê as próprias pessoas e mescla duas delas; A não vê nada disso.
    await usarEmpresa(transaction, empresaB.id);
    const b1 = await peopleService.createPerson({ groupId: tenant.groupId, companyId: empresaB.id, personType: 'PF', legalName: `B canônica ${suf}` }, tenant.userId, transaction);
    const b2 = await peopleService.createPerson({ groupId: tenant.groupId, companyId: empresaB.id, personType: 'PF', legalName: `B absorvida ${suf}` }, tenant.userId, transaction);
    await consents.recordConsent(b1.id, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction);
    assert.deepEqual((await peopleService.listPersons(transaction)).map((p) => p.id).sort(), [b1.id, b2.id].sort());
    await mergePersons(b1.id, b2.id, tenant.userId, transaction);
    const [absorvida] = await q(transaction, 'SELECT status, merged_into_id FROM people.persons WHERE id = :id', { id: b2.id });
    assert.equal(absorvida[0].status, 'MERGED');
    assert.equal(absorvida[0].merged_into_id, b1.id);

    // Mesclar com a pessoa de outra empresa do grupo é recusado (ela não existe para B).
    const cruzado = await tentar(transaction, () => mergePersons(b1.id, pessoaA.id, tenant.userId, transaction));
    assert.ok(cruzado.erro && cruzado.erro.statusCode === 404, `merge com pessoa de A a partir de B deveria dar 404: ${cruzado.erro && cruzado.erro.code}`);

    await usarEmpresa(transaction, tenant.companyId);
    const [deA] = await q(transaction, 'SELECT count(*)::int AS n FROM people.persons WHERE id IN (:ids)', { ids: [b1.id, b2.id] });
    assert.equal(deA[0].n, 0, 'a empresa A também não enxerga as pessoas da empresa B');
  });
});
