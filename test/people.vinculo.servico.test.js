'use strict';

// Vínculo de pessoa entre empresas do mesmo grupo pelos SERVIÇOS de Pessoas (ISO-4; DI-M9I-2 a DI-M9I-6): CPF/CNPJ que já existe
// no grupo vira vínculo explícito pela prova (CPF + nome), a vinculada vê só a base, grava os próprios filhos, não altera a base
// e desfaz o vínculo com motivo. Transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { q, usarEmpresa, tentar, cenario } = require('./helpers/pessoasVinculo');
const peopleService = require('../src/features/people/people.service');
const links = require('../src/features/people/personLinks.service');
const contacts = require('../src/features/people/personContacts.service');
const addresses = require('../src/features/people/personAddresses.service');
const documents = require('../src/features/people/personDocuments.service');
const roles = require('../src/features/people/personRoles.service');
const consents = require('../src/features/people/personConsents.service');
const { mergePersons } = require('../src/features/people/personMerge.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const comoB = (empresaB) => ({ groupId: tenant.groupId, companyId: empresaB.id });

test('vincular: CPF do grupo cadastrado em B dá 409 PERSON_TAX_ID_IN_GROUP sem id nem nome (e não o 409 que só revela)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, cpf, legalName } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    const r = await tentar(t, () => peopleService.createPerson({ ...comoB(empresaB), personType: 'PF', legalName: 'Outro nome', taxIdNormalized: cpf }, tenant.userId, t));
    assert.equal(r.erro && r.erro.code, 'PERSON_TAX_ID_IN_GROUP');
    assert.equal(r.erro.statusCode, 409);
    assert.ok(!JSON.stringify({ m: r.erro.message, d: r.erro.details || null }).includes(legalName), 'a recusa não traz o nome');
    assert.deepEqual(t.afterRollbackAudits.map((a) => [a.action, a.afterJson.resultado]), [['people.person.link_attempt', 'CPF_CNPJ_JA_NO_GRUPO']]);
  });
});

test('vincular: CPF inexistente e nome que não confere dão a MESMA recusa 422, sem id nem nome, e contam como tentativa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, cpf, legalName } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    const naoExiste = await tentar(t, () => links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: '52998224725', legalName }, tenant.userId, t));
    const nomeErrado = await tentar(t, () => links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: cpf, legalName: 'Joana Ninguém' }, tenant.userId, t));
    for (const r of [naoExiste, nomeErrado]) {
      assert.equal(r.erro && r.erro.code, 'PERSON_LINK_NOT_MATCHED');
      assert.equal(r.erro.statusCode, 422);
      assert.equal(r.erro.details, undefined);
    }
    assert.equal(naoExiste.erro.message, nomeErrado.erro.message, 'as duas recusas são idênticas');
    assert.equal(t.afterRollbackAudits.length, 2);
    const [[v]] = await q(t, "SELECT current_setting('app.vinculo_documento', true) AS d, current_setting('app.vinculo_nome', true) AS n");
    assert.deepEqual(v, { d: '', n: '' }, 'a prova é limpa depois da tentativa');
  });
});

