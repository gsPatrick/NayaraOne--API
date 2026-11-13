'use strict';

// Caderno M4 §8.4 "Cria payment_intent + snapshot/hash + idempotency_key" e Guia §3
// (PaymentIntent.idempotencyKey). Defeito achado na captura ao vivo do fechamento do Marco 4
// (10/11/2026): a chave da intenção só era gravada no envio ao banco; intenções criadas,
// executadas à mão ou canceladas ficavam sem chave. Agora ela nasce na criação/preparação,
// estável e única por intenção, e o envio ao banco usa a MESMA chave (intenção antiga sem chave
// recebe o mesmo formato de sempre). HTTP real contra o app; MFA recente simulado no banco.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_INTENCAO_CHAVE_TEST_PORT || '21617';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const paymentIntentsService = require('../src/modules/finance/application/services/payment.service');
const { BankAccount, PaymentIntent } = require('../src/models');

let tenant;
let http;
const tk = {};
const users = {};
let costCenterId;

before(async () => {
  tenant = await isolatedTenant('intencao-chave');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  users.maker = await createUser(tenant, 'pi-preparador');
  users.checker = await createUser(tenant, 'pi-aprovador');
  tk.maker = tokenFor(tenant, users.maker.id);
  tk.checker = tokenFor(tenant, users.checker.id);
  costCenterId = await T.withTenantTransaction(tenant, async (t) => (await T.createTestCostCenter(tenant, t)).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

const inTenant = (fn) => T.withTenantTransaction(tenant, fn);
async function payableWithPix() {
  return inTenant(async (t) => {
    const ba = await BankAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `PI-${T.uniqueSuffix()}`, pixKey: `pi-${T.uniqueSuffix()}@exemplo.dev`, status: 'ACTIVE' }, { transaction: t });
    return financialEntriesService.createFinancialEntry({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 321.5, costCenterId, bankAccountId: ba.id, description: `§8.4 ${T.uniqueSuffix()}` }, users.maker.id, t);
  });
}

test('M4-§8.4 a intenção nasce com idempotency_key estável e única (POST /finance/payment-intents e /finance/payments/prepare), gravada no banco', async () => {
  const e1 = await payableWithPix();
  const e2 = await payableWithPix();
  const a = await http('POST', '/finance/payment-intents', tk.maker, { financialEntryId: e1.id });
  const b = await http('POST', '/finance/payments/prepare', tk.maker, { financialEntryId: e2.id });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(a.body.data.idempotencyKey, `payment-intent:${a.body.data.id}`);
  assert.equal(b.body.data.idempotencyKey, `payment-intent:${b.body.data.id}`);
  assert.notEqual(a.body.data.idempotencyKey, b.body.data.idempotencyKey);
  const stored = await inTenant((t) => PaymentIntent.findByPk(a.body.data.id, { transaction: t }));
  assert.equal(stored.idempotencyKey, a.body.data.idempotencyKey);
  const listed = (await http('GET', `/finance/payment-intents?financialEntryId=${e1.id}`, tk.maker)).body.data;
  assert.equal(listed[0].idempotencyKey, a.body.data.idempotencyKey);
});

test('M4-§8.4 o envio ao banco reaproveita a MESMA chave da criação (o adapter recebe essa chave) e a intenção cancelada mantém a sua', async () => {
  const entry = await payableWithPix();
  const created = (await http('POST', '/finance/payments/prepare', tk.maker, { financialEntryId: entry.id })).body.data;
  assert.equal((await http('POST', `/finance/payments/${created.id}/approve`, tk.checker, {})).status, 200);
  const sent = await http('POST', `/finance/payment-intents/${created.id}/submit-to-bank`, tk.checker, { paymentMethod: 'PIX' });
  assert.ok([200, 202].includes(sent.status), JSON.stringify(sent.body));
  const after = await inTenant((t) => PaymentIntent.findByPk(created.id, { transaction: t }));
  assert.equal(after.idempotencyKey, created.idempotencyKey, 'mesma chave da criação');
  assert.ok(['EXECUTING', 'CONFIRMED'].includes(after.status), after.status);
  assert.equal(after.externalSubmissionId, `sandbox-${created.idempotencyKey}`, 'o provedor sandbox recebeu a chave da criação');

  const other = await payableWithPix();
  const toCancel = await inTenant((t) => paymentIntentsService.createPaymentIntent({ financialEntryId: other.id }, users.maker.id, t));
  const cancelled = await inTenant((t) => paymentIntentsService.cancelPaymentIntent(toCancel.id, 'Cancelada em teste do §8.4.', users.maker.id, t));
  assert.equal(cancelled.status, 'CANCELED');
  assert.equal(cancelled.idempotencyKey, `payment-intent:${toCancel.id}`);
});

test('M4-§8.4 intenção antiga sem chave (criada antes da correção) recebe no envio ao banco o mesmo formato de sempre (payment-intent:<id>)', async () => {
  const entry = await payableWithPix();
  const intent = await inTenant((t) => paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, users.maker.id, t));
  await inTenant((t) => PaymentIntent.update({ idempotencyKey: null }, { where: { id: intent.id }, transaction: t }));
  assert.equal((await http('POST', `/finance/payments/${intent.id}/approve`, tk.checker, {})).status, 200);
  const sent = await http('POST', `/finance/payment-intents/${intent.id}/submit-to-bank`, tk.checker, { paymentMethod: 'PIX' });
  assert.ok([200, 202].includes(sent.status), JSON.stringify(sent.body));
  const after = await inTenant((t) => PaymentIntent.findByPk(intent.id, { transaction: t }));
  assert.equal(after.idempotencyKey, `payment-intent:${intent.id}`);
});
