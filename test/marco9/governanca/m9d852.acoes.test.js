'use strict';

// M9-D852 — as demais ações do inventário pela API real: estorno e cancelamento de pagamento (nível 3), cancelamento de obra (só a transição CANCELLED),
// desativar usuário e desligar integração (MFA recente). O MFA é gravado no banco descartável (nunca por endpoint de MFA, nunca token forjado).
process.env.PORT = process.env.M9D852_ACOES_TEST_PORT || '21853';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d852Env');
const { confirmationFor, withConfirmation, grantRecentMfa, revokeRecentMfa } = require('../_helpers/m9d852Confirm');
const { withTenantTransaction } = require('../../testHelpers');
const users = require('../_helpers/m9d804Env');

let h;
let A;
before(async () => { h = await env.startHttp(21853); A = h.tenants && h.tenants.A; });
after(async () => { await env.stopHttp({}); });

test('m9d852 estornar lançamento (nível 3): impacto com valor em centavos, código LAN-, recusa sem código e estorno com a justificativa como motivo', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const entryId = await env.insertEntry(A, { amount: 250.5 });
  const { impact, confirmation } = await confirmationFor(h, 'gestor', `/finance/entries/${entryId}/impact`);
  assert.equal(impact.totalAmountCents, 25050);
  assert.match(impact.record.code, /^LAN-[0-9A-F]{8}$/);
  assert.equal(impact.level, 3);
  const refused = await h.call('gestor', 'POST', `/finance/entries/${entryId}/reverse`, { reason: 'Estorno de teste', confirmation: { ...confirmation, typedCode: 'LAN-00000000' } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details.missing], [422, 'GOV_CONFIRMATION_REQUIRED', ['typedCode']]);
  assert.equal(await env.statusOf('finance.financial_entries', entryId), 'SETTLED');
  const ok = await h.call('gestor', 'POST', `/finance/entries/${entryId}/reverse`, { confirmation });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await env.statusOf('finance.financial_entries', entryId), 'REVERSED');
  const again = await h.call('gestor', 'POST', `/finance/entries/${entryId}/reverse`, await withConfirmation(h, 'gestor', `/finance/entries/${entryId}/impact`));
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_ACTION_BLOCKED']);
  assert.match(again.body.error.message, /já foi estornado/);
});

test('m9d852 cancelar pagamento (nível 3): pagamento já enviado ao banco é impedimento e o pendente cancela com confirmação', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const entryId = await env.insertEntry(A, { status: 'PENDING', amount: 80 });
  const sent = await env.insertIntent(A, entryId, 'SUBMITTED');
  const blocked = await h.call('gestor', 'POST', `/finance/payment-intents/${sent}/cancel`, await withConfirmation(h, 'gestor', `/finance/payment-intents/${sent}/impact`));
  assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'GOV_ACTION_BLOCKED']);
  assert.match(blocked.body.error.message, /já enviado ao banco/);
  const pending = await env.insertIntent(A, await env.insertEntry(A, { status: 'PENDING', amount: 80 }), 'PENDING');
  const ok = await h.call('gestor', 'POST', `/finance/payment-intents/${pending}/cancel`, await withConfirmation(h, 'gestor', `/finance/payment-intents/${pending}/impact`));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await env.statusOf('finance.payment_intents', pending), 'CANCELLED');
});

test('m9d852 cancelar obra (nível 3): só a transição para CANCELLED pede confirmação; as outras seguem a regra de transição', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const p = await env.insertProject(A);
  const other = await h.call('gestor', 'POST', `/construction/projects/${p.id}/transition`, { targetStatus: 'ACTIVE' });
  assert.deepEqual([other.status, other.body.error.code], [409, 'PROJECT_STATUS_TRANSITION_INVALID'], 'outra transição não passa pelo guarda');
  const bare = await h.call('gestor', 'POST', `/construction/projects/${p.id}/transition`, { targetStatus: 'CANCELLED' });
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  assert.equal(await env.statusOf('construction.projects', p.id), 'PLANNED');
  const body = await withConfirmation(h, 'gestor', `/construction/projects/${p.id}/impact`, { targetStatus: 'CANCELLED' });
  assert.equal(body.confirmation.typedCode, p.code);
  const ok = await h.call('gestor', 'POST', `/construction/projects/${p.id}/transition`, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await env.statusOf('construction.projects', p.id), 'CANCELLED');
});

test('m9d852 contrato rescindido pela transição genérica também passa pela confirmação', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const c = await env.insertContract(A);
  const bare = await h.call('gestor', 'POST', `/legal/contracts/${c.id}/transition`, { targetStatus: 'TERMINATED', reason: 'sem confirmação' });
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  assert.equal(await env.statusOf('legal.contracts', c.id), 'ACTIVE');
});

test('m9d852 desativar usuário (nível 2 + MFA): PATCH com status é recusado, a rota nova exige MFA, impacto, confirmação e encerra as sessões', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const target = await withTenantTransaction(A, (tx) => users.newUser(A, tx));
  const viaPatch = await h.call('gestor', 'PATCH', `/users/${target.id}`, { status: 'INACTIVE' });
  assert.deepEqual([viaPatch.status, viaPatch.body.error.code], [422, 'GOV_CONFIRMATION_ROUTE_REQUIRED']);
  await revokeRecentMfa(A.userId);
  const noMfa = await h.call('gestor', 'PATCH', `/users/${target.id}/deactivate`, {});
  assert.equal(noMfa.status, 403);
  assert.ok(['MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED'].includes(noMfa.body.error.code), noMfa.body.error.code);
  await grantRecentMfa(A);
  const d = (await h.call('gestor', 'GET', `/users/${target.id}/impact`)).body.data;
  assert.equal(d.level, 2);
  assert.equal(d.mfaRequired, true);
  assert.equal(d.record.code, target.email);
  assert.equal(d.counts.activeMemberships, 1);
  const bare = await h.call('gestor', 'PATCH', `/users/${target.id}/deactivate`, {});
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const ok = await h.call('gestor', 'PATCH', `/users/${target.id}/deactivate`, { confirmation: { understood: true, impactToken: d.impactToken } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await env.statusOf('core.users', target.id), 'INACTIVE');
  const again = await h.call('gestor', 'PATCH', `/users/${target.id}/deactivate`, await withConfirmation(h, 'gestor', `/users/${target.id}/impact`));
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_ACTION_BLOCKED']);
});

test('m9d852 desligar integração (nível 3 + MFA): só a transição para DISABLED pede confirmação', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const c = await env.insertConnection(A, 'ACTIVE');
  const path = `/admin/integrations/registry/connections/${c.id}/transition`;
  const pause = await h.call('gestor', 'POST', path, { status: 'PAUSED' });
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  await revokeRecentMfa(A.userId);
  const noMfa = await h.call('gestor', 'POST', path, { status: 'DISABLED' });
  assert.equal(noMfa.status, 403);
  assert.equal(await env.statusOf('integration.connections', c.id), 'PAUSED');
  await grantRecentMfa(A);
  const bare = await h.call('gestor', 'POST', path, { status: 'DISABLED' });
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const body = await withConfirmation(h, 'gestor', `/admin/integrations/registry/connections/${c.id}/impact`, { status: 'DISABLED' });
  assert.equal(body.confirmation.typedCode, c.label);
  const ok = await h.call('gestor', 'POST', path, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await env.statusOf('integration.connections', c.id), 'DISABLED');
});