test('vincular: com CPF e nome, B vê só a base (sem empresa responsável, marcações de risco nem autoria) e cria os próprios filhos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    const r = await links.linkPersonByTaxId({
      ...comoB(empresaB), taxIdNormalized: cpf, legalName: 'maria SOUZA', reason: 'Cliente de A comprando em B',
      contacts: [{ contactType: 'PHONE', valueNormalized: '+5511999990000', isPrimary: true }],
      address: { street: 'Rua de B', number: '2', city: 'Campinas', state: 'SP' }, roles: ['CLIENTE'],
    }, tenant.userId, t);
    assert.deepEqual(r, { resultado: 'VINCULADA', personId: pessoa.id });

    const vista = await peopleService.getPerson(pessoa.id, t);
    assert.equal(vista.vinculo.origem, 'VINCULADA');
    for (const campo of ['companyId', 'riskFlagsJson', 'createdBy', 'updatedBy', 'createdAt', 'lockVersion', 'taxIdNormalizedHash']) {
      assert.equal(vista[campo], undefined, `a vinculada não recebe ${campo}`);
    }
    assert.equal(vista.taxIdNormalized, cpf);
    assert.deepEqual(vista.contacts.map((c) => c.valueNormalized), ['+5511999990000'], 'só o contato de B');
    assert.deepEqual(vista.addresses.map((a) => a.street), ['Rua de B'], 'só o endereço de B');
    assert.equal(vista.documents.length, 0, 'nenhum documento de A');
    assert.deepEqual(vista.roles.map((x) => x.companyId), [empresaB.id], 'só o papel de B');
    assert.equal((await consents.listConsents(pessoa.id, t)).length, 0, 'nenhum consentimento de A');

    const c = await consents.recordConsent(pessoa.id, { channel: 'PHONE', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, t);
    assert.equal(c.companyId, empresaB.id, 'o consentimento é de B');
    const ct = await contacts.createContact(pessoa.id, { contactType: 'EMAIL', valueNormalized: 'b@b.test' }, tenant.userId, t);
    assert.equal(ct.companyId, empresaB.id);
    const rg = await documents.createDocument(pessoa.id, { documentType: 'RG', fileId: (await require('./helpers/pessoasVinculo').arquivoDaEmpresa(t, tenant, empresaB.id)) }, tenant.userId, t);
    assert.equal(rg.versionNo, 1, 'o RG de B é a versão 1 de B, sem colidir nem revelar o RG de A');
    const papel = await roles.createRole(pessoa.id, { roleCode: 'FIADOR' }, tenant.userId, t);
    assert.equal(papel.companyId, empresaB.id);
    const lista = await peopleService.listPersons(t);
    const naLista = lista.find((p) => p.id === pessoa.id);
    assert.ok(naLista && naLista.vinculo.origem === 'VINCULADA' && naLista.companyId === undefined, 'a lista de B traz a vinculada só com a base');

    await usarEmpresa(t, tenant.companyId);
    const deA = await peopleService.getPerson(pessoa.id, t);
    assert.equal(deA.vinculo.origem, 'PROPRIA');
    assert.equal(deA.companyId, tenant.companyId);
    assert.deepEqual(deA.riskFlagsJson, { category: 'RISCO_DA_EMPRESA_A' }, 'A continua vendo tudo o que é dela');
    assert.deepEqual(deA.contacts.map((x) => x.companyId), [tenant.companyId], 'A não vê os contatos de B');
    assert.deepEqual(deA.addresses.map((x) => x.street), ['Rua de A']);
    assert.deepEqual(deA.documents.map((x) => [x.documentType, x.versionNo]), [['RG', 1]]);
    assert.equal((await consents.listConsents(pessoa.id, t)).length, 1, 'A vê só o próprio consentimento');
    assert.equal((await addresses.listAddresses(pessoa.id, t)).length, 1);
  });
});

test('vincular: a vinculada não altera, não exclui nem mescla a base; a responsável não exclui nem mescla enquanto houver vínculo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf, legalName } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    await links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: cpf, legalName }, tenant.userId, t);
    const propria = await peopleService.createPerson({ ...comoB(empresaB), personType: 'PF', legalName: 'Duplicada em B' }, tenant.userId, t);

    for (const fn of [
      () => peopleService.updatePerson(pessoa.id, { preferredName: 'Invasor' }, tenant.userId, t),
      () => peopleService.deletePerson(pessoa.id, tenant.userId, t),
      () => mergePersons(pessoa.id, propria.id, tenant.userId, t),
      () => mergePersons(propria.id, pessoa.id, tenant.userId, t),
    ]) {
      const r = await tentar(t, fn);
      assert.equal(r.erro && r.erro.code, 'PERSON_BASE_OWNER_ONLY', String(r.erro && r.erro.message));
      assert.equal(r.erro.statusCode, 403);
    }
    await usarEmpresa(t, tenant.companyId);
    const del = await tentar(t, () => peopleService.deletePerson(pessoa.id, tenant.userId, t));
    assert.equal(del.erro && del.erro.code, 'PERSON_LINKED_ELSEWHERE');
    assert.equal(del.erro.statusCode, 409);
    const outra = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: 'Outra de A' }, tenant.userId, t);
    const merge = await tentar(t, () => mergePersons(outra.id, pessoa.id, tenant.userId, t));
    assert.equal(merge.erro && merge.erro.code, 'PERSON_LINKED_ELSEWHERE');
    const ed = await peopleService.updatePerson(pessoa.id, { preferredName: 'Mari' }, tenant.userId, t);
    assert.equal(ed.preferredName, 'Mari', 'a responsável continua editando a base');
  });
});

