'use strict';

/**
 * Fechamento do Marco 5 — Locação via HTTP real (app Express + JWT + RLS): o 409 do encerramento grava
 * closeout.blocked e a auditoria (a transação da requisição é desfeita, o registro do bloqueio não), e a
 * rota do Guia §14 POST /legal/contracts/:id/key-delivery usa os mesmos gates sem deixar entrega órfã.
 */
process.env.PORT = process.env.PORT || '5536';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Contract, UtilityObligation, OwnershipTransferTask, OutboxEvent, AuditLog, KeyDelivery, Person, ContractParty, UtilityReimbursement } = require('../src/models');

let tenant;
let token;
let tokenBilling;
const baseUrl = () => `http://127.0.0.1:${process.env.PORT}/api/v1`;

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['legal:read', 'legal:create', 'legal:update', 'lease.keys.deliver', 'billing:read', 'billing:update'],
  });
  tokenBilling = token;
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl()}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

test('fechamento M5 cobrança/HTTP: encerramento recusado (409 CLOSEOUT_BLOCKED) grava closeout.blocked e a auditoria mesmo com a transação da requisição desfeita', async () => {
  const contract = await withTenantTransaction(tenant, async (t) => {
    const c = await Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FH-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    const o = await UtilityObligation.create({ ...base(), contractId: c.id, utilityType: 'ELECTRICITY', responsibleParty: 'TENANT', transferRequired: true, status: 'TRANSFER_PENDING' }, { transaction: t });
    await OwnershipTransferTask.create({ ...base(), utilityObligationId: o.id, status: 'PENDING' }, { transaction: t });
    return c;
  });
  const res = await http('POST', `/billing/contracts/${contract.id}/closeout`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CLOSEOUT_BLOCKED');
  await withTenantTransaction(tenant, async (t) => {
    const events = await OutboxEvent.findAll({ where: { eventType: 'closeout.blocked', aggregateId: contract.id }, transaction: t });
    assert.equal(events.length, 1, 'closeout.blocked gravado uma vez');
    assert.ok(events[0].payloadJson.pendingReasons.some((r) => r.type === 'PENDING_UTILITY_TRANSFER'));
    const audit = await AuditLog.findAll({ where: { action: 'billing.closeout.blocked', entityId: contract.id }, transaction: t });
    assert.equal(audit.length, 1, 'bloqueio auditado uma vez');
    const reloaded = await Contract.findByPk(contract.id, { transaction: t });
    assert.equal(reloaded.status, 'ACTIVE', 'o contrato não muda');
  });
});

test('fechamento M5 Guia §14/HTTP: POST /legal/contracts/:id/key-delivery recusa contrato não assinado sem deixar entrega gravada', async () => {
  const { contract, renter } = await withTenantTransaction(tenant, async (t) => {
    const c = await Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FK-${uniqueSuffix()}`, status: 'DRAFT', createdBy: tenant.userId }, { transaction: t });
    const p = await Person.create({ ...base(), personType: 'PF', legalName: `M5F locatário ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction: t });
    await ContractParty.create({ ...base(), contractId: c.id, personId: p.id, partyRole: 'TENANT' }, { transaction: t });
    return { contract: c, renter: p };
  });
  const res = await http('POST', `/legal/contracts/${contract.id}/key-delivery`, { deliveredToPersonId: renter.id, keysCount: 2, keysIdentification: 'chave e controle', termSignedByPersonId: renter.id });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'LEGAL_KEY_DELIVERY_BLOCKED');
  const count = await withTenantTransaction(tenant, (t) => KeyDelivery.count({ where: { contractId: contract.id }, transaction: t }));
  assert.equal(count, 0);
});

test('fechamento M5 DoD idempotência/HTTP: pagamento de utilidade repetido com a mesma Idempotency-Key devolve a resposta original e não cria segundo reembolso', async () => {
  const obligation = await withTenantTransaction(tenant, async (t) => {
    const c = await Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FI-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
    return UtilityObligation.create({ ...base(), contractId: c.id, utilityType: 'IPTU', responsibleParty: 'LANDLORD' }, { transaction: t });
  });
  const key = `m5f-idem-${uniqueSuffix()}`;
  const send = () => fetch(`${baseUrl()}/billing/utility-obligations/${obligation.id}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBilling}`, 'Idempotency-Key': key },
    body: JSON.stringify({ amount: 321.09, paidByParty: 'COMPANY' }),
  });
  const r1 = await send();
  const b1 = await r1.json();
  const r2 = await send();
  const b2 = await r2.json();
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r2.headers.get('Idempotent-Replay'), 'true');
  assert.equal(b2.data.reimbursement.id, b1.data.reimbursement.id);
  const count = await withTenantTransaction(tenant, (t) => UtilityReimbursement.count({ where: { utilityObligationId: obligation.id }, transaction: t }));
  assert.equal(count, 1);
});

