'use strict';

// M9-D413 — definição da AutomationVersion: elementos obrigatórios, imutabilidade, versão única, N+1, pausa e retomada, validade e owner.
// Postgres real, role de runtime (RLS FORCE), transação com rollback. Só em banco descartável (o .env aponta para a homologação remota):
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/m9d413.definicao.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d413Fixtures');
const svc = require('../src/modules/marketing/automations/automations.service');
const catalog = require('../src/modules/marketing/automations/catalog');

let tenant;
let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const create = (t, input, who = tenant) => svc.createAutomation({ tenant: who, actor: tenant.userId, input }, t);
const publish = (t, flowId, input, who = tenant) => svc.publishAutomation({ tenant: who, actor: tenant.userId, flowId, input }, t);
const pause = (t, flowId, input = {}) => svc.pauseAutomation({ tenant, actor: tenant.userId, flowId, input }, t);
const rejects = (promise, status, code) => assert.rejects(promise, (e) => e.statusCode === status && e.code === code, `esperava ${status} ${code}`);
const REASON = 'Publicação aprovada pela gerência.';

test('automacao_exige_trigger_condicao_acao_cooldown_limite_e_owner', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const cases = {
      triggerType: { triggerType: undefined },
      'triggerConfig.eventType': { triggerConfig: { eventType: 'evento.inventado' } },
      conditions: { conditions: undefined },
      conditionsEmptyReason: { conditions: [] },
      actions: { actions: [] },
      cooldown: { cooldown: undefined },
      frequencyCap: { frequencyCap: { max: 0, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } },
      ownerUserId: { ownerUserId: undefined },
      riskLevel: { riskLevel: 'ALTISSIMO' },
    };
    for (const [field, over] of Object.entries(cases)) {
      await assert.rejects(create(t, fx.validBody(tenant, over)), (e) => {
        assert.equal(e.statusCode, 422, field);
        assert.equal(e.code, 'MKT_AUTOMATION_INCOMPLETE', field);
        assert.ok(e.details.items.some((i) => i.field === field), `${field} deve estar na lista: ${JSON.stringify(e.details.items)}`);
        return true;
      });
    }
    // vários itens ausentes de uma vez: a lista traz todos
    await assert.rejects(create(t, { name: 'QA-M9 vazia' }), (e) => e.code === 'MKT_AUTOMATION_INCOMPLETE' && e.details.items.length >= 6);
    // SCHEDULE exige cron de 5 campos e fuso
    await rejects(create(t, fx.validBody(tenant, { triggerType: 'SCHEDULE', triggerConfig: { cron: '* * * * * *', timeZone: 'America/Sao_Paulo' } })), 422, 'MKT_AUTOMATION_INCOMPLETE');
    const ok = await create(t, fx.validBody(tenant, { triggerType: 'SCHEDULE', triggerConfig: { cron: '*/5 8-18 * * 1-5', timeZone: 'America/Sao_Paulo' } }));
    assert.equal(ok.version.status, 'DRAFT');
    // sem condições, mas com justificativa: aceito
    assert.equal((await create(t, fx.validBody(tenant, { conditions: [], conditionsEmptyReason: 'Vale para todo lead.' }))).version.conditionsEmptyReason, 'Vale para todo lead.');
    // ação fora do catálogo
    await rejects(create(t, fx.validBody(tenant, { actions: [{ actionType: 'PAGAR_FORNECEDOR' }] })), 422, 'MKT_AUTOMATION_ACTION_UNKNOWN');
    assert.equal(catalog.ACTION_TYPES.length, 7);
    await rejects(create(t, fx.validBody(tenant, { actions: Array.from({ length: 11 }, () => ({ actionType: 'CREATE_TASK' })) })), 422, 'MKT_AUTOMATION_INCOMPLETE');
    await rejects(create(t, { ...fx.validBody(tenant), campoInventado: 1 }), 400, 'MKT_VALIDATION');
  });
});

