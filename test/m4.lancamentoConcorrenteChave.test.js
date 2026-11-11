'use strict';

// Caderno M4 §20 FIN-TS-001 "Double click pagamento — 2 requests iguais — 1 pagamento/ledger" e
// FIN-004. Defeito achado na captura ao vivo do fechamento do Marco 4 (10/11/2026): quando duas
// criações de lançamento com a mesma idempotencyKey passavam juntas pela checagem do serviço, a
// perdedora recebia o 409 genérico UNIQUE_CONSTRAINT_VIOLATION ("Violação de restrição de
// unicidade") em vez do código de negócio. Agora a violação do UNIQUE vira 409
// FINANCE_DUPLICATE_PAYMENT com a mensagem do Financeiro. HTTP real contra o app.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_LANC_CONCORRENTE_TEST_PORT || '21618';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const { mapFinanceUniqueViolation } = require('../src/modules/finance/presentation/http/finance-unique-violations');
const { FinancialEntry } = require('../src/models');

let tenant;
let http;
let token;
let costCenterId;

before(async () => {
  tenant = await isolatedTenant('duplo-clique');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  token = tokenFor(tenant, (await createUser(tenant, 'duplo-clique')).id);
  costCenterId = await T.withTenantTransaction(tenant, async (t) => (await T.createTestCostCenter(tenant, t)).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

test('M4-FIN-TS-001 seis criações SIMULTÂNEAS com a mesma idempotencyKey: exatamente 1 lançamento (201) e as outras 409 FINANCE_DUPLICATE_PAYMENT com a mensagem de negócio, nunca UNIQUE_CONSTRAINT_VIOLATION', async () => {
  const key = `duplo-clique-${T.uniqueSuffix()}`;
  const body = { entryType: 'DEBIT', nature: 'PAYABLE', amount: 199.9, costCenterId, description: 'FIN-TS-001 duplo clique', idempotencyKey: key };
  const results = await Promise.all(Array.from({ length: 6 }, () => http('POST', '/finance/entries', token, body)));
  const created = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status !== 201);
  assert.equal(created.length, 1, JSON.stringify(results.map((r) => [r.status, r.code])));
  for (const r of refused) {
    assert.equal(r.status, 409);
    assert.equal(r.code, 'FINANCE_DUPLICATE_PAYMENT', JSON.stringify(r.body));
    assert.match(r.body.error.message, /mesma chave de idempotência/);
  }
  const rows = await T.withTenantTransaction(tenant, (t) => FinancialEntry.count({ where: { idempotencyKey: key }, transaction: t }));
  assert.equal(rows, 1);
});

test('M4-FIN-TS-001 a violação real do UNIQUE de financial_entries.idempotency_key (inserção que fura a checagem do serviço) é traduzida para FINANCE_DUPLICATE_PAYMENT; outra violação segue genérica', async () => {
  const key = `unique-real-${T.uniqueSuffix()}`;
  const row = (k) => ({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 1, costCenterId, description: 'FIN-TS-001 unique', status: 'PENDING', idempotencyKey: k, competenceMonth: new Date().toISOString().slice(0, 7) });
  await T.withTenantTransaction(tenant, (t) => FinancialEntry.create(row(key), { transaction: t }));
  let caught;
  try {
    await T.withTenantTransaction(tenant, (t) => FinancialEntry.create(row(key), { transaction: t }));
  } catch (err) {
    caught = err;
  }
  assert.equal(caught && caught.name, 'SequelizeUniqueConstraintError');
  const mapped = mapFinanceUniqueViolation(caught);
  assert.deepEqual({ ...mapped, message: undefined }, { statusCode: 409, code: 'FINANCE_DUPLICATE_PAYMENT', message: undefined });
  assert.equal(mapFinanceUniqueViolation({ name: 'SequelizeUniqueConstraintError', fields: { tax_id: 'x' }, parent: { table: 'companies' } }), null);
});
