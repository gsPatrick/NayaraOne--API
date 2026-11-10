'use strict';

// Caderno M4 §2 FIN-004 ("Pagamento, recebimento, importação e baixa crítica possuem chave
// idempotente"), §10 ("Recebimento parcial atualiza saldo do direito sem recriar o lançamento"),
// Guia §16 ("Recebimento parcial deixa saldo correto"). Defeito achado no fechamento do Marco 4
// (10/11/2026): POST /finance/entries/:id/settle-partial gravava a baixa com idempotencyKey nula,
// então um duplo clique ou uma nova tentativa registrava a baixa duas vezes. HTTP real contra o
// app Express; MFA recente simulado por linhas no banco descartável (nunca pelo endpoint de MFA).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_IDEMP_TEST_PORT || '21611';
require('../app');
const { getSeedTenant, uniqueSuffix, withTenantTransaction, sequelize, createTestResultCenter } = require('./testHelpers');
const { createUser, tokenFor, client } = require('./helpers/m4FinanceHttp');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { FinancialEntry } = require('../src/models');

let tenant;
let http;
let token;
let resultCenterId;

before(async () => {
  tenant = await getSeedTenant();
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  const user = await createUser(tenant, 'baixa');
  token = tokenFor(tenant, user.id);
  resultCenterId = await withTenantTransaction(tenant, async (t) => (await createTestResultCenter(tenant, t)).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function receivable(amount, label) {
  return withTenantTransaction(tenant, (t) =>
    financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, description: `M4 idempotência ${label} ${uniqueSuffix()}`, dueAt: '2026-11-15' },
      tenant.userId,
      t
    )
  );
}

async function children(entryId) {
  return withTenantTransaction(tenant, (t) => FinancialEntry.findAll({ where: { parentEntryId: entryId, status: 'SETTLED' }, transaction: t }));
}

const settle = (id, body, headers) => http('POST', `/finance/entries/${id}/settle-partial`, token, body, headers);

test('FIN-004 settle-partial: sem chave de idempotência é 400 FINANCE_IDEMPOTENCY_KEY_REQUIRED e nada é baixado; chave curta é 400 FINANCE_IDEMPOTENCY_KEY_INVALID', async () => {
  const entry = await receivable('0.30', 'sem chave');
  const semChave = await settle(entry.id, { partialAmount: '0.10' });
  assert.equal(semChave.status, 400, JSON.stringify(semChave.body));
  assert.equal(semChave.code, 'FINANCE_IDEMPOTENCY_KEY_REQUIRED');
  const curta = await settle(entry.id, { partialAmount: '0.10', idempotencyKey: 'abc' });
  assert.equal(curta.status, 400);
  assert.equal(curta.code, 'FINANCE_IDEMPOTENCY_KEY_INVALID');
  assert.equal((await children(entry.id)).length, 0);
});

test('FIN-004 settle-partial: R$ 0,30 em duas baixas (0,10 e 0,20): saldo 0,20 após a primeira, 0,00 e SETTLED após a segunda; a chave fica gravada na filha', async () => {
  const entry = await receivable('0.30', 'duas baixas');
  const k1 = `m4-baixa-1-${uniqueSuffix()}`;
  const k2 = `m4-baixa-2-${uniqueSuffix()}`;
  const b1 = await settle(entry.id, { partialAmount: '0.10', idempotencyKey: k1 });
  assert.equal(b1.status, 200, JSON.stringify(b1.body));
  assert.equal(b1.body.data.remainingAmount, '0.20');
  assert.equal(b1.body.data.original.status, 'PARTIALLY_SETTLED');
  assert.equal(b1.body.data.settlement.amount, '0.10');
  assert.match(b1.body.data.settlement.idempotencyKey, /^baixa-parcial:[0-9a-f]{64}$/);
  const b2 = await settle(entry.id, { partialAmount: '0.20' }, { 'Idempotency-Key': k2 });
  assert.equal(b2.status, 200, JSON.stringify(b2.body));
  assert.equal(b2.body.data.remainingAmount, '0.00');
  assert.equal(b2.body.data.original.status, 'SETTLED');
  const filhas = await children(entry.id);
  assert.deepEqual(filhas.map((f) => f.amount).sort(), ['0.10', '0.20']);
  assert.equal(await withTenantTransaction(tenant, (t) => financialEntriesService.computeRemainingAmount(entry.id, t)), '0.00');
});

test('FIN-004 settle-partial: repetir a MESMA chave com o mesmo valor devolve 200 com a baixa original (idempotentReplay) e não cria filha nova; saldo inalterado', async () => {
  const entry = await receivable('0.30', 'replay');
  const key = `m4-replay-${uniqueSuffix()}`;
  const first = await settle(entry.id, { partialAmount: '0.10', idempotencyKey: key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await settle(entry.id, { partialAmount: '0.10', idempotencyKey: key });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.idempotentReplay, true);
  assert.equal(again.body.data.settlement.id, first.body.data.settlement.id);
  assert.equal(again.body.data.remainingAmount, '0.20');
  assert.equal((await children(entry.id)).length, 1);
});

test('FIN-004 settle-partial: a MESMA chave com outro valor ou em outro lançamento é 409 IDEMPOTENCY_KEY_REUSED e nada é baixado', async () => {
  const entry = await receivable('0.30', 'reuso');
  const other = await receivable('0.30', 'reuso outro');
  const key = `m4-reuso-${uniqueSuffix()}`;
  assert.equal((await settle(entry.id, { partialAmount: '0.10', idempotencyKey: key })).status, 200);
  const otherAmount = await settle(entry.id, { partialAmount: '0.20', idempotencyKey: key });
  assert.equal(otherAmount.status, 409, JSON.stringify(otherAmount.body));
  assert.equal(otherAmount.code, 'IDEMPOTENCY_KEY_REUSED');
  const otherEntry = await settle(other.id, { partialAmount: '0.10', idempotencyKey: key });
  assert.equal(otherEntry.status, 409);
  assert.equal(otherEntry.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await children(entry.id)).length, 1);
  assert.equal((await children(other.id)).length, 0);
});

test('FIN-004 settle-partial: duas requisições SIMULTÂNEAS com a mesma chave geram uma baixa só (uma original e uma idempotentReplay)', async () => {
  const entry = await receivable('0.30', 'concorrência');
  const key = `m4-concorrente-${uniqueSuffix()}`;
  const [a, b] = await Promise.all([
    settle(entry.id, { partialAmount: '0.10', idempotencyKey: key }),
    settle(entry.id, { partialAmount: '0.10', idempotencyKey: key }),
  ]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  assert.equal([a, b].filter((r) => r.body.data.idempotentReplay === true).length, 1);
  assert.equal(a.body.data.settlement.id, b.body.data.settlement.id);
  const filhas = await children(entry.id);
  assert.equal(filhas.length, 1);
  assert.equal(await withTenantTransaction(tenant, (t) => financialEntriesService.computeRemainingAmount(entry.id, t)), '0.20');
});

test('FIN-004 settle (baixa integral): a 2ª chamada sem chave segue recusada por status (409 FINANCE_ENTRY_INVALID_STATUS); com a mesma chave devolve a baixa original (idempotentReplay); a chave em outro lançamento é 409 IDEMPOTENCY_KEY_REUSED', async () => {
  const entry = await receivable('0.30', 'integral');
  const other = await receivable('0.30', 'integral outro');
  const key = `m4-integral-${uniqueSuffix()}`;
  const first = await http('POST', `/finance/entries/${entry.id}/settle`, token, { idempotencyKey: key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.status, 'SETTLED');
  const replay = await http('POST', `/finance/entries/${entry.id}/settle`, token, { idempotencyKey: key });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.idempotentReplay, true);
  const noKey = await http('POST', `/finance/entries/${entry.id}/settle`, token, {});
  assert.equal(noKey.status, 409);
  assert.equal(noKey.code, 'FINANCE_ENTRY_INVALID_STATUS');
  const reused = await http('POST', `/finance/entries/${other.id}/settle`, token, { idempotencyKey: key });
  assert.equal(reused.status, 409);
  assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED');
  const otherNow = await withTenantTransaction(tenant, (t) => FinancialEntry.findByPk(other.id, { transaction: t }));
  assert.equal(otherNow.status, 'PENDING');
});
