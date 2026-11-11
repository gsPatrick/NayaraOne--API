'use strict';

// M3-01 (DI-M3PE-1): CPF/CNPJ com dígito verificador errado é recusado (422 PERSON_TAX_ID_INVALID), na criação e na troca; o cadastro
// antigo com dígito errado não é apagado: continua editável e aparece marcado para revisão. M3-02 / CRMX-002 (DI-M3PE-2): o papel VENDEDOR
// do livro existe e a lista de papéis é o parâmetro people.papeis (os cinco do livro não saem).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { randomCpf } = require('./helpers/pessoasVinculo');
const peopleService = require('../src/features/people/people.service');
const roles = require('../src/features/people/personRoles.service');
const { upsertSetting } = require('../src/features/settings/settings.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Validação ${uniqueSuffix()}` });
const criar = (t, extra) => peopleService.createPerson({ ...base(), ...extra }, tenant.userId, t);
const recusa = (code, status) => (err) => { assert.equal(err.code, code, err.message); assert.equal(err.statusCode, status); return true; };

test('M3-01 CPF 529.982.247-26 (dígito errado, o da sonda do verificador) é recusado com 422 e o campo apontado; nada é gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const antes = await sequelize.query("SELECT count(*)::int AS n FROM people.persons WHERE tax_id_normalized = '52998224726'", { transaction: t, plain: true });
    await assert.rejects(() => criar(t, { taxIdNormalized: '529.982.247-26' }), (err) => {
      recusa('PERSON_TAX_ID_INVALID', 422)(err);
      assert.match(err.message, /CPF inválido: os dígitos verificadores não conferem/);
      assert.deepEqual(err.details.fields.map((f) => f.field), ['taxIdNormalized']);
      return true;
    });
    const depois = await sequelize.query("SELECT count(*)::int AS n FROM people.persons WHERE tax_id_normalized = '52998224726'", { transaction: t, plain: true });
    assert.equal(depois.n, antes.n);
  });
});

test('M3-01 CNPJ com dígito errado, sequência repetida e formato curto são recusados; CPF e CNPJ válidos passam', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(() => criar(t, { personType: 'PJ', taxIdNormalized: '11.222.333/0001-80' }), recusa('PERSON_TAX_ID_INVALID', 422));
    await assert.rejects(() => criar(t, { taxIdNormalized: '111.111.111-11' }), recusa('PERSON_TAX_ID_INVALID', 422));
    await assert.rejects(() => criar(t, { taxIdNormalized: '1234567890' }), recusa('PERSON_DOCUMENT_INVALID_FORMAT', 400));
    const pf = await criar(t, { taxIdNormalized: randomCpf() });
    assert.ok(pf.id);
    const [{ cnpj }] = await sequelize.query("SELECT '11222333000181' AS cnpj", { transaction: t, type: sequelize.QueryTypes.SELECT });
    const pj = await criar(t, { personType: 'PJ', taxIdNormalized: cnpj });
    assert.equal(pj.taxIdNormalized, cnpj);
  });
});

test('M3-01 trocar o CPF por um com dígito errado é recusado; cadastro antigo com dígito errado continua editável e vem marcado para revisão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await criar(t, { taxIdNormalized: randomCpf() });
    await assert.rejects(() => peopleService.updatePerson(p.id, { taxIdNormalized: '52998224726', changeEvidence: { source: 'PERSON_STATEMENT', note: 'Informado pela própria pessoa no balcão.' } }, tenant.userId, t),
      recusa('PERSON_TAX_ID_INVALID', 422));
    // Legado: gravado antes da regra (direto no banco, como os cadastros antigos). Nada apaga nem altera o CPF.
    await sequelize.query("UPDATE people.persons SET tax_id_normalized = '52998224726', tax_id_normalized_hash = NULL WHERE id = :id", { replacements: { id: p.id }, transaction: t });
    const editada = await peopleService.updatePerson(p.id, { preferredName: 'Apelido novo' }, tenant.userId, t);
    assert.equal(editada.preferredName, 'Apelido novo');
    assert.equal(editada.taxIdNormalized, '52998224726');
    assert.deepEqual(editada.dataQuality.revisao.map((r) => r.key), ['TAX_ID_DIGITO_INVALIDO']);
    const valida = await criar(t, { taxIdNormalized: randomCpf() });
    assert.deepEqual(valida.dataQuality.revisao, []);
  });
});

test('M3-02 VENDEDOR (citado no livro) é aceito no papel avulso e no corpo do cadastro, junto com outros papéis', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await criar(t, { roles: ['CLIENTE', 'VENDEDOR'] });
    assert.deepEqual(p.roles.map((r) => r.roleCode).sort(), ['CLIENTE', 'VENDEDOR']);
    await roles.createRole(p.id, { roleCode: 'proprietario' }, tenant.userId, t);
    const lista = await roles.listRoles(p.id, t);
    assert.deepEqual(lista.map((r) => r.roleCode).sort(), ['CLIENTE', 'PROPRIETARIO', 'VENDEDOR']);
    await assert.rejects(() => roles.createRole(p.id, { roleCode: 'INVESTIDOR' }, tenant.userId, t), (err) => {
      recusa('PERSON_ROLE_VALIDATION', 400)(err);
      assert.ok(err.details.aceitos.includes('VENDEDOR'));
      return true;
    });
  });
});

test('M3-02 a lista de papéis é o parâmetro people.papeis: papel novo passa a valer, os cinco do livro não podem sair', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const padrao = await roles.listRoleCatalog(tenant, t);
    for (const code of ['CLIENTE', 'PROPRIETARIO', 'VENDEDOR', 'LOCATARIO', 'FORNECEDOR']) assert.ok(padrao.some((r) => r.code === code), code);
    await assert.rejects(() => upsertSetting('people.papeis', 'CLIENTE=Cliente, PROPRIETARIO=Proprietário, LOCATARIO=Locatário, FORNECEDOR=Fornecedor', tenant, tenant.userId, t),
      (err) => { assert.equal(err.code, 'SETTING_INVALID_VALUE'); assert.match(err.message, /VENDEDOR/); return true; });
    await upsertSetting('people.papeis', 'CLIENTE=Cliente, PROPRIETARIO=Proprietário, VENDEDOR=Vendedor, LOCATARIO=Locatário, FORNECEDOR=Fornecedor, INVESTIDOR=Investidor', tenant, tenant.userId, t);
    const catalogo = await roles.listRoleCatalog(tenant, t);
    assert.deepEqual(catalogo.map((r) => r.code), ['CLIENTE', 'PROPRIETARIO', 'VENDEDOR', 'LOCATARIO', 'FORNECEDOR', 'INVESTIDOR']);
    const p = await criar(t, { roles: ['INVESTIDOR'] });
    assert.deepEqual(p.roles.map((r) => r.roleCode), ['INVESTIDOR']);
    await assert.rejects(() => roles.createRole(p.id, { roleCode: 'CORRETOR' }, tenant.userId, t), recusa('PERSON_ROLE_VALIDATION', 400));
  });
});