test('desvincular: motivo obrigatório, a responsável não se desvincula, a vinculada perde a visão e volta pelo mesmo fluxo (REATIVADA) com os filhos dela', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf, legalName } = await cenario(t, tenant);
    const dono = await tentar(t, () => links.unlinkPerson(pessoa.id, { reason: 'Encerrar responsável' }, tenant.userId, t));
    assert.equal(dono.erro && dono.erro.code, 'PERSON_LINK_OWNER');
    await usarEmpresa(t, empresaB.id);
    await links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: cpf, legalName }, tenant.userId, t);
    await contacts.createContact(pessoa.id, { contactType: 'EMAIL', valueNormalized: 'b@b.test' }, tenant.userId, t);
    const semMotivo = await tentar(t, () => links.unlinkPerson(pessoa.id, {}, tenant.userId, t));
    assert.equal(semMotivo.erro && semMotivo.erro.code, 'PERSON_LINK_VALIDATION');
    assert.deepEqual(await links.unlinkPerson(pessoa.id, { reason: 'Cliente encerrou a relação com B' }, tenant.userId, t), { id: pessoa.id, vinculo: 'ENCERRADO' });
    const depois = await tentar(t, () => peopleService.getPerson(pessoa.id, t));
    assert.equal(depois.erro && depois.erro.code, 'PERSON_NOT_FOUND');
    const novoContato = await tentar(t, () => contacts.createContact(pessoa.id, { contactType: 'EMAIL', valueNormalized: 'c@b.test' }, tenant.userId, t));
    assert.equal(novoContato.erro && novoContato.erro.code, 'PERSON_NOT_FOUND');
    const [[fim]] = await q(t, "SELECT reason FROM audit.audit_log WHERE entity_id = :p AND action = 'people.person.unlink'", { p: pessoa.id });
    assert.equal(fim.reason, 'Cliente encerrou a relação com B');

    const volta = await links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: cpf, legalName }, tenant.userId, t);
    assert.equal(volta.resultado, 'REATIVADA');
    assert.deepEqual((await contacts.listContacts(pessoa.id, t)).map((c) => c.valueNormalized), ['b@b.test'], 'os dados de B voltam com o vínculo');
    const de_novo = await links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: cpf, legalName }, tenant.userId, t);
    assert.equal(de_novo.resultado, 'JA_NESTA_EMPRESA');
  });
});

test('limite de tentativas: com o parâmetro people.vinculo.tentativas_max, a próxima tentativa é recusada com 429 antes de consultar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, cpf } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    await q(t, `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, 'people.vinculo.tentativas_max', '2'::jsonb, now(), now())`, { g: tenant.groupId, c: empresaB.id });
    for (let i = 0; i < 2; i += 1) {
      await q(t, `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, after_json, reason, occurred_at, created_at, updated_at)
        VALUES (gen_random_uuid(), :g, :c, :u, 'people.person.link_attempt', 'Person', '{"resultado":"NAO_CONFERE"}', 'teste', now(), now(), now())`, { g: tenant.groupId, c: empresaB.id, u: tenant.userId });
    }
    const r = await tentar(t, () => links.linkPersonByTaxId({ ...comoB(empresaB), taxIdNormalized: cpf, legalName: 'Maria Souza' }, tenant.userId, t));
    assert.equal(r.erro && r.erro.code, 'PERSON_LINK_RATE_LIMIT');
    assert.equal(r.erro.statusCode, 429);
    const criar = await tentar(t, () => peopleService.createPerson({ ...comoB(empresaB), personType: 'PF', legalName: 'X', taxIdNormalized: cpf }, tenant.userId, t));
    assert.equal(criar.erro && criar.erro.code, 'PERSON_LINK_RATE_LIMIT', 'acima do limite, o cadastro com CPF/CNPJ que esta empresa não vê também para');
  });
});
