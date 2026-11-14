'use strict';

// M4PG — por HTTP real contra o app Express (empresa isolada, banco descartável; MFA recente por linhas no banco, nunca pelo endpoint):
//  - Guia M4 §8 / §15 "POST /finance/ledger/:id/reverse — Estorno controlado"; DEC-003 e DEC-062: o estorno é PEDIDO (finance:reverse + MFA)
//    e só é lançado quando OUTRA pessoa aprova o caso (finance:approve + MFA), com a chave `reversal:<original>:<caso>`.
//  - Caderno §16 "Reabertura requer permissão CRITICAL, MFA, motivo e auditoria"; Guia §18 "Não reabrir fechamento sem fluxo CRITICAL";
//    FIN-TS-011: permissão própria finance:periodReopen, duas pessoas, MFA nas duas pontas.
//  - Caderno §16.3 "CLOSED bloqueia alteração comum de competência/ledger" (a prova certa da linha M4-§16.3).
// Na base 41addaa2: finance:settle estornava sozinho (200) e finance:approve reabria sozinho (200).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4PG_HTTP_TEST_PORT || '21640';
require('../app');
const T = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated, FINANCE_ALL } = require('./helpers/m4FinanceHttp');
const fe = require('../src/modules/finance/application/services/financial-entry.service');
const closing = require('../src/modules/finance/application/services/closing.service');

let tenant;
let http;
const tk = {};
const u = {};
let resultCenterId;

before(async () => {
  tenant = await isolatedTenant('m4pg');
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  for (const label of ['pede', 'aprova', 'fecha', 'confere']) u[label] = await createUser(tenant, label);
  u.semMfa = await createUser(tenant, 'sem-mfa', 'enabled');
  tk.settleOnly = tokenFor(tenant, u.pede.id); // FINANCE_ALL: tem finance:settle e finance:approve, não tem finance:reverse/periodReopen
  tk.pede = tokenFor(tenant, u.pede.id, [...FINANCE_ALL, 'finance:reverse', 'finance:periodReopen']);
  tk.aprova = tokenFor(tenant, u.aprova.id, [...FINANCE_ALL, 'finance:periodReopen']);
  tk.aprovaSemReopen = tokenFor(tenant, u.aprova.id, FINANCE_ALL);
  tk.semMfa = tokenFor(tenant, u.semMfa.id, [...FINANCE_ALL, 'finance:reverse', 'finance:periodReopen']);
  await T.withTenantTransaction(tenant, async (t) => { resultCenterId = (await T.createTestResultCenter(tenant, t)).id; });
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await T.sequelize.close();
  process.exit(0);
});

const inTenant = (fn) => T.withTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function settledReceivable(amount, month) {
  return inTenant(async (t) => {
    const e = await fe.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId, description: `m4pg estorno ${T.uniqueSuffix()}`, ...(month ? { competenceMonth: month, dueAt: `${month}-12T15:00:00.000Z` } : {}) }, u.pede.id, t);
    return require('../src/modules/finance/application/services/receipt.service').settleFinancialEntry(e.id, u.pede.id, t);
  });
}

async function confirmationFor(id, token, justification) {
  const impact = await http('GET', `/finance/entries/${id}/impact`, token);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  return { typedCode: impact.body.data.record.code, justification, impactToken: impact.body.data.impactToken };
}

const statusOf = (id) => inTenant((t) => fe.getFinancialEntry(id, t)).then((e) => e.status);

test('M4-G§8 / DEC-062: finance:settle sozinho não estorna; o pedido (finance:reverse + MFA) abre um caso e NÃO lança nada', async () => {
  const entry = await settledReceivable(88.8);
  const why = 'Recebimento lançado em duplicidade na conta.';
  const denied = await http('POST', `/finance/entries/${entry.id}/reverse`, tk.settleOnly, { reason: why, confirmation: await confirmationFor(entry.id, tk.settleOnly, why) });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(await statusOf(entry.id), 'SETTLED');
  const noMfa = await http('POST', `/finance/entries/${entry.id}/reverse`, tk.semMfa, { reason: why });
  assert.equal(noMfa.status, 403);
  assert.equal(noMfa.code, 'MFA_STEP_UP_REQUIRED');
  const asked = await http('POST', `/finance/entries/${entry.id}/reverse`, tk.pede, { reason: why, confirmation: await confirmationFor(entry.id, tk.pede, why) });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.data.relatedEntityType, 'LedgerReversal');
  assert.equal(asked.body.data.status, 'PENDING');
  assert.equal(await statusOf(entry.id), 'SETTLED', 'o pedido não lança o estorno');
});

