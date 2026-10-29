'use strict';

// Marco 9, M9-D214 — enqueue: intenção local na transação do domínio, snapshot canônico, hash, chave estável e classe de risco.
// Roda em banco descartável (os testes COMMITAM): node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 <arquivo>
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, conexaoAtiva, limparPendentes, enfileirar, pagamento, ler, dispatch, uniqueSuffix,
} = require('../_helpers/m9d214Env');

let tenant;
let banco;
let aggregateId;
const agg = () => crypto.randomUUID();

before(async () => {
  ({ tenant } = await carregarTenants());
  await limparPendentes(tenant);
  banco = await conexaoAtiva(tenant, 'BANK');
});
after(async () => { await sequelize.close(); });

const pedir = (extra = {}) => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId, payload: pagamento(), ...extra });

test('dispatch_enqueue_na_transacao_do_dominio', async () => {
  aggregateId = agg();
  // Rollback do domínio: o dispatch some junto.
  const t = await sequelize.transaction();
  let id;
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    const r = await dispatch.enqueue({ companyId: tenant.companyId, connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento(), transaction: t });
    assert.equal(r.status, 'PENDING');
    id = r.dispatchId;
    const [dentro] = await sequelize.query('SELECT status FROM integration.dispatches WHERE id = :id', { replacements: { id }, transaction: t });
    assert.equal(dentro.length, 1, 'a linha existe dentro da transação do domínio');
  } finally {
    await t.rollback();
  }
  const [fora] = await comTenant(tenant, (tx) => sequelize.query('SELECT 1 FROM integration.dispatches WHERE id = :id', { replacements: { id }, transaction: tx }));
  assert.equal(fora.length, 0, 'o rollback do domínio removeu o dispatch');
  // Commit: a linha nasce PENDING com hash, chave e a política de confirmação copiada do port.
  const ok = await pedir();
  const linha = await ler(tenant, ok.dispatchId);
  assert.equal(ok.status, 'PENDING');
  assert.equal(linha.status, 'PENDING');
  assert.equal(linha.confirmation_mode, 'ON_STATUS');
  assert.equal(linha.criticality_op, 'DANGEROUS');
  assert.match(linha.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(linha.attempts, 0);
  await assert.rejects(dispatch.enqueue({ companyId: tenant.companyId, connectionId: banco.id, operation: 'submitPayment', payload: pagamento() }), (e) => e.code === 'INTEGRATION_DISPATCH_TRANSACTION_REQUIRED');
});

test('dispatch_chave_derivada_deterministica', async () => {
  const ag = agg();
  const [a, b, c] = [await pedir({ aggregateId: ag }), await pedir({ aggregateId: ag }), await pedir({ aggregateId: ag })];
  assert.equal(a.dispatchId, b.dispatchId);
  assert.equal(b.dispatchId, c.dispatchId, 'a mesma intenção três vezes devolve o mesmo dispatch');
  assert.deepEqual([a.created, b.created, c.created], [true, false, false]);
  const linha = await ler(tenant, a.dispatchId);
  const esperada = crypto.createHash('sha256')
    .update([tenant.companyId, banco.providerCode, 'submitPayment', 'PaymentIntent', ag, linha.payload_hash].join('|'), 'utf8').digest('hex');
  assert.equal(linha.idempotency_key, esperada, 'sha256(company|provider|operation|aggregate_type|aggregate_id|payload_hash)');
  // "Após reinício": a derivação não depende de estado do processo.
  assert.equal(dispatch.deriveIdempotencyKey({ companyId: tenant.companyId, providerCode: banco.providerCode, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: ag, payloadHash: linha.payload_hash }), esperada);
  const n = await comTenant(tenant, async (t) => (await sequelize.query('SELECT count(*)::int AS n FROM integration.dispatches WHERE aggregate_id = :a', { replacements: { a: ag }, transaction: t }))[0][0].n);
  assert.equal(n, 1);
  // Concorrência: duas chamadas ao mesmo tempo também terminam em um dispatch.
  const ag2 = agg();
  const [x, y] = await Promise.all([pedir({ aggregateId: ag2 }), pedir({ aggregateId: ag2 })]);
  assert.equal(x.dispatchId, y.dispatchId);
  // Valor diferente com chave derivada: outro dispatch, sem conflito.
  const outro = await pedir({ aggregateId: ag, payload: pagamento({ amount: 1205 }) });
  assert.notEqual(outro.dispatchId, a.dispatchId);
  assert.notEqual((await ler(tenant, outro.dispatchId)).idempotency_key, esperada);
});

