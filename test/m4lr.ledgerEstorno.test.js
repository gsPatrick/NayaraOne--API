'use strict';

// Caderno M4 §6 ("financial_entries representa obrigação/direito previsto; ledger representa fato financeiro realizado. Um entry
// pode ter múltiplos movimentos de ledger (pagamento parcial, estorno, complemento)"; "Estorno — mantém histórico/status
// derivado — REVERSAL apontando movement original"), Guia §8 (reverseLedger com `idempotencyKey: reversal:<id>:<caso>`) e FIN-004.
// Verificação independente 11/11/2026, sondas P2, P3 e P4 (o caso real do recebível de R$ 0,30). HTTP real para o complemento;
// empresa isolada no banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4LR_ESTORNO_HTTP_TEST_PORT || '28951';
require('../app');
const { uniqueSuffix, withTenantTransaction, sequelize, createTestResultCenter } = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const entriesSvc = require('../src/modules/finance/application/services/financial-entry.service');
const receipt = require('../src/modules/finance/application/services/receipt.service');
const { FinancialEntry } = require('../src/models');

let tenant;
let rc;
let http;
let token;

before(async () => {
  tenant = await isolatedTenant('m4lr-estorno');
  rc = await withTenantTransaction(tenant, async (t) => (await createTestResultCenter(tenant, t)).id);
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  token = tokenFor(tenant, (await createUser(tenant, 'm4lr-estorno')).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await sequelize.close();
  process.exit(0);
});

const tx = (fn) => withTenantTransaction(tenant, fn);
const recv = (amount) => tx((t) => entriesSvc.createFinancialEntry(
  { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId: rc, description: `M4LR ${uniqueSuffix()}`, dueAt: '2026-11-20' },
  tenant.userId, t));
const partial = (id, amount) => tx((t) => receipt.settleFinancialEntryPartial(id, amount, tenant.userId, t, { idempotencyKey: `m4lr-${uniqueSuffix()}` }));
const reverse = (id, options = {}) => tx((t) => receipt.reverseFinancialEntry(id, 'teste M4LR', tenant.userId, t, options));
const reload = (id) => tx((t) => FinancialEntry.findByPk(id, { transaction: t }));

// Linhas do ledger da família do lançamento (o próprio, as baixas e os estornos que apontam para eles), com o saldo em centavos.
async function family(id) {
  const rows = await tx((t) => sequelize.query(
    `SELECT id, movement_type, direction, amount::text AS amount, idempotency_key, reverses_ledger_id FROM finance.ledger
      WHERE id = :id OR financial_entry_id = :id OR reverses_ledger_id = :id
         OR reverses_ledger_id IN (SELECT c.id FROM finance.financial_entries c WHERE c.parent_entry_id = :id)`,
    { replacements: { id }, type: 'SELECT', transaction: t }));
  const net = rows.reduce((s, r) => s + (r.direction === 'CREDIT' ? 1 : -1) * Math.round(Number(r.amount) * 100), 0);
  return { rows, net };
}

test('M4-§6.1 (sonda P2): estornar lançamento PENDING (nunca realizado) não lança REVERSAL no ledger; o previsto sai de a receber', async () => {
  const e = await recv('50.00');
  await assert.rejects(reverse(e.id), (err) => err.code === 'FINANCE_ENTRY_NOT_REALIZED', 'sem pedido de anular o previsto, não há o que estornar');
  assert.equal((await reload(e.id)).status, 'PENDING');
  await reverse(e.id, { voidNotRealized: true }); // o que a tela de estorno e os fluxos de compra/seguro pedem
  const original = await reload(e.id);
  assert.equal(original.status, 'REVERSED');
  const compensatorios = await tx((t) => FinancialEntry.count({ where: { reversalOfEntryId: e.id }, transaction: t }));
  assert.equal(compensatorios, 0, 'nenhum lançamento compensatório para dinheiro que nunca se realizou');
  const { rows } = await family(e.id);
  assert.deepEqual(rows, [], 'o ledger não ganha linha nenhuma');
});

test('M4-§6.3 (sonda P3): estornar o pai parcial (R$ 0,30 com 0,10 baixado) estorna a baixa — o ledger da família fecha em 0, nunca −0,20', async () => {
  const e = await recv('0.30');
  const b1 = await partial(e.id, '0.10');
  await reverse(e.id);
  assert.equal((await reload(e.id)).status, 'REVERSED');
  assert.equal((await reload(b1.settlement.id)).status, 'REVERSED', 'a baixa de 0,10 foi estornada');
  const { rows, net } = await family(e.id);
  assert.equal(net, 0, `soma do ledger da família: ${JSON.stringify(rows)}`);
  const reversals = rows.filter((r) => r.movement_type === 'REVERSAL');
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].amount, '0.10');
  assert.equal(reversals[0].reverses_ledger_id, b1.settlement.id, 'o REVERSAL aponta o movimento original (a baixa), não o pai');
  assert.equal(reversals[0].idempotency_key, `reversal:${b1.settlement.id}:total`, 'Guia §8: o estorno nasce com chave');
});

