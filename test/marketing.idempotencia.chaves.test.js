'use strict';

// M9-D415 — chaves de idempotência da run e da ação, dedupeKey do gatilho, plano de replay e reconciliação.
// Parte pura (sem banco) + run real sob RLS com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sequelize } = require('../src/models');
const idem = require('../src/features/marketing/automations/idempotency');
const { prepararTenants, mkFlow, mkAutoVersion, uid } = require('./helpers/marketingExecucao');
const { withRollbackTenantTransaction } = require('./testHelpers');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const NOW = new Date('2026-11-01T12:00:00Z');
const ago = (s) => new Date(NOW.getTime() - s * 1000);

test('chave_e_sha256_de_versao_evento_sujeito', () => {
  const v = uid(); const s = uid();
  const key = idem.runIdempotencyKey({ automationVersionId: v, triggerEventId: 'evt-9', subjectId: s });
  assert.equal(key, sha(`${v}:evt-9:${s}`));
  assert.match(key, /^[0-9a-f]{64}$/);
  // outro sujeito, outra run (regra 7)
  assert.notEqual(key, idem.runIdempotencyKey({ automationVersionId: v, triggerEventId: 'evt-9', subjectId: uid() }));
  const ak = idem.actionKey(key, 2, 'SEND_MESSAGE');
  assert.equal(ak, sha(`${key}:2:SEND_MESSAGE`));
  assert.notEqual(ak, idem.actionKey(key, 3, 'SEND_MESSAGE'));
  assert.throws(() => idem.runIdempotencyKey({ automationVersionId: v, triggerEventId: '', subjectId: s }), /MKT_|obrigat/i);
});

test('dedupe_key_do_gatilho_substitui_trigger_event_id', async () => {
  const cfg = { dedupeKey: 'radar:{radarId}:{propertyId}' };
  const r1 = idem.resolveTriggerEventId({ triggerConfig: cfg, payload: { radarId: 'R1', propertyId: 'P1' }, eventId: 'evt-A' });
  const r2 = idem.resolveTriggerEventId({ triggerConfig: cfg, payload: { radarId: 'R1', propertyId: 'P1' }, eventId: 'evt-B' });
  assert.equal(r1, 'radar:R1:P1');
  assert.equal(r1, r2);
  assert.equal(idem.resolveTriggerEventId({ triggerConfig: {}, payload: {}, eventId: 'evt-A' }), 'evt-A');
  assert.equal(idem.resolveTriggerEventId({ triggerConfig: { dedupeKey: 'x:{a.b}' }, payload: { a: { b: 7 } }, eventId: 'e' }), 'x:7');
  assert.throws(() => idem.resolveTriggerEventId({ triggerConfig: cfg, payload: { radarId: 'R1' }, eventId: 'evt-A' }), (e) => e.code === 'MKT_DEDUPE_KEY_INVALID');

  // dois eventos diferentes, mesmo dedupeKey: uma única run
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const flowId = await mkFlow(tenantA, tx);
    const versionId = await mkAutoVersion(tenantA, tx, flowId);
    const subjectId = uid();
    const comum = {
      tenant: tenantA, automationVersionId: versionId, triggerConfig: cfg, payload: { radarId: 'R1', propertyId: 'P1' },
      subjectType: 'PERSON', subjectId, correlationId: uid(),
    };
    const a = await idem.startRun({ ...comum, eventId: 'evt-A' }, { transaction: tx });
    const b = await idem.startRun({ ...comum, eventId: 'evt-B' }, { transaction: tx });
    assert.equal(a.replay, false);
    assert.equal(b.replay, true);
    assert.equal(b.code, 'MKT_RUN_REPLAY');
    assert.equal(a.run.id, b.run.id);
    assert.equal(a.run.triggerEventId, 'radar:R1:P1');
    assert.equal(a.run.idempotencyKey, idem.runIdempotencyKey({ automationVersionId: versionId, triggerEventId: 'radar:R1:P1', subjectId }));
  });
});

const entry = (i, status, extra = {}) => ({ action_key: `k${i}`, type: 'SEND_MESSAGE', index: i, status, due_at: null, provider_ref: null, error_code: null, ...extra });

test('replay_reexecuta_apenas_acoes_pendentes', async () => {
  const run = { status: 'FAILED', startedAt: ago(900), finishedAt: ago(800), actionsResult: [entry(0, 'OK'), entry(1, 'FAILED'), entry(2, 'PENDING'), entry(3, 'SKIPPED')] };
  const plan = await idem.prepareReplay({ run, now: NOW, timeoutS: 300 });
  assert.equal(plan.shouldReplay, true);
  assert.deepEqual(plan.pending.map((p) => p.index), [1, 2]);
  assert.deepEqual(plan.pending.map((p) => p.actionKey), ['k1', 'k2']);
  for (const status of ['COMPLETED', 'BLOCKED']) {
    const p = await idem.prepareReplay({ run: { ...run, status }, now: NOW, timeoutS: 300 });
    assert.equal(p.shouldReplay, false);
    assert.deepEqual(p.pending, []);
  }
  // STARTED recente está em andamento: não reexecuta; STARTED além do timeout reexecuta
  const recente = await idem.prepareReplay({ run: { ...run, status: 'STARTED', finishedAt: null, startedAt: ago(100) }, now: NOW, timeoutS: 300 });
  assert.equal(recente.shouldReplay, false);
  const travada = await idem.prepareReplay({ run: { ...run, status: 'STARTED', finishedAt: null, startedAt: ago(301) }, now: NOW, timeoutS: 300 });
  assert.equal(travada.shouldReplay, true);
  assert.deepEqual(travada.pending.map((p) => p.index), [1, 2]);
});

