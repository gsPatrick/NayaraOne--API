'use strict';

// Pontos da conferência de aceite do Marco 9 (Nayara): trilha de auditoria de quem cadastra pessoa e registra consentimento,
// execução concluída de automação com linha própria, e ação com campo obrigatório faltando barrada na publicação.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const personService = require('../../../src/features/people/person.service');
const consentsService = require('../../../src/features/people/personConsents.service');
const { collectProblems } = require('../../../src/features/marketing/automations/definition.validation');
const { emitEnd } = require('../../../src/features/marketing/automations/runner/runner.events');

after(async () => { await sequelize.close(); });

const audit = (transaction, action, entityId) => sequelize.query(
  'SELECT user_id, action, entity_type, entity_id, reason, occurred_at FROM audit.audit_log WHERE action = :action AND entity_id = :entityId',
  { replacements: { action, entityId }, type: sequelize.QueryTypes.SELECT, transaction }
);

test('cadastrar pessoa e registrar consentimento deixam linha de auditoria com quem, o quê e quando', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await personService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Trilha ${uniqueSuffix()}`, allowDuplicate: true }, tenant.userId, transaction);
    const [criada] = await audit(transaction, 'people.person.create', person.id);
    assert.ok(criada, 'sem linha de auditoria do cadastro');
    assert.equal(criada.user_id, tenant.userId);
    assert.ok(criada.occurred_at);

    const consent = await consentsService.recordConsent(person.id, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_OUT' }, tenant.userId, transaction);
    const [linha] = await audit(transaction, 'people.consent.record', consent.id);
    assert.ok(linha, 'sem linha de auditoria do consentimento');
    assert.equal(linha.user_id, tenant.userId);
    assert.match(linha.reason, /opt-out/);
  });
});

test('execução de automação concluída grava a linha de auditoria da conclusão', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const run = { id: '00000000-0000-4000-8000-0000000000a1', correlation_id: '00000000-0000-4000-8000-0000000000b1' };
    await emitEnd({ tenant, run, status: 'COMPLETED', entries: [{ type: 'NOTIFY_USER', status: 'OK' }] }, transaction);
    const [linha] = await audit(transaction, 'marketing.automation_run.completed', run.id);
    assert.ok(linha, 'sem linha de auditoria da conclusão');
    assert.equal(linha.entity_type, 'MarketingAutomationRun');
  });
});

test('ação sem o campo que o executor exige vira pendência na definição, não falha na execução', () => {
  const base = { triggerType: 'EVENT', actions: [] };
  const campos = (action) => collectProblems({ ...base, actions: [action] }).filter((p) => p.field.startsWith('actions[0]')).map((p) => p.field);
  assert.deepEqual(campos({ actionType: 'NOTIFY_USER' }), ['actions[0].title']);
  assert.deepEqual(campos({ actionType: 'NOTIFY_USER', title: '   ' }), ['actions[0].title']);
  assert.deepEqual(campos({ actionType: 'NOTIFY_USER', title: 'Aviso' }), []);
  assert.deepEqual(campos({ actionType: 'CREATE_TASK' }), ['actions[0].title']);
  assert.deepEqual(campos({ actionType: 'UPDATE_CRM_STAGE_TAG' }), ['actions[0].stage']);
  assert.deepEqual(campos({ actionType: 'UPDATE_CRM_STAGE_TAG', temperature: 'HOT' }), []);
});