test('owner_inativo_e_valid_until_menor_que_valid_from_sao_recusados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const other = await fx.otherUser(t, tenant);
    await fx.q(t, "UPDATE core.users SET status = 'INACTIVE' WHERE id = :id RETURNING id", { id: other });
    await assert.rejects(create(t, fx.validBody(tenant, { ownerUserId: other })), (e) => e.code === 'MKT_AUTOMATION_INCOMPLETE' && e.details.items.some((i) => i.field === 'ownerUserId'));
    await rejects(create(t, fx.validBody(tenant, { ownerUserId: fx.uid() })), 422, 'MKT_AUTOMATION_INCOMPLETE');
    await assert.rejects(create(t, fx.validBody(tenant, { validFrom: '2026-12-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z' })), (e) => e.details.items.some((i) => i.field === 'validUntil'));
    await rejects(create(t, fx.validBody(tenant, { validFrom: '2026-12-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z' })), 422, 'MKT_AUTOMATION_INCOMPLETE');
    // dono que ficou inativo depois do rascunho: publicar também recusa
    const flow = await create(t, fx.validBody(tenant));
    await fx.q(t, "UPDATE marketing.automation_flows SET owner_user_id = :o WHERE id = :f RETURNING id", { o: other, f: flow.flow.id });
    await rejects(publish(t, flow.flow.id, { versionNo: 1, reason: REASON }), 422, 'MKT_AUTOMATION_INCOMPLETE');
  });
});

test('nova_versao_n_mais_1_e_publicar_por_version_no', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await create(t, fx.validBody(tenant));
    assert.equal(v1.created, true);
    assert.equal(v1.flow.status, 'PAUSED');
    assert.equal(v1.version.versionNo, 1);
    const flowId = v1.flow.id;
    // versionNo ausente 422, inexistente 404
    await assert.rejects(publish(t, flowId, { reason: REASON }), (e) => e.code === 'MKT_AUTOMATION_INCOMPLETE' && e.details.items[0].field === 'versionNo');
    await rejects(publish(t, flowId, { versionNo: 9, reason: REASON }), 404, 'MKT_AUTOMATION_NOT_FOUND');
    await rejects(publish(t, flowId, { versionNo: 1 }), 400, 'MKT_REASON_REQUIRED');
    const p1 = await publish(t, flowId, { versionNo: 1, reason: REASON });
    assert.equal(p1.flow.status, 'ACTIVE');
    assert.equal(p1.flow.publishedVersionId, p1.version.id);
    // v2, v3, v4 copiam a última e mudam só o que o corpo manda
    const v2 = await create(t, { flowId, cooldown: { amount: 2, unit: 'DAYS' } });
    assert.equal(v2.created, false);
    assert.equal(v2.version.versionNo, 2);
    assert.deepEqual(v2.version.cooldown, { amount: 2, unit: 'DAYS' });
    assert.deepEqual(v2.version.actions, v1.version.actions);
    assert.equal((await create(t, { flowId })).version.versionNo, 3);
    assert.equal((await create(t, { flowId })).version.versionNo, 4);
    // v1 continua PUBLISHED até publicarem a escolhida: publicar a v4 aposenta a v1 e as DRAFT v2/v3 ficam
    const p4 = await publish(t, flowId, { versionNo: 4, reason: REASON });
    assert.deepEqual(p4.superseded, { versionNo: 1, status: 'SUPERSEDED' });
    assert.deepEqual(await fx.statuses(t, flowId), ['1:SUPERSEDED', '2:DRAFT', '3:DRAFT', '4:PUBLISHED']);
    assert.deepEqual(p4.versions.map((v) => `${v.versionNo}:${v.status}`), ['1:SUPERSEDED', '2:DRAFT', '3:DRAFT', '4:PUBLISHED']);
    // versão aposentada não volta
    await rejects(publish(t, flowId, { versionNo: 1, reason: REASON }), 409, 'MKT_AUTOMATION_VERSION_IMMUTABLE');
    // publicar a mesma versão de novo: replay, sem efeito
    const again = await publish(t, flowId, { versionNo: 4, reason: REASON });
    assert.equal(again.replay, true);
    assert.deepEqual(await fx.statuses(t, flowId), ['1:SUPERSEDED', '2:DRAFT', '3:DRAFT', '4:PUBLISHED']);
    await rejects(create(t, { flowId: fx.uid() }), 404, 'MKT_AUTOMATION_NOT_FOUND');
  });
});

