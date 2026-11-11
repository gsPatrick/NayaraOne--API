'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0346 (DoD "idempotência"): repetir o pagamento de utilidade SEM o cabeçalho
 * Idempotency-Key não cria segundo reembolso — a chave natural é o vencimento (ciclo) pago. Rotas novas dos vencimentos:
 * GET /billing/utility-obligations/:id/cycles (billing:read) e POST /billing/utility-cycles/:id/waive (billing:approve).
 * Fixtures COMMITADAS (as requisições HTTP rodam em transações próprias), no banco descartável do teste.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M5VP_OBRIGACOES_HTTP_TEST_PORT || '32252';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Contract, UtilityObligation, UtilityReimbursement, LeaseObligationCycle } = require('../src/models');
const { paymentProof } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => {
  await sequelize.close();
  process.exit(0);
});

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const url = (p) => `http://127.0.0.1:${process.env.PORT}/api/v1${p}`;
const token = (permissions) => signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['m5vp'], permissions });
async function call(method, path, permissions, body) {
  const res = await fetch(url(path), { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(permissions)}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('M5-A0346/HTTP: o mesmo vencimento pago duas vezes sem Idempotency-Key — 201 e depois 409, um reembolso só', async () => {
  const { obligation, proof } = await withTenantTransaction(tenant, async (t) => {
    const c = await Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5VP-H-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    const o = await UtilityObligation.create({ ...base(), contractId: c.id, utilityType: 'IPTU', responsibleParty: 'LANDLORD' }, { transaction: t });
    return { obligation: o, proof: await paymentProof(tenant, t, '2027-02-20') };
  });
  const body = { amount: 321.09, paidByParty: 'COMPANY', ...proof };
  const r1 = await call('POST', `/billing/utility-obligations/${obligation.id}/payments`, ['billing:update'], body);
  const r2 = await call('POST', `/billing/utility-obligations/${obligation.id}/payments`, ['billing:update'], body);
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error.code, 'UTILITY_CYCLE_ALREADY_SETTLED');
  const count = await withTenantTransaction(tenant, (t) => UtilityReimbursement.count({ where: { utilityObligationId: obligation.id }, transaction: t }));
  assert.equal(count, 1);

  const list = await call('GET', `/billing/utility-obligations/${obligation.id}/cycles`, ['billing:read']);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((c) => [c.dueOn, c.status]), [['2027-02-20', 'PAID']]);
  assert.equal((await call('GET', `/billing/utility-obligations/${obligation.id}/cycles`, ['legal:read'])).status, 403);
});

test('M5-A0270/HTTP: dispensar um vencimento exige billing:approve e motivo; o ciclo fica registrado como WAIVED', async () => {
  const cycle = await withTenantTransaction(tenant, async (t) => {
    const c = await Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5VP-W-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    const o = await UtilityObligation.create({ ...base(), contractId: c.id, utilityType: 'CONDO', responsibleParty: 'TENANT' }, { transaction: t });
    return LeaseObligationCycle.create({ ...base(), obligationId: o.id, contractId: c.id, dueOn: '2027-03-10', status: 'OVERDUE' }, { transaction: t });
  });
  const reason = { reason: 'Síndico confirmou o pagamento por escrito' };
  assert.equal((await call('POST', `/billing/utility-cycles/${cycle.id}/waive`, ['billing:update'], reason)).status, 403);
  const short = await call('POST', `/billing/utility-cycles/${cycle.id}/waive`, ['billing:approve'], { reason: 'ok' });
  assert.equal(short.body.error.code, 'UTILITY_WAIVE_REASON_REQUIRED');
  const ok = await call('POST', `/billing/utility-cycles/${cycle.id}/waive`, ['billing:approve'], reason);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'WAIVED');
});
