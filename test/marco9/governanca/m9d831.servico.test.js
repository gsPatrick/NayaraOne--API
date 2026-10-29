'use strict';

// M9-D831 — operações manuais de contingência pelo serviço, em banco descartável: UNIQUE da referência, numeração, evidência, datas, evento, concorrência, separação do efeito
// de negócio, destino único do payload inválido, edição e vínculo de setor.
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d831.servico.test.js"
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/bcpEnv');
const service = require('../../../src/features/core-governance/bcp/manualOperation.service');

let A;
let B;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const { failure } = env;

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A, B } = await env.loadTenants());
  await env.cleanBcp();
});
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await env.cleanBcp();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR'], ATENDIMENTO: ['CI GESTOR'], LOCACAO: ['CI GESTOR'], CORRESPONDENTE: ['CI GESTOR'], JURIDICO: ['CI GESTOR'] });
  await env.setSectorRoles(B, { FINANCEIRO: ['CI GESTOR'] });
});
after(async () => { if (env.DISPOSABLE) { await env.cleanBcp(); await env.sequelize.close(); } });

// Cada teste parte de A e B com o setor FINANCEIRO (e os demais em A) para o gestor; o hook acima repõe isso depois de limpar.
test('m9d831 preparo: o gestor das duas empresas tem setor', { skip: skip() }, async () => {
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR'], ATENDIMENTO: ['CI GESTOR'], LOCACAO: ['CI GESTOR'], CORRESPONDENTE: ['CI GESTOR'], JURIDICO: ['CI GESTOR'] });
  await env.setSectorRoles(B, { FINANCEIRO: ['CI GESTOR'] });
  const op = await env.record(A);
  assert.equal(op.status, 'RECORDED');
});

test('m9d831 referência manual é UNIQUE por empresa', { skip: skip() }, async () => {
  const ref = env.reference('FIN');
  const first = await env.record(A, { manualReference: ref });
  assert.equal(first.manualReference, ref);
  const dup = await failure(env.record(A, { manualReference: ref }));
  assert.deepEqual([dup.status, dup.code, dup.message], [409, 'GOV_BCP_REFERENCE_DUPLICATE', 'Este número de formulário já foi registrado.']);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.manual_operations WHERE manual_reference = $1', [ref])).rows[0].n, 1);
  const other = await env.record(B, { manualReference: ref });
  assert.equal(other.companyId, B.companyId, 'a mesma referência vale em outra empresa');
  assert.equal((await env.outbox(`bcp.manual_operation.recorded:${B.companyId}:${ref}`)).length, 1, 'e publica o próprio evento sem colidir com o da outra empresa');
  const columns = (await env.adminQuery("SELECT 1 FROM pg_constraint WHERE conname = 'gov_manual_op_ref_uq' AND contype = 'u'")).rowCount;
  assert.equal(columns, 1, 'a restrição UNIQUE (company_id, manual_reference) existe');
});

test('m9d831 todo registro tem setor, momento, ator, evidência e intended_action', { skip: skip() }, async () => {
  const op = await env.record(A, { occurredAt: '2026-10-20T09:30' });
  const row = await env.opRow(op.id);
  assert.equal(row.sector, 'FINANCEIRO');
  assert.equal(row.actor_user_id, A.userId);
  assert.ok(row.evidence_file_id && row.recorded_at && row.occurred_at);
  assert.equal(row.intended_action, 'RECEIVE_PAYMENT');
  assert.equal(row.form_type, 'RECEBIMENTO');
  assert.match(row.correlation_ref, /^[0-9a-f-]{36}$/);
  assert.deepEqual(row.validation_errors, []);
  assert.equal(row.status, 'RECORDED');
});