test('fechamento M5 Guia §14/HTTP: rotas literais POST /contracts/:id/guarantees, POST /inspections e POST /inspections/:id/sign usam o mesmo serviço, permissão e MFA', async () => {
  const { contract, propertyId } = await withTenantTransaction(tenant, async (t) => {
    const propertiesService = require('../src/features/properties/properties.service');
    const sfx = uniqueSuffix();
    const p = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5F literal ${sfx}`, internalCode: `M5FL-${sfx}` }, tenant.userId, t);
    const c = await Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FL-${sfx}`, propertyId: p.id, status: 'DRAFT', createdBy: tenant.userId }, { transaction: t });
    return { contract: c, propertyId: p.id };
  });
  const g = await http('POST', `/contracts/${contract.id}/guarantees`, { guaranteeType: 'DEPOSIT', value: 900 });
  assert.equal(g.status, 201);
  assert.equal(g.body.data.contractId, contract.id);
  const bad = await http('POST', `/contracts/${contract.id}/guarantees`, { guaranteeType: 'GUARANTOR' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'LEGAL_GUARANTEE_VALIDATION');
  const ins = await http('POST', '/inspections', { propertyId, contractId: contract.id, inspectionType: 'ENTRY' });
  assert.equal(ins.status, 201);
  assert.equal(ins.body.data.inspectionType, 'ENTRY', 'o código do livro é o gravado e devolvido');
  const sign = await http('POST', `/inspections/${ins.body.data.id}/sign`, { partyRole: 'LANDLORD', signaturePayload: 'x' });
  assert.equal(sign.status, 403);
  assert.match(sign.body.error.code, /^MFA_/);
});

test('fechamento M5 Guia §11/HTTP: entregar chaves exige a permissão do livro lease.keys.deliver (o nome antigo sozinho não basta)', async () => {
  const antigo = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['qa'], permissions: ['legal:read', 'legal:create', 'legal:deliverKeys'] });
  const id = '00000000-0000-4000-8000-000000000000';
  for (const path of [`/legal/key-deliveries/${id}/release`, `/legal/contracts/${id}/key-delivery`, `/contracts/${id}/key-delivery`]) {
    const res = await fetch(`${baseUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${antigo}` }, body: '{}' });
    const body = await res.json();
    assert.equal(res.status, 403, path);
    assert.equal(body.error.code, 'PERMISSION_DENIED');
    assert.equal(body.error.details.required, 'lease.keys.deliver');
  }
  const [[perm]] = await sequelize.query("SELECT count(*)::int AS n FROM core.permissions WHERE code = 'lease.keys.deliver'");
  assert.equal(perm.n, 1, 'permissão do livro no catálogo');
});

test('fechamento M5 §9/HTTP: POST /legal/guarantees/:id/replace substitui a garantia sem perder o histórico', async () => {
  const contract = await withTenantTransaction(tenant, (t) => Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FR-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t }));
  const created = await http('POST', `/legal/contracts/${contract.id}/guarantees`, { guaranteeType: 'SECURITY_DEPOSIT', value: 900 });
  assert.equal(created.status, 201);
  const replaced = await http('POST', `/legal/guarantees/${created.body.data.id}/replace`, { guaranteeType: 'CAPITALIZATION', value: 900, endsAt: '2030-01-01' });
  assert.equal(replaced.status, 201);
  assert.equal(replaced.body.data.oldGuarantee.status, 'RELEASED');
  assert.equal(replaced.body.data.oldGuarantee.replacedByGuaranteeId, replaced.body.data.newGuarantee.id);
  const old = await http('GET', `/legal/guarantees/${created.body.data.id}`);
  assert.deepEqual([old.body.data.guaranteeType, Number(old.body.data.value), old.body.data.status], ['SECURITY_DEPOSIT', 900, 'RELEASED']);
  const again = await http('POST', `/legal/guarantees/${created.body.data.id}/replace`, { guaranteeType: 'CAPITALIZATION', value: 1, endsAt: '2030-01-01' });
  assert.equal(again.status, 409);
});

test('fechamento M5 3ª rodada/HTTP: GET /legal/guarantee-flows mostra a quem cadastra garantia (legal:create) os fluxos homologados de OTHER, sem settings:read', async () => {
  const { upsertSetting } = require('../src/features/settings/settings.service');
  await withTenantTransaction(tenant, (t) => upsertSetting('legal.guarantee_other_flows', JSON.stringify([{ code: 'CARTA_FIANCA', label: 'Carta de fiança bancária', requiredFields: ['banco'] }]), base(), tenant.userId, t));
  const res = await http('GET', '/legal/guarantee-flows');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ code: 'CARTA_FIANCA', label: 'Carta de fiança bancária', requiredFields: ['banco'] }]);
  const leitor = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['qa'], permissions: ['legal:read'] });
  const denied = await fetch(`${baseUrl()}/legal/guarantee-flows`, { headers: { Authorization: `Bearer ${leitor}` } });
  assert.equal(denied.status, 403);
  await withTenantTransaction(tenant, (t) => upsertSetting('legal.guarantee_other_flows', '[]', base(), tenant.userId, t));
});