test('versao_publicada_e_imutavel', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await create(t, fx.validBody(tenant));
    await publish(t, v1.flow.id, { versionNo: 1, reason: REASON });
    // o banco recusa mudar qualquer parte da definição publicada (gatilho MK003)
    for (const sql of [
      "UPDATE marketing.automation_versions SET actions = '[]'::jsonb WHERE id = :id",
      "UPDATE marketing.automation_versions SET cooldown = '{\"amount\":1,\"unit\":\"HOURS\"}'::jsonb WHERE id = :id",
      "UPDATE marketing.automation_versions SET conditions_empty_reason = 'mudou' WHERE id = :id",
      "UPDATE marketing.automation_versions SET valid_until = now() + interval '1 day' WHERE id = :id",
      "UPDATE marketing.automation_versions SET status = 'DRAFT' WHERE id = :id",
    ]) {
      await fx.q(t, 'SAVEPOINT s1');
      await assert.rejects(fx.q(t, sql, { id: v1.version.id }), (e) => /MKT_AUTOMATION_VERSION_IMMUTABLE/.test(e.message), sql);
      await fx.q(t, 'ROLLBACK TO SAVEPOINT s1');
    }
    // o conteúdo da versão 1 não mudou
    assert.deepEqual((await fx.versionRow(t, v1.flow.id, 1)).actions, v1.version.actions);
    // alterar = nova versão N+1 em DRAFT
    assert.equal((await create(t, { flowId: v1.flow.id, actions: [{ actionType: 'NOTIFY_USER' }] })).version.versionNo, 2);
  });
});

test('uma_unica_versao_publicada_por_fluxo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await create(t, fx.validBody(tenant));
    await create(t, { flowId: v1.flow.id });
    await publish(t, v1.flow.id, { versionNo: 1, reason: REASON });
    await publish(t, v1.flow.id, { versionNo: 2, reason: REASON });
    assert.deepEqual(await fx.statuses(t, v1.flow.id), ['1:SUPERSEDED', '2:PUBLISHED']);
    assert.equal((await fx.flowRow(t, v1.flow.id)).published_version_id, (await fx.versionRow(t, v1.flow.id, 2)).id);
    // o índice único condicional recusa uma segunda versão viva no mesmo fluxo, mesmo por SQL direto
    const third = await create(t, { flowId: v1.flow.id });
    await fx.q(t, 'SAVEPOINT s2');
    await assert.rejects(fx.q(t, "UPDATE marketing.automation_versions SET status = 'PUBLISHED' WHERE flow_id = :f AND version_no = 3 RETURNING id", { f: v1.flow.id }),
      (e) => /mkt_automation_versions_one_live_uq/.test(`${e.parent && e.parent.constraint} ${e.message}`));
    await fx.q(t, 'ROLLBACK TO SAVEPOINT s2');
    assert.equal(third.version.versionNo, 3);
  });
});

test('pausar_e_retomar_mudam_fluxo_e_versao_juntos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await create(t, fx.validBody(tenant));
    const flowId = v1.flow.id;
    assert.equal((await fx.flowRow(t, flowId)).status, 'PAUSED'); // recém-criado, só DRAFT
    await publish(t, flowId, { versionNo: 1, reason: REASON });
    assert.equal((await fx.flowRow(t, flowId)).status, 'ACTIVE');
    const paused = await pause(t, flowId, { reason: 'Campanha suspensa pela diretoria.' });
    assert.equal(paused.flow.status, 'PAUSED');
    assert.equal(paused.version.status, 'PAUSED');
    assert.equal((await fx.flowRow(t, flowId)).status, 'PAUSED');
    assert.equal((await fx.versionRow(t, flowId, 1)).status, 'PAUSED');
    assert.equal((await pause(t, flowId)).replay, true);
    // retomar = publicar de novo a versão PAUSED: os dois voltam juntos
    const resumed = await publish(t, flowId, { versionNo: 1, reason: 'Retomada após revisão do texto.' });
    assert.equal(resumed.resumed, true);
    assert.equal((await fx.flowRow(t, flowId)).status, 'ACTIVE');
    assert.equal((await fx.versionRow(t, flowId, 1)).status, 'PUBLISHED');
    // o estado ARCHIVED não existe
    await fx.q(t, 'SAVEPOINT s3');
    await assert.rejects(fx.q(t, "UPDATE marketing.automation_flows SET status = 'ARCHIVED' WHERE id = :f RETURNING id", { f: flowId }), (e) => /automation_flows_status_chk/.test(`${e.parent && e.parent.constraint}`));
    await fx.q(t, 'ROLLBACK TO SAVEPOINT s3');
    // pausar fluxo sem versão publicada não faz nada
    const draftOnly = await create(t, fx.validBody(tenant));
    assert.equal((await pause(t, draftOnly.flow.id)).replay, true);
    // publicar outra versão com a atual pausada: a pausada é aposentada e o fluxo volta a ACTIVE
    await pause(t, flowId);
    await create(t, { flowId });
    const p2 = await publish(t, flowId, { versionNo: 2, reason: REASON });
    assert.deepEqual(p2.superseded, { versionNo: 1, status: 'SUPERSEDED' });
    assert.equal(p2.flow.status, 'ACTIVE');
  });
});