test('m9d831 número com prefixo de outro setor ou formato inválido recusado', { skip: skip() }, async () => {
  for (const bad of ['ATD-2026-00417', 'FIN-2026-417', 'FIN-26-00417', 'fin-2026-00417', 'FIN-2026-00417-X', 'FIN-2026-00000', '', null, 42, 'OBR-REQ-0001']) {
    const err = await failure(env.record(A, { manualReference: bad }));
    assert.deepEqual([err && err.status, err && err.code, err && err.message], [422, 'GOV_BCP_REFERENCE_INVALID', 'O número do formulário é inválido para este setor.'], String(bad));
  }
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.manual_operations')).rows[0].n, 0);
});

test('m9d831 formato único e os seis prefixos do catálogo valem cada um no seu setor', { skip: skip() }, async () => {
  const cases = [
    ['ATENDIMENTO', 'ATD', 'LEAD_ATENDIMENTO', 'REGISTER_LEAD', { nome: 'Ana', telefone: '11999998888', interesse: 'COMPRA', origem: 'Site' }],
    ['LOCACAO', 'LOC', 'ENTREGA_CHAVE', 'REGISTER_KEY_DELIVERY', { contrato: 'C-1', imovel: 'I-1', recebedor: 'Rui', documentoRecebedor: '12345678909', quantidadeChaves: 2, data: '2026-10-20' }],
    ['FINANCEIRO', 'FIN', 'RECEBIMENTO', 'RECEIVE_PAYMENT', env.RECEBIMENTO],
    ['OBRAS', 'OBR', 'REQUISICAO_MATERIAL', 'MATERIAL_REQUEST', { obra: 'O-1', material: 'Cimento', quantidade: 10, unidade: 'sc', urgencia: 'ALTA', solicitante: 'Zé' }],
    ['CORRESPONDENTE', 'COR', 'ANDAMENTO_PROCESSO', 'REGISTER_CASE_PROGRESS', { processo: 'P-1', etapa: 'Análise', situacao: 'Em análise', data: '2026-10-20' }],
    ['JURIDICO', 'JUR', 'PRAZO_INTIMACAO', 'REGISTER_DEADLINE', { processo: 'P-9', tipo: 'PRAZO', dataCiencia: '2026-10-20', dataFinalPrazo: '2026-11-03', descricao: 'Contestação', conferidoPor: 'Dra. Lia' }],
  ];
  for (const [sector, prefix, formType, intendedAction, payload] of cases) {
    const op = await env.record(A, { sector, manualReference: env.reference(prefix), formType, intendedAction, payload });
    assert.deepEqual([op.sector, op.status, op.validationErrors], [sector, 'RECORDED', []], sector);
  }
  const wrong = await failure(env.record(A, { sector: 'OBRAS', manualReference: env.reference('FIN'), formType: 'DIARIO_OBRA', intendedAction: 'DAILY_REPORT', payload: env.DIARIO }));
  assert.equal(wrong.code, 'GOV_BCP_REFERENCE_INVALID', 'prefixo FIN em operação de OBRAS');
});

test('m9d831 sem evidência recusado', { skip: skip() }, async () => {
  for (const missing of [null, '', 'não-é-uuid', '00000000-0000-4000-8000-000000000000']) {
    const err = await failure(env.record(A, { evidenceFileId: missing }));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_BCP_EVIDENCE_REQUIRED', 'Anexe a foto ou o escaneamento do formulário.'], String(missing));
  }
  assert.equal(await failure(env.record(A)), null, 'com a foto gravada pelo auxiliar o registro passa');
  const otherCompanyFile = await env.evidence(B);
  const crossed = await failure(env.record(A, { evidenceFileId: otherCompanyFile }));
  assert.equal(crossed.code, 'GOV_BCP_EVIDENCE_REQUIRED', 'a foto de outra empresa não vale');
});