test('acao_unknown_reconcilia_antes_de_repetir', async () => {
  const run = { status: 'FAILED', startedAt: ago(900), finishedAt: ago(800), actionsResult: [entry(0, 'OK'), entry(1, 'UNKNOWN'), entry(2, 'UNKNOWN'), entry(3, 'UNKNOWN')] };
  const consultas = [];
  const adapter = {
    async findByActionKey(actionKey) {
      consultas.push(actionKey);
      if (actionKey === 'k1') return { found: true, providerRef: 'ext-1' };
      if (actionKey === 'k2') return { found: false };
      throw new Error('provedor fora do ar');
    },
  };
  const plan = await idem.prepareReplay({ run, now: NOW, timeoutS: 300, adapterFor: () => adapter });
  assert.deepEqual(consultas, ['k1', 'k2', 'k3']);
  // k1 existia no provedor: vira OK e NÃO repete; k2 não existia: repete; k3 sem resposta: segue UNKNOWN, não repete
  assert.deepEqual(plan.pending.map((p) => p.actionKey), ['k2']);
  const byKey = Object.fromEntries(plan.actionsResult.map((e) => [e.action_key, e]));
  assert.equal(byKey.k1.status, 'OK');
  assert.equal(byKey.k1.provider_ref, 'ext-1');
  assert.equal(byKey.k3.status, 'UNKNOWN');
  assert.equal(byKey.k3.error_code, 'MKT_ACTION_UNKNOWN');
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].message, 'Verificando a ação antes de repetir.');

  // sem adapter que saiba consultar: nunca repete às cegas
  const semAdapter = await idem.prepareReplay({ run, now: NOW, timeoutS: 300 });
  assert.deepEqual(semAdapter.pending, []);
  assert.equal(semAdapter.unresolved.length, 3);
});

test('action_key_de_acao_adiada_permanece_a_mesma', async () => {
  const runKey = idem.runIdempotencyKey({ automationVersionId: uid(), triggerEventId: 'e', subjectId: uid() });
  const inicial = idem.buildActionsResult(runKey, [{ type: 'SEND_MESSAGE' }, { type: 'CREATE_TASK' }]);
  assert.deepEqual(inicial.map((e) => e.status), ['PENDING', 'PENDING']);
  assert.equal(inicial[1].action_key, idem.actionKey(runKey, 1, 'CREATE_TASK'));
  const due = new Date(NOW.getTime() + 3600e3);
  const adiada = idem.markScheduled(inicial, 1, due);
  assert.equal(adiada[1].status, 'SCHEDULED');
  assert.equal(adiada[1].action_key, inicial[1].action_key);
  assert.equal(new Date(adiada[1].due_at).getTime(), due.getTime());
  assert.equal(idem.nextDueAt(adiada).getTime(), due.getTime());

  // run WAITING parada há horas NÃO é run travada
  const waiting = { status: 'WAITING', startedAt: ago(36000), finishedAt: null, nextDueAt: due, actionsResult: adiada };
  assert.equal(idem.isRunStuck(waiting, 300, NOW), false);
  assert.equal((await idem.prepareReplay({ run: waiting, now: NOW, timeoutS: 300 })).shouldReplay, false);
  // após o vencimento, a ação segue pendente com a MESMA chave
  const vencida = { ...waiting, status: 'FAILED', finishedAt: ago(10) };
  const depois = await idem.prepareReplay({ run: vencida, now: new Date(due.getTime() + 1000), timeoutS: 300 });
  assert.ok(depois.pending.some((p) => p.actionKey === inicial[1].action_key));
  // antes do vencimento a ação adiada não é reexecutada
  const antes = await idem.prepareReplay({ run: vencida, now: NOW, timeoutS: 300 });
  assert.ok(!antes.pending.some((p) => p.actionKey === inicial[1].action_key));
});

test('timeout_do_runner_vem_da_configuracao_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    assert.equal(await idem.getRunnerTimeoutS(tenantA, tx), 300);
    const settings = require('../src/features/settings/settings.service');
    assert.ok(settings.SETTINGS_SCHEMA['marketing.runner.timeout_s'], 'parâmetro declarado no SETTINGS_SCHEMA');
  });
});
