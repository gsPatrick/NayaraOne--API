'use strict';

// M9-D806 — avaliação "na gravação do cadastro": roda uma vez por cadastro no fim da transação da requisição, antes do commit, e uma falha da avaliação
// não derruba a gravação. Usa o mesmo req.withTenantTransaction da API. Banco descartável (ver m9d806.score.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d806Env');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const { Person, PersonContact } = require('../../../src/models');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');
const { installQualityHooks } = require('../../../src/features/core-governance/data-quality/quality.hooks');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { installQualityHooks(); if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

/** req mínimo + o middleware real de tenant: devolve req.withTenantTransaction como a API usa. */
function requestOf(tenant) {
  const req = { auth: { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, body: {}, headers: {}, method: 'POST', path: '/x', originalUrl: '/x' };
  tenantMiddleware(req, {}, () => {});
  return req;
}
const issuesOf = async (personId) => (await adminQuery('SELECT rule_code, status FROM governance.quality_issues WHERE entity_id = $1 ORDER BY rule_code', [personId])).rows;

test('m9d806 salvar cadastro incompleto abre as issues e calcula a nota, uma vez, antes do commit', { skip: skip() }, async () => {
  const A = tenants.A;
  const req = requestOf(A);
  const person = await req.withTenantTransaction(async (tx) => {
    const created = await Person.create({ groupId: A.groupId, companyId: A.companyId, personType: 'PF', legalName: 'Cadastro Incompleto Gravacao', taxIdNormalized: env.cpf(), createdBy: A.userId, updatedBy: A.userId }, { transaction: tx });
    await PersonContact.create({ groupId: A.groupId, companyId: A.companyId, personId: created.id, contactType: 'PHONE', valueNormalized: '11977776666', isPrimary: true, createdBy: A.userId, updatedBy: A.userId }, { transaction: tx });
    return created;
  });
  const rules = (await issuesOf(person.id)).map((r) => r.rule_code);
  assert.deepEqual(rules, ['PERSON_ADDRESS_COMPLETE', 'PERSON_BIRTH_COHERENT', 'PERSON_ROLE_DEFINED'], 'o contato gravado na mesma requisição já conta: sem issue de estado intermediário');
  const { rows: [score] } = await adminQuery('SELECT score FROM governance.quality_scores WHERE entity_id = $1', [person.id]);
  assert.equal(Number(score.score), 65);
  const { rows: events } = await adminQuery("SELECT 1 FROM integration.outbox_events WHERE event_type = 'data.quality.issue.opened' AND payload_json->>'entityId' = $1", [person.id]);
  assert.equal(events.length, 3);
});

test('m9d806 corrigir o dado na próxima gravação resolve a issue', { skip: skip() }, async () => {
  const A = tenants.A;
  const person = await requestOf(A).withTenantTransaction((tx) => env.fullPerson(A, tx, { legalName: 'Cadastro Corrigido Gravacao' }, { birth: false }));
  assert.deepEqual(await issuesOf(person.id), [{ rule_code: 'PERSON_BIRTH_COHERENT', status: 'OPEN' }]);
  await requestOf(A).withTenantTransaction(async (tx) => {
    const row = await Person.findByPk(person.id, { transaction: tx });
    row.birthOrFoundationDate = '1990-02-02';
    row.updatedBy = A.userId;
    await row.save({ transaction: tx });
  });
  assert.deepEqual(await issuesOf(person.id), [{ rule_code: 'PERSON_BIRTH_COHERENT', status: 'RESOLVED' }]);
});

test('m9d806 módulo desligado não avalia e erro da avaliação não derruba a gravação', { skip: skip() }, async () => {
  const A = tenants.A;
  await withTenantTransaction(A, (tx) => upsertSetting('governanca.modulos.data_quality.habilitado', false, A, A.userId, tx));
  try {
    const req = requestOf(A);
    const person = await req.withTenantTransaction((tx) => Person.create({ groupId: A.groupId, companyId: A.companyId, personType: 'PF', legalName: 'Modulo Desligado Gravacao', createdBy: A.userId, updatedBy: A.userId }, { transaction: tx }));
    assert.deepEqual(await issuesOf(person.id), []);
  } finally {
    await withTenantTransaction(A, (tx) => upsertSetting('governanca.modulos.data_quality.habilitado', true, A, A.userId, tx));
  }
  const evaluate = require('../../../src/features/core-governance/data-quality/quality.evaluate');
  const original = evaluate.evaluateEntity;
  evaluate.evaluateEntity = async () => { throw new Error('falha simulada'); };
  try {
    const req = requestOf(A);
    const person = await req.withTenantTransaction((tx) => Person.create({ groupId: A.groupId, companyId: A.companyId, personType: 'PF', legalName: 'Falha Simulada Gravacao', createdBy: A.userId, updatedBy: A.userId }, { transaction: tx }));
    const { rows } = await adminQuery('SELECT id FROM people.persons WHERE id = $1', [person.id]);
    assert.equal(rows.length, 1, 'o cadastro foi gravado mesmo com a avaliação falhando');
  } finally { evaluate.evaluateEntity = original; }
});
