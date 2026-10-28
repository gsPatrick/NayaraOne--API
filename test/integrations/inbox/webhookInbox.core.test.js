'use strict';

// Marco 9, M9-D203 — integration.webhook_inbox: dedup, adulteração, worker, estados, RLS, headers.
// Roda em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 <arquivo>

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, corpo, receber, prefixo } = require('./inboxHelpers');
const { IntegrationWebhookInbox, IntegrationError, AuditLog } = require('../../../src/models');
const inbox = require('../../../src/features/integrations/inbox');

let tenant;
let outro;
const PROV = 'qa-m9-d203-prov';

before(async () => { ({ tenant, outro } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

const linhas = (provider, eventId) => comTenant(tenant, (t) => IntegrationWebhookInbox.findAll({ where: { providerCode: provider, externalEventId: eventId }, transaction: t }));
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });

test('inbox_unique_provider_event', async () => {
  const id = prefixo();
  const [a, b] = await Promise.all([receber(tenant, PROV, id), receber(tenant, PROV, id)]);
  assert.deepEqual([a.status, b.status].sort(), ['accepted', 'duplicate']);
  assert.equal((await linhas(PROV, id)).length, 1, 'UNIQUE impede a segunda linha mesmo sob duas conexões');
  await assert.rejects(
    comTenant(tenant, (t) => sequelize.query(
      `INSERT INTO integration.webhook_inbox (group_id, company_id, provider_code, external_event_id, signature_valid, payload_hash)
       VALUES (:g, :c, :p, :e, true, :h)`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, p: PROV, e: id, h: 'a'.repeat(64) }, transaction: t }
    )),
    /duplicate key|unique/i
  );
});

test('inbox_duplicado_nao_reprocessa', async () => {
  const id = prefixo();
  const antes = await inbox.duplicatesCount(PROV);
  let handlerChamado = 0;
  const resultados = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await receber(tenant, PROV, id);
    if (r.status === 'accepted') handlerChamado += 1;
    resultados.push(r);
  }
  assert.equal(resultados[0].status, 'accepted');
  assert.ok(resultados.slice(1).every((r) => r.status === 'duplicate' && r.mismatch === false));
  assert.equal(handlerChamado, 1);
  assert.equal((await linhas(PROV, id)).length, 1, '1 linha, nenhuma linha extra');
  assert.equal((await inbox.duplicatesCount(PROV)) - antes, 4, '4 duplicados contados na métrica');
  await assert.rejects(receber(tenant, PROV, '  '), (e) => e.statusCode === 400 && e.code === 'INTEGRATION_WEBHOOK_EVENT_ID_MISSING');
  await assert.rejects(
    inbox.receiveEvent({ groupId: tenant.groupId }, { providerCode: PROV, externalEventId: id, rawBody: corpo() }, null),
    (e) => e.statusCode === 404 && e.code === 'INTEGRATION_WEBHOOK_UNKNOWN_CHANNEL'
  );
});

test('inbox_duplicado_hash_diferente_registra_erro', async () => {
  const id = prefixo();
  const original = await receber(tenant, PROV, id, { raw: corpo({ v: 1 }) });
  const adulterado = await receber(tenant, PROV, id, { raw: corpo({ v: 2 }) });
  assert.equal(adulterado.status, 'duplicate');
  assert.equal(adulterado.mismatch, true);
  const [linha] = await linhas(PROV, id);
  assert.equal(linha.payloadHash, original.payloadHash, 'o original foi mantido');
  const erros = await comTenant(tenant, (t) => IntegrationError.findAll({ where: { errorCode: 'WEBHOOK_PAYLOAD_MISMATCH', financingCaseId: linha.id }, transaction: t }));
  assert.equal(erros.length, 1);
  assert.equal(erros[0].severity, 'HIGH');
  assert.equal(erros[0].source, 'WEBHOOK');
  assert.ok(!JSON.stringify(erros[0].sanitizedPayload).includes('valor'), 'o corpo não vai para o erro');
});

test('inbox_worker_skip_locked', async () => {
  const p = `${PROV}-w`;
  const ids = Array.from({ length: 6 }, (_, i) => `${prefixo()}-${i}`);
  for (const id of ids) await receber(tenant, p, id);
  const tA = await sequelize.transaction();
  const tB = await sequelize.transaction();
  try {
    for (const t of [tA, tB]) {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    }
    // Os dois workers pegam ao mesmo tempo, com as transações ainda abertas: SKIP LOCKED separa os conjuntos.
    const a = (await inbox.claimBatch(ctx(), 100, tA)).filter((r) => r.providerCode === p);
    const b = (await inbox.claimBatch(ctx(), 100, tB)).filter((r) => r.providerCode === p);
    const idsA = new Set(a.map((r) => r.id));
    assert.ok(a.length >= 1, 'o primeiro worker pegou linhas');
    assert.ok(b.every((r) => !idsA.has(r.id)), 'nenhuma linha pega por dois workers');
    assert.equal(a.length + b.length, 6, 'todas pegas, cada uma uma vez');
    assert.ok([...a, ...b].every((r) => r.status === 'PROCESSING' && r.attempts === 1));
    await tA.commit();
    await tB.commit();
  } catch (e) { await tA.rollback().catch(() => {}); await tB.rollback().catch(() => {}); throw e; }
  const depois = await comTenant(tenant, (t) => inbox.claimBatch(ctx(), 500, t).then((r) => r.filter((x) => x.providerCode === p)));
  assert.equal(depois.length, 0, 'cada linha foi processada uma vez');
});