test('dispatch_chave_igual_conteudo_diferente_conflito', async () => {
  const chave = `qa-m9-d214-${uniqueSuffix()}`;
  const ag = agg();
  const primeiro = await pedir({ aggregateId: ag, idempotencyKey: chave, payload: pagamento({ amount: 1250 }) });
  const repetido = await pedir({ aggregateId: ag, idempotencyKey: chave, payload: pagamento({ amount: 1250 }) });
  assert.equal(repetido.dispatchId, primeiro.dispatchId, 'mesma chave e mesmo conteúdo: o mesmo dispatch');
  await assert.rejects(pedir({ aggregateId: ag, idempotencyKey: chave, payload: pagamento({ amount: 1205 }) }), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_IDEMPOTENCY_CONFLICT' && /Mesma chave/.test(e.message));
  assert.equal((await ler(tenant, primeiro.dispatchId)).payload_snapshot.amount, '1250', 'o conteúdo aprovado não mudou');
});

test('dispatch_snapshot_hash_canonico', async () => {
  const ag = agg();
  const r1 = await pedir({ aggregateId: ag, payload: { currency: 'BRL', amount: 1250.5, beneficiary: { account: '1', document: '2', name: 'N' }, dueDate: new Date('2026-11-05T15:30:00-03:00') } });
  const r2 = await pedir({ aggregateId: ag, payload: { dueDate: new Date('2026-11-05T18:30:00Z'), beneficiary: { name: 'N', document: '2', account: '1' }, amount: 1250.5, currency: 'BRL' } });
  assert.equal(r1.dispatchId, r2.dispatchId, 'a ordem das chaves não muda o hash nem a chave');
  const linha = await ler(tenant, r1.dispatchId);
  assert.equal(linha.payload_snapshot.amount, '1250.5', 'número vira texto decimal');
  assert.equal(linha.payload_snapshot.dueDate, '2026-11-05T18:30:00.000Z', 'data vira ISO-8601 em UTC');
  const canonico = dispatch.canonicalize(linha.payload_snapshot);
  assert.ok(!/\s/.test(canonico.replace(/"[^"]*"/g, '')), 'JSON canônico sem espaços');
  assert.equal(linha.payload_hash, crypto.createHash('sha256').update(canonico, 'utf8').digest('hex'));
  assert.deepEqual(Object.keys(JSON.parse(canonico)), [...Object.keys(JSON.parse(canonico))].sort(), 'chaves em ordem alfabética');
  // Normalização isolada: -0, grandes, bigint e valor inválido.
  assert.deepEqual(dispatch.normalizeSnapshot({ a: -0, b: 1e21, c: 10n, d: [1, undefined], e: undefined }), { a: '0', b: '1000000000000000000000', c: '10', d: ['1', null] });
  assert.throws(() => dispatch.normalizeSnapshot({ a: NaN }), (e) => e.code === 'INTEGRATION_PAYLOAD_INVALID');
  assert.throws(() => dispatch.normalizeSnapshot({ a: new Date('x') }), (e) => e.code === 'INTEGRATION_PAYLOAD_INVALID');
});

test('dispatch_capability_nao_suportada', async () => {
  await assert.rejects(pedir({ operation: 'teleportar' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_CAPABILITY_UNSUPPORTED' && /não suporta/.test(e.message));
  // Operação de outra família (existe no catálogo, mas não neste fornecedor).
  await assert.rejects(pedir({ operation: 'sendText', payload: { to: '+5541999990000', text: 'oi' } }), (e) => e.code === 'INTEGRATION_CAPABILITY_UNSUPPORTED');
  // Conteúdo fora do schema do port (sem mapper: getPaymentStatus exige o recurso externo).
  await assert.rejects(pedir({ operation: 'getPaymentStatus', payload: {} }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_PAYLOAD_INVALID');
  // Sem integração ativa: 404 em português.
  await assert.rejects(pedir({ connectionId: crypto.randomUUID() }), (e) => e.statusCode === 404 && e.code === 'INTEGRATION_CONNECTION_NOT_FOUND');
  // Por domínio: resolve a conexão ativa do domínio (ambiente do servidor).
  const porDominio = await enfileirar(tenant, { domain: 'BANK', operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: 'p-77' } });
  assert.equal((await ler(tenant, porDominio.dispatchId)).connection_id, banco.id);
});

test('dispatch_opclass_nao_pode_ser_rebaixado', async () => {
  const perigosa = await pedir({ aggregateId: agg() });
  assert.equal((await ler(tenant, perigosa.dispatchId)).criticality_op, 'DANGEROUS');
  await assert.rejects(pedir({ aggregateId: agg(), opClass: 'SAFE' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_OPCLASS_DOWNGRADE_FORBIDDEN');
  await assert.rejects(pedir({ aggregateId: agg(), opClass: 'QUALQUER' }), (e) => e.code === 'INTEGRATION_DISPATCH_INVALID');
  const consulta = await enfileirar(tenant, { connectionId: banco.id, operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: 'p-1' } });
  assert.equal((await ler(tenant, consulta.dispatchId)).criticality_op, 'SAFE', 'consulta é SAFE por padrão do port');
  const elevada = await enfileirar(tenant, { connectionId: banco.id, operation: 'getPaymentStatus', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: { externalResourceId: 'p-2' }, opClass: 'DANGEROUS' });
  assert.equal((await ler(tenant, elevada.dispatchId)).criticality_op, 'DANGEROUS', 'o chamador pode elevar');
});