test('m9d831 data futura recusada e data de Brasília interpretada sem fuso', { skip: skip() }, async () => {
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  for (const bad of [tomorrow, '2999-01-01', '2026-02-30', '2026-13-01T10:00', 'ontem', '', null, '2026-10-20T25:00']) {
    const err = await failure(env.record(A, { occurredAt: bad }));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_BCP_DATE_INVALID', 'A data da operação é inválida.'], String(bad));
  }
  const local = await env.record(A, { occurredAt: '2026-03-10T10:00' });
  assert.equal(new Date(local.occurredAt).toISOString(), '2026-03-10T13:00:00.000Z', 'sem fuso vale America/Sao_Paulo (UTC-3)');
  const withZone = await env.record(A, { occurredAt: '2026-03-10T10:00:00Z' });
  assert.equal(new Date(withZone.occurredAt).toISOString(), '2026-03-10T10:00:00.000Z', 'com fuso vale como informado');
  const dateOnly = await env.record(A, { occurredAt: '2026-03-10' });
  assert.equal(new Date(dateOnly.occurredAt).toISOString(), '2026-03-10T03:00:00.000Z');
});

test('m9d831 evento recorded publicado uma vez', { skip: skip() }, async () => {
  const ref = env.reference('FIN');
  const op = await env.record(A, { manualReference: ref });
  const key = `bcp.manual_operation.recorded:${A.companyId}:${ref}`;
  const events = await env.outbox(key);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].event_type, events[0].aggregate_id, events[0].status], ['bcp.manual_operation.recorded', op.id, 'PENDING']);
  assert.equal(events[0].payload_json.manualReference, ref);
  await failure(env.record(A, { manualReference: ref }));
  assert.equal((await env.outbox(key)).length, 1, 'a tentativa duplicada não publica de novo');
  const audit = await env.auditOf(A, 'bcp.manual_operation.recorded');
  assert.ok(audit.some((a) => a.entity_id === op.id), 'auditoria do registro');
});

test('m9d831 gravação simultânea da mesma referência: uma vence', { skip: skip() }, async () => {
  const ref = env.reference('FIN');
  const files = await Promise.all([1, 2, 3, 4, 5, 6].map(() => env.evidence(A)));
  const results = await Promise.all(files.map((evidenceFileId) => failure(env.record(A, { manualReference: ref, evidenceFileId }))));
  const losers = results.filter(Boolean);
  assert.equal(losers.length, 5, 'cinco perdem');
  assert.ok(losers.every((e) => e.status === 409 && e.code === 'GOV_BCP_REFERENCE_DUPLICATE'));
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.manual_operations WHERE manual_reference = $1', [ref])).rows[0].n, 1);
  assert.equal((await env.outbox(`bcp.manual_operation.recorded:${A.companyId}:${ref}`)).length, 1);
});

test('m9d831 registro não executa efeito de negócio', { skip: skip() }, async () => {
  const count = async () => (await env.adminQuery(`SELECT (SELECT count(*) FROM finance.financial_entries WHERE company_id = $1)::int AS entries,
    (SELECT count(*) FROM finance.reconciliations WHERE company_id = $1)::int AS recs`, [A.companyId])).rows[0];
  const before = await count();
  const op = await env.record(A);
  assert.deepEqual(await count(), before, 'nenhum lançamento nem conciliação foi criado');
  assert.deepEqual([op.status, op.importCommandRef], ['RECORDED', null]);
});

test('m9d831 isolamento entre empresas', { skip: skip() }, async () => {
  const op = await env.record(A);
  const listB = await env.inTx(B, (tx) => service.listOperations({ tenant: env.tenantOf(B), actorUserId: B.userId, query: {}, transaction: tx }), B.userId);
  assert.ok(!listB.some((o) => o.id === op.id), 'B não vê a operação de A');
  const patch = await failure(env.inTx(B, (tx) => service.updatePayload({ tenant: env.tenantOf(B), actorUserId: B.userId, id: op.id, body: { payload: env.RECEBIMENTO }, transaction: tx }), B.userId));
  assert.equal(patch.status, 404);
  const rls = await env.inTx(B, async (tx) => (await env.sequelize.query('SELECT count(*)::int AS n FROM governance.manual_operations', { transaction: tx, type: 'SELECT' }))[0].n, B.userId);
  assert.equal(rls, 0, 'a RLS esconde as linhas da empresa A na sessão da B');
});
