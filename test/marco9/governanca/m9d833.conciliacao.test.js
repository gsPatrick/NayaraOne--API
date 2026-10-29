'use strict';

// M9-D833 — conciliação posterior com o extrato: regra de casamento, prazo em dias úteis (feriados do parâmetro) e alerta CRÍTICO uma vez por dia (serviço, banco descartável).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d833Env');
const { reconcilePayments } = require('../../../src/features/core-governance/bcp/payment/payment.job');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const at = (iso) => new Date(`${iso}T15:00:00Z`);
let A;
let ctx;
let account;
let restore;
const run = (when) => env.inTx(A, (tx) => reconcilePayments({ tenant: env.tenantOf(A), now: at(when), transaction: tx }));
// Operação de terça 20/10/2026 (env.body), prazo padrão de 3 dias úteis: sexta 23/10.
async function imported(over = {}) {
  const op = await env.recordPayment(A, ctx, over);
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.equal(item.error, null, JSON.stringify(item.error));
  return op;
}

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  restore = await env.prepare833(A);
  ctx = await env.context(A);
  account = await env.bankAccount(A);
});
after(async () => { if (env.DISPOSABLE) { await env.clean833(); await restore(); await env.sequelize.close(); } });

test('m9d833 a importação abre a pendência com prazo de 3 dias úteis a partir da data da operação', { skip: skip() }, async () => {
  const op = await imported({ valorCentavos: 410000 });
  const pending = await env.pendingOf(op.id);
  assert.deepEqual([pending.status, Number(pending.amount_cents), pending.occurred_on.toISOString().slice(0, 10), pending.deadline_on.toISOString().slice(0, 10), pending.imported_by], ['OPEN', 410000, '2026-10-20', '2026-10-23', A.userId]);
});

test('m9d833 pagamento conciliado com o extrato em 2 dias fica casado e não gera alerta', { skip: skip() }, async () => {
  const op = await imported({ valorCentavos: 420000 });
  const line = await env.bankLine(A, account, -420000, '2026-10-22');
  const result = await run('2026-10-26');
  assert.ok(result.matched >= 1);
  const pending = await env.pendingOf(op.id);
  assert.deepEqual([pending.status, pending.bank_transaction_id], ['MATCHED', line]);
  assert.deepEqual(await env.alertsOf(op.manualReference), []);
});

test('m9d833 sem conciliação em 4 dias úteis gera alerta CRITICAL', { skip: skip() }, async () => {
  const op = await imported({ valorCentavos: 430000 });
  await run('2026-10-23');
  assert.deepEqual(await env.alertsOf(op.manualReference), [], 'no último dia do prazo ainda não alerta');
  await run('2026-10-26');
  const alerts = await env.alertsOf(op.manualReference);
  assert.ok(alerts.length >= 1);
  assert.match(alerts[0].title, /^\[CRÍTICA\] /);
  assert.equal((await env.pendingOf(op.id)).last_alert_key, `bcp.payment_unreconciled:${op.manualReference}:2026-10-26`);
});

test('m9d833 alerta de conciliação vencida chega aos usuários com bcp:approve e a quem importou, uma vez por dia', { skip: skip() }, async () => {
  const op = await imported({ valorCentavos: 440000 });
  await run('2026-10-26');
  const first = await env.alertsOf(op.manualReference);
  const recipients = (await env.adminQuery(
    `SELECT DISTINCT m.user_id FROM core.user_memberships m JOIN core.role_permissions rp ON rp.role_id = m.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE m.company_id = $1 AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND p.code = 'governance:bcp:approve'`, [A.companyId])).rows.map((r) => r.user_id);
  assert.deepEqual([...new Set(first.map((a) => a.user_id))].sort(), [...new Set([...recipients, A.userId])].sort());
  await run('2026-10-26');
  assert.equal((await env.alertsOf(op.manualReference)).length, first.length, 'segunda passada no mesmo dia não repete');
  await run('2026-10-27');
  assert.equal((await env.alertsOf(op.manualReference)).length, first.length * 2, 'no dia seguinte avisa de novo');
});

test('m9d833 casamento exige valor igual e data dentro do prazo, com feriado fora dos dias úteis', { skip: skip() }, async () => {
  const op = await imported({ valorCentavos: 450000 });
  await env.bankLine(A, account, -450001, '2026-10-21');
  await env.bankLine(A, account, 450000, '2026-10-21');
  await env.bankLine(A, account, -450000, '2026-10-19');
  const late = await env.bankLine(A, account, -450000, '2026-10-26');
  await run('2026-10-21');
  assert.equal((await env.pendingOf(op.id)).status, 'OPEN', 'valor diferente em 1 centavo, entrada e data anterior à operação não casam');
  await run('2026-10-24');
  assert.equal((await env.pendingOf(op.id)).status, 'OPEN', 'linha de segunda 26/10 está depois do prazo (sexta 23/10)');
  await env.inTx(A, (tx) => upsertSetting('governanca.calendario.feriados', '2026-10-22', env.tenantOf(A), A.userId, tx));
  const holidayOp = await imported({ valorCentavos: 450000 });
  assert.equal((await env.pendingOf(holidayOp.id)).deadline_on.toISOString().slice(0, 10), '2026-10-26', 'quinta 22/10 é feriado: o prazo vai a segunda');
  await run('2026-10-26');
  const pending = await env.pendingOf(holidayOp.id);
  assert.deepEqual([pending.status, pending.bank_transaction_id], ['MATCHED', late], 'a linha de 26/10 casa agora');
  assert.equal((await env.pendingOf(op.id)).status, 'OPEN', 'a mesma linha não casa com duas operações');
  await env.adminQuery("DELETE FROM core.tenant_settings WHERE key = 'governanca.calendario.feriados'");
});

test('m9d833 o prazo em dias úteis é parâmetro da empresa', { skip: skip() }, async () => {
  await env.inTx(A, (tx) => upsertSetting('governanca.bcp.conciliar_pagamento_dias', 1, env.tenantOf(A), A.userId, tx));
  try {
    const op = await imported({ valorCentavos: 460000 });
    assert.equal((await env.pendingOf(op.id)).deadline_on.toISOString().slice(0, 10), '2026-10-21');
  } finally {
    await env.adminQuery("DELETE FROM core.tenant_settings WHERE key = 'governanca.bcp.conciliar_pagamento_dias'");
  }
});
