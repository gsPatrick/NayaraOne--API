'use strict';

// M9-D806 — issues de qualidade: abertura, evento uma vez, resolução, fila de revisão (D805) para CRITICAL. Banco descartável (ver m9d806.score.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d806Env');
const { evaluateEntity } = require('../../../src/features/core-governance/data-quality/quality.evaluate');
const { handleIssueOpened } = require('../../../src/features/core-governance/data-quality/quality.review');
const { Person } = require('../../../src/models');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const evaluate = (tx, id) => evaluateEntity(A(), 'PERSON', id, tx, { actorUserId: A().userId });
const reviews = (tx, id) => env.queueRows(A(), tx, "kind = 'REVIEW' AND primary_id = :id", { id });

test('m9d806 issue nova publica data.quality.issue.opened uma vez (replay: 1 issue, 1 evento)', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.fullPerson(A(), tx, {}, { contact: false });
    const first = await evaluate(tx, person.id);
    const second = await evaluate(tx, person.id);
    assert.equal(first.opened.length, 1);
    assert.equal(second.opened.length, 0, 'a segunda avaliação não abre nada');
    const rows = await env.issues(A(), person.id, tx);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].rule_code, rows[0].severity, rows[0].status], ['PERSON_CONTACT_PRESENT', 'MEDIUM', 'OPEN']);
    const events = await env.outboxEvents(person.id, tx);
    assert.equal(events.length, 1);
    assert.equal(events[0].idempotency_key, `data.quality.issue.opened:${rows[0].id}`);
    assert.deepEqual(events[0].payload_json, { issueId: rows[0].id, entityType: 'PERSON', entityId: person.id, ruleCode: 'PERSON_CONTACT_PRESENT', severity: 'MEDIUM' });
  });
});

test('m9d806 correção resolve a issue sozinha e registra a resolução na auditoria', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.fullPerson(A(), tx, {}, { contact: false });
    await evaluate(tx, person.id);
    await env.contact(A(), tx, person.id, '11988887777');
    const result = await evaluate(tx, person.id);
    assert.equal(result.resolved.length, 1);
    const [issue] = await env.issues(A(), person.id, tx);
    assert.equal(issue.status, 'RESOLVED');
    assert.ok(issue.resolved_at);
    const audits = await env.query("SELECT action FROM audit.audit_log WHERE entity_id = :id AND action LIKE 'governance.quality_issue.%' ORDER BY occurred_at", { id: issue.id }, tx);
    assert.deepEqual(audits.map((a) => a.action), ['governance.quality_issue.opened', 'governance.quality_issue.resolved']);
  });
});

test('m9d806 issue CRITICAL entra na fila de revisão do steward a partir do evento', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { user } = await env.steward(A(), tx, ['PESSOAS']);
    const person = await env.fullPerson(A(), tx, { taxIdNormalized: env.invalidCpf() });
    const result = await evaluate(tx, person.id);
    assert.deepEqual(result.opened.map((i) => i.severity), ['CRITICAL']);
    const [item] = await reviews(tx, person.id);
    assert.ok(item, 'item REVIEW criado');
    assert.deepEqual([item.entity_type, item.kind, item.status, item.reason_code], ['PERSON', 'REVIEW', 'OPEN', 'QUALITY_CRITICAL']);
    const [issue] = await env.issues(A(), person.id, tx);
    assert.equal(issue.assigned_steward_id, user.id, 'a issue vai para o steward do domínio');
    // O mesmo payload do evento, entregue de novo, não cria outro item (um REVIEW aberto por cadastro).
    const [event] = await env.outboxEvents(person.id, tx);
    await handleIssueOpened(A(), event.payload_json, tx);
    assert.equal((await reviews(tx, person.id)).length, 1);
  });
});

test('m9d806 issue só MEDIUM não cria item de revisão', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.fullPerson(A(), tx, {}, { contact: false });
    await evaluate(tx, person.id);
    assert.equal((await reviews(tx, person.id)).length, 0);
  });
});

test('m9d806 issue CRITICAL reaberta não duplica o item REVIEW', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.fullPerson(A(), tx, { taxIdNormalized: env.invalidCpf() });
    await evaluate(tx, person.id);
    await Person.update({ taxIdNormalized: env.cpf() }, { where: { id: person.id }, transaction: tx });
    assert.equal((await evaluate(tx, person.id)).resolved.length, 1);
    await Person.update({ taxIdNormalized: env.invalidCpf() }, { where: { id: person.id }, transaction: tx });
    const reopened = await evaluate(tx, person.id);
    assert.equal(reopened.opened.length, 1);
    const issues = await env.issues(A(), person.id, tx);
    assert.deepEqual(issues.map((i) => i.status).sort(), ['OPEN', 'RESOLVED']);
    assert.equal((await env.outboxEvents(person.id, tx)).length, 2, 'cada issue nova publica o seu evento');
    assert.equal((await reviews(tx, person.id)).length, 1, 'continua um REVIEW só');
  });
});
