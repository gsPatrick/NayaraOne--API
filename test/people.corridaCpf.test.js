'use strict';

// Corrida no cadastro do mesmo CPF/CNPJ (integração dos Marcos 3 a 6 sobre o Marco 9, 14/11/2026). O portão de deduplicação confere antes
// de gravar; duas gravações ao mesmo tempo passam as duas pelo portão e a UNIQUE(group_id, tax_id_normalized) do banco recusa a segunda.
// A resposta precisa dizer a verdade sobre ONDE está o cadastro que ganhou:
//   - na MESMA empresa: a mesma recusa do portão (409 PERSON_DUPLICATE, nível FORTE, com o cadastro existente) — Caderno do Marco 3 §4;
//   - em OUTRA empresa do grupo: 409 PERSON_TAX_ID_IN_GROUP, sem id nem nome (o caminho é o vínculo, DI-M9I).
// A corrida é simulada fazendo o portão "não ver" o cadastro (como acontece quando os dois pedidos chegam juntos); a gravação vai ao banco
// de verdade e é a UNIQUE que recusa. Transação com rollback.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { q, usarEmpresa, tentar, cenario } = require('./helpers/pessoasVinculo');
const peopleService = require('../src/features/people/people.service');
const dedup = require('../src/features/people/personDedup.service');

let tenant;
const originais = { findStrongInCompany: dedup.findStrongInCompany, taxIdInOtherCompany: dedup.taxIdInOtherCompany };
before(async () => { tenant = await getSeedTenant(); });
afterEach(() => Object.assign(dedup, originais));
after(async () => { await sequelize.close(); });

/** O portão deixa de ver o CPF (os dois pedidos passaram por ele antes de qualquer um gravar). */
function portaoNaoVe() {
  dedup.findStrongInCompany = async () => null;
  dedup.taxIdInOtherCompany = async () => false;
}

test('corrida na MESMA empresa: a UNIQUE recusa e a resposta é a do portão (409 PERSON_DUPLICATE FORTE com o cadastro existente)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { pessoa, cpf } = await cenario(t, tenant);
    portaoNaoVe();
    const r = await tentar(t, () => peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: 'Cadastro simultâneo', taxIdNormalized: cpf }, tenant.userId, t));
    assert.equal(r.erro && r.erro.code, 'PERSON_DUPLICATE');
    assert.equal(r.erro.statusCode, 409);
    assert.equal(r.erro.details.nivel, 'FORTE');
    assert.equal(r.erro.details.existingPersonId, pessoa.id);
    const [[n]] = await q(t, 'SELECT count(*)::int AS n FROM people.persons WHERE tax_id_normalized = :c', { c: cpf });
    assert.equal(n.n, 1, 'uma pessoa só com o CPF');
  });
});

test('corrida com OUTRA empresa do grupo: 409 PERSON_TAX_ID_IN_GROUP, sem id nem nome, conta como tentativa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, cpf, legalName, pessoa } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    portaoNaoVe();
    const r = await tentar(t, () => peopleService.createPerson(
      { groupId: tenant.groupId, companyId: empresaB.id, personType: 'PF', legalName: 'Cadastro simultâneo em B', taxIdNormalized: cpf }, tenant.userId, t));
    assert.equal(r.erro && r.erro.code, 'PERSON_TAX_ID_IN_GROUP');
    assert.equal(r.erro.statusCode, 409);
    const texto = JSON.stringify({ m: r.erro.message, d: r.erro.details || null });
    assert.ok(!texto.includes(legalName) && !texto.includes(pessoa.id), 'a recusa não traz o nome nem o id do cadastro de A');
    assert.deepEqual(t.afterRollbackAudits.map((a) => [a.action, a.afterJson.resultado]), [['people.person.link_attempt', 'CPF_CNPJ_JA_NO_GRUPO']]);
  });
});