test('inbox_estados_transicoes', async () => {
  for (const de of inbox.STATUSES) {
    for (const para of inbox.STATUSES) {
      const valida = (inbox.TRANSITIONS[de] || []).includes(para);
      if (valida) inbox.assertTransition(de, para);
      else assert.throws(() => inbox.assertTransition(de, para), (e) => e.statusCode === 500 && e.code === 'INTEGRATION_INBOX_INVALID_TRANSITION');
    }
  }
  assert.deepEqual(inbox.TRANSITIONS.RECEIVED, ['PROCESSING', 'DEAD_LETTER']);
  assert.deepEqual(inbox.TRANSITIONS.PROCESSED, []);

  // Fluxo completo com auditoria antes/depois e fila morta ao esgotar as tentativas (padrão 6).
  const id = prefixo();
  await receber(tenant, PROV, id);
  for (let i = 1; i <= 6; i += 1) {
    await comTenant(tenant, async (t) => {
      const linha = await IntegrationWebhookInbox.findOne({ where: { providerCode: PROV, externalEventId: id }, transaction: t, lock: t.LOCK.UPDATE });
      if (linha.status === 'FAILED') await linha.update({ nextAttemptAt: new Date(Date.now() - 1000) }, { transaction: t });
      const pegos = await inbox.claimBatch(ctx(), 500, t);
      const pego = pegos.find((r) => r.id === linha.id);
      assert.equal(pego.attempts, i);
      await inbox.markFailed(ctx(), pego, `falha ${i}`, t);
    });
  }
  const [final] = await linhas(PROV, id);
  assert.equal(final.status, 'DEAD_LETTER');
  assert.equal(final.deadLetterReason, 'ATTEMPTS_EXHAUSTED');
  assert.ok(final.payloadRaw, 'tentativas esgotadas guardam o corpo bruto para reprocessar');
  const auditorias = await comTenant(tenant, (t) => AuditLog.count({ where: { entityType: 'IntegrationWebhookInbox', entityId: final.id, action: 'integration.webhook.status_changed' }, transaction: t }));
  assert.ok(auditorias >= 13, `mudanças auditadas (${auditorias})`);

  // Schema inválido: RECEIVED -> DEAD_LETTER direto, sem corpo.
  const inv = prefixo();
  await receber(tenant, PROV, inv);
  await comTenant(tenant, async (t) => {
    const linha = await IntegrationWebhookInbox.findOne({ where: { providerCode: PROV, externalEventId: inv }, transaction: t, lock: t.LOCK.UPDATE });
    await inbox.rejectInvalid(ctx(), linha, 'campo obrigatório ausente', t);
  });
  const [invalida] = await linhas(PROV, inv);
  assert.equal(invalida.status, 'DEAD_LETTER');
  assert.equal(invalida.payloadRaw, null, 'dado inválido nunca guarda o corpo');
  assert.equal(invalida.payload, null);
  assert.equal(invalida.attempts, 0, 'sem retry');
});

test('inbox_rls_isolamento', async (t0) => {
  if (!outro) { t0.skip('sem a empresa B do seed'); return; }
  const id = prefixo();
  await receber(tenant, PROV, id);
  const vistoPorB = await comTenant(outro, (t) => IntegrationWebhookInbox.findAll({ where: { externalEventId: id }, transaction: t }));
  assert.equal(vistoPorB.length, 0, 'a empresa B não lê o evento da A');
  await assert.rejects(
    comTenant(outro, (t) => sequelize.query(
      `INSERT INTO integration.webhook_inbox (group_id, company_id, provider_code, external_event_id, signature_valid, payload_hash)
       VALUES (:g, :c, 'qa', :e, true, :h)`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, e: prefixo(), h: 'b'.repeat(64) }, transaction: t }
    )),
    /row-level security/i
  );
});

test('inbox_cabecalho_authorization_nao_gravado', async () => {
  const id = prefixo();
  await receber(tenant, PROV, id, {
    headers: { Authorization: 'Bearer segredo-xyz', Cookie: 'sid=1', 'X-Request-Id': 'req-1', 'Content-Type': 'application/json', 'X-Outro': 'nao-permitido' },
  });
  const [linha] = await linhas(PROV, id);
  assert.deepEqual(linha.headersJson, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
  assert.ok(!JSON.stringify(linha.headersJson).toLowerCase().includes('segredo'));
});