test('M4-§6.3 (sonda P4): estornar UMA baixa (0,10) do pai quitado (0,10 + 0,20) recalcula o pai e o saldo de 0,10 volta a ser baixável', async () => {
  const e = await recv('0.30');
  const b1 = await partial(e.id, '0.10');
  await partial(e.id, '0.20');
  assert.equal((await reload(e.id)).status, 'SETTLED');
  await reverse(b1.settlement.id);
  const pai = await reload(e.id);
  assert.equal(pai.status, 'PARTIALLY_SETTLED', 'status derivado do ledger');
  assert.equal(pai.settledAt, null);
  const again = await partial(e.id, '0.10');
  assert.equal(again.remainingAmount, '0.00');
  assert.equal((await reload(e.id)).status, 'SETTLED');
  assert.equal((await family(e.id)).net, 30, 'recebido 0,10 + 0,20 − 0,10 (estorno) + 0,10 = 0,30');
});

test('M4-§6 complemento: quita o saldo depois de baixa parcial (movimento COMPLEMENT no ledger), com chave e o saldo conferido', async () => {
  const semMovimento = await recv('0.30');
  const recusado = await http('POST', `/finance/entries/${semMovimento.id}/settle-complement`, token, { idempotencyKey: `m4lr-c0-${uniqueSuffix()}` });
  assert.equal(recusado.status, 409, JSON.stringify(recusado.body));
  assert.equal(recusado.body.error.code, 'FINANCE_COMPLEMENT_WITHOUT_MOVEMENT');

  const e = await recv('0.30');
  await partial(e.id, '0.10');
  const semChave = await http('POST', `/finance/entries/${e.id}/settle-complement`, token, { expectedAmount: '0.20' });
  assert.equal(semChave.status, 400);
  assert.equal(semChave.body.error.code, 'FINANCE_IDEMPOTENCY_KEY_REQUIRED');
  const saldoErrado = await http('POST', `/finance/entries/${e.id}/settle-complement`, token, { idempotencyKey: `m4lr-c1-${uniqueSuffix()}`, expectedAmount: '0.30' });
  assert.equal(saldoErrado.status, 409);
  assert.equal(saldoErrado.body.error.code, 'FINANCE_COMPLEMENT_AMOUNT_CHANGED');

  const key = `m4lr-c2-${uniqueSuffix()}`;
  const ok = await http('POST', `/finance/entries/${e.id}/settle-complement`, token, { idempotencyKey: key, expectedAmount: '0.20' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.settlement.amount, '0.20');
  assert.equal(ok.body.data.remainingAmount, '0.00');
  const replay = await http('POST', `/finance/entries/${e.id}/settle-complement`, token, { idempotencyKey: key, expectedAmount: '0.20' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.idempotentReplay, true, 'a mesma chave devolve o complemento original');
  assert.equal((await reload(e.id)).status, 'SETTLED');
  const { rows, net } = await family(e.id);
  assert.equal(net, 30);
  assert.deepEqual(rows.map((r) => r.movement_type).sort(), ['COMPLEMENT_RECEIVABLE', 'PARTIAL_RECEIVABLE']);
});

test('M4-§6 complemento depois de estorno: baixa 0,30 inteira em parcial, estorna e o complemento devolve o direito ao ledger', async () => {
  const e = await recv('0.30');
  const b = await partial(e.id, '0.30');
  await reverse(b.settlement.id);
  assert.equal((await reload(e.id)).status, 'PENDING', 'nada realizado depois do estorno da única baixa');
  const integral = await http('POST', `/finance/entries/${e.id}/settle`, token, { idempotencyKey: `m4lr-i-${uniqueSuffix()}` });
  assert.equal(integral.status, 409, 'com baixa no histórico, o pai não vira linha do ledger por baixa integral');
  const ok = await http('POST', `/finance/entries/${e.id}/settle-complement`, token, { idempotencyKey: `m4lr-c3-${uniqueSuffix()}`, expectedAmount: '0.30' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await family(e.id)).net, 30);
});

test('M4-FIN-004/Guia §8: estorno parcial e total de um movimento nascem com chave; estorno parcial no pai com baixas é recusado', async () => {
  const e = await recv('100.00');
  await tx((t) => receipt.settleFinancialEntry(e.id, tenant.userId, t, { idempotencyKey: `m4lr-int-${uniqueSuffix()}` }));
  await reverse(e.id, { amount: '30.00' });
  await reverse(e.id, { amount: '70.00' });
  const rows = await tx((t) => sequelize.query('SELECT idempotency_key, amount::text AS amount FROM finance.ledger WHERE reverses_ledger_id = :id ORDER BY created_at',
    { replacements: { id: e.id }, type: 'SELECT', transaction: t }));
  assert.deepEqual(rows, [{ idempotency_key: `reversal:${e.id}:parcial-1`, amount: '30.00' }, { idempotency_key: `reversal:${e.id}:total`, amount: '70.00' }]);
  assert.equal((await reload(e.id)).status, 'REVERSED', 'o estorno que zera o movimento encerra o original');

  const p = await recv('0.30');
  await partial(p.id, '0.10');
  await assert.rejects(reverse(p.id, { amount: '0.05' }), (err) => err.code === 'FINANCE_REVERSAL_PARTIAL_ON_PARENT' || err.errorCode === 'FINANCE_REVERSAL_PARTIAL_ON_PARENT');
});