test('pausar_nao_apaga_configuracao_e_e_auditada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await create(t, fx.validBody(tenant));
    const before = await fx.versionRow(t, v1.flow.id, 1);
    await publish(t, v1.flow.id, { versionNo: 1, reason: REASON });
    await pause(t, v1.flow.id, { reason: 'Pausa para ajuste do texto.' });
    const after = await fx.versionRow(t, v1.flow.id, 1);
    for (const col of ['trigger_type', 'trigger_config', 'conditions', 'actions', 'cooldown', 'frequency_cap', 'valid_from', 'risk_level', 'content_hash']) {
      assert.deepEqual(after[col], before[col], col);
    }
    const logs = await fx.q(t, "SELECT action, reason, before_json, after_json FROM audit.audit_log WHERE entity_id = :f AND action LIKE 'marketing.automation.%' ORDER BY created_at", { f: v1.flow.id });
    const actions = logs.map((l) => l.action);
    assert.ok(['marketing.automation.create_version', 'marketing.automation.publish', 'marketing.automation.pause'].every((a) => actions.includes(a)), actions.join(','));
    const pauseLog = logs.find((l) => l.action === 'marketing.automation.pause');
    assert.equal(pauseLog.before_json.flowStatus, 'ACTIVE');
    assert.equal(pauseLog.after_json.flowStatus, 'PAUSED');
    assert.equal(pauseLog.reason, 'Pausa para ajuste do texto.');
  });
});

test('fora_da_validade_nao_dispara', async () => {
  const version = { valid_from: '2026-11-01T00:00:00Z', valid_until: '2026-11-30T23:59:59Z' };
  assert.deepEqual(svc.evaluateValidity(version, new Date('2026-12-01T00:00:00Z')), { ok: false, reason: 'OUTSIDE_VALIDITY' });
  assert.deepEqual(svc.evaluateValidity(version, new Date('2026-10-31T23:59:59Z')), { ok: false, reason: 'OUTSIDE_VALIDITY' });
  assert.deepEqual(svc.evaluateValidity(version, new Date('2026-11-15T12:00:00Z')), { ok: true });
  assert.deepEqual(svc.evaluateValidity({ valid_from: '2026-11-01T00:00:00Z', valid_until: null }, new Date('2030-01-01T00:00:00Z')), { ok: true });
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v = await create(t, fx.validBody(tenant, { validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-11-30T00:00:00Z' }));
    assert.deepEqual(svc.evaluateValidity(v.version, new Date('2026-12-05T00:00:00Z')), { ok: false, reason: 'OUTSIDE_VALIDITY' });
  });
});

test('automacao_de_outra_empresa_nao_e_vista_nem_publicada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await create(t, fx.validBody(tenant));
    await withRollbackTenantTransaction(tenantB, async (tb) => {
      await rejects(publish(tb, v1.flow.id, { versionNo: 1, reason: REASON }, tenantB), 404, 'MKT_AUTOMATION_NOT_FOUND');
      await rejects(svc.pauseAutomation({ tenant: tenantB, actor: tenant.userId, flowId: v1.flow.id, input: {} }, tb), 404, 'MKT_AUTOMATION_NOT_FOUND');
      await rejects(create(tb, { flowId: v1.flow.id }, tenantB), 404, 'MKT_AUTOMATION_NOT_FOUND');
    });
    await rejects(publish(t, 'nao-e-uuid', { versionNo: 1, reason: REASON }), 404, 'MKT_AUTOMATION_NOT_FOUND');
  });
});