test('M4-G§8: quem pediu não aprova; outra pessoa com MFA aprova e o estorno sai com idempotencyKey reversal:<original>:<caso>; repetir devolve o mesmo', async () => {
  const entry = await settledReceivable(45.5);
  const why = 'Valor recebido devolvido ao pagador pelo banco.';
  const asked = await http('POST', `/finance/ledger/${entry.id}/reverse`, tk.pede, { reason: why, confirmation: await confirmationFor(entry.id, tk.pede, why) });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const caseId = asked.body.data.id;
  const self = await http('POST', `/finance/reversal-cases/${caseId}/approve`, tk.pede, {});
  assert.equal(self.status, 403);
  assert.equal(self.code, 'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN');
  const ok = await http('POST', `/finance/reversal-cases/${caseId}/approve`, tk.aprova, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.reversal.idempotencyKey, `reversal:${entry.id}:${caseId}`);
  assert.equal(await statusOf(entry.id), 'REVERSED');
  const again = await http('POST', `/finance/reversal-cases/${caseId}/approve`, tk.aprova, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.data.replayed, true);
  assert.equal(again.body.data.reversal.id, ok.body.data.reversal.id);
});

const closedEntries = {};
async function closedMonth() {
  let month;
  for (;;) {
    month = T.uniqueClosingTestMonth();
    const existing = await inTenant((t) => closing.getClosureByMonth(tenant.companyId, month, t));
    if (!existing) break;
  }
  const inside = await inTenant((t) => fe.createFinancialEntry({ ...base(), entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 20, resultCenterId, competenceMonth: month, dueAt: `${month}-08T15:00:00.000Z`, description: `m4pg dentro do mês ${T.uniqueSuffix()}` }, u.pede.id, t));
  closedEntries[month] = inside.id;
  await inTenant(async (t) => {
    await T.confirmPeriodChecksForTest(tenant, month, u.confere.id, t);
    await closing.closePeriod({ ...base(), referenceMonth: month }, u.fecha.id, t);
    await closing.approvePeriodClosure({ ...base(), referenceMonth: month }, u.aprova.id, t);
  });
  return month;
}

test('M4-§16.3: período CLOSED bloqueia criar e editar lançamento da competência (alteração comum)', async () => {
  const month = await closedMonth();
  const created = await http('POST', '/finance/entries', tk.pede, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId, competenceMonth: month, dueAt: `${month}-10T15:00:00.000Z`, description: 'm4pg mês fechado' });
  assert.equal(created.status, 409, JSON.stringify(created.body));
  assert.equal(created.code, 'FINANCE_PERIOD_CLOSED');
  const edited = await http('PATCH', `/finance/entries/${closedEntries[month]}`, tk.pede, { description: 'edição comum no mês fechado' });
  assert.equal(edited.status, 409, JSON.stringify(edited.body));
  assert.equal(edited.code, 'FINANCE_PERIOD_CLOSED');
});

test('M4-§21.10/G§18.10/FIN-TS-011: reabrir exige finance:periodReopen + MFA, motivo, e a aprovação de OUTRA pessoa (fluxo CRITICAL)', async () => {
  const month = await closedMonth();
  const why = 'Nota fiscal do fornecedor chegou depois do fechamento e muda a competência.';
  const common = await http('POST', '/finance/period-closures/reopen', tk.settleOnly, { referenceMonth: month, reason: why });
  assert.equal(common.status, 403, 'finance:approve não reabre mais');
  assert.equal(common.code, 'PERMISSION_DENIED');
  const short = await http('POST', '/finance/period-closures/reopen', tk.pede, { referenceMonth: month, reason: 'curto' });
  assert.equal(short.status, 400);
  assert.equal(short.code, 'FINANCE_PERIOD_REOPEN_REASON_TOO_SHORT');
  const noMfa = await http('POST', '/finance/period-closures/reopen', tk.semMfa, { referenceMonth: month, reason: why });
  assert.equal(noMfa.code, 'MFA_STEP_UP_REQUIRED');

  const asked = await http('POST', '/finance/period-closures/reopen', tk.pede, { referenceMonth: month, reason: why });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.data.riskLevel, 'CRITICAL');
  const stillClosed = await inTenant((t) => closing.getClosureByMonth(tenant.companyId, month, t));
  assert.equal(stillClosed.status, 'CLOSED', 'uma pessoa sozinha não reabre');

  const id = asked.body.data.id;
  const self = await http('POST', `/finance/period-closures/reopen-requests/${id}/approve`, tk.pede, {});
  assert.equal(self.status, 403);
  assert.equal(self.code, 'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN');
  const approverWithoutPermission = await http('POST', `/finance/period-closures/reopen-requests/${id}/approve`, tk.aprovaSemReopen, {});
  assert.equal(approverWithoutPermission.status, 403);
  const ok = await http('POST', `/finance/period-closures/reopen-requests/${id}/approve`, tk.aprova, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.closure.status, 'OPEN');
  const trail = await inTenant((t) => T.sequelize.query("SELECT reason FROM audit.audit_log WHERE action = 'finance.period_closure.reopen' AND entity_id = :id", { replacements: { id: stillClosed.id }, type: T.sequelize.QueryTypes.SELECT, transaction: t }));
  assert.match(trail[0].reason, new RegExp(`pedido de ${u.pede.id}, aprovado por ${u.aprova.id}`));
  // Reaberto, a alteração comum volta a valer na competência.
  const created = await http('POST', '/finance/entries', tk.pede, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId, competenceMonth: month, dueAt: `${month}-10T15:00:00.000Z`, description: 'm4pg mês reaberto' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});
