'use strict';

// M9-D852 — ação destrutiva com impacto e confirmação pela API real (banco descartável): imóvel (nível 2) e contrato (nível 3), impactToken,
// 409 de impacto alterado, nível por parâmetro e traceId igual ao correlationId da auditoria. Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D852_HTTP_TEST_PORT || '21852';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const env = require('../_helpers/m9d852Env');

let h;
const UNDERSTOOD = (impactToken) => ({ confirmation: { understood: true, impactToken } });
const impactOf = async (path) => { const r = await h.call('gestor', 'GET', path); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; };

before(async () => { h = await env.startHttp(21852); });
after(async () => { if (!h.skip) await env.setSetting(h.tenants.A, 'governanca.ui.confirmacao_por_nivel', undefined).catch(() => {}); await env.stopHttp({}); });

test('m9d852 GET /properties/:id/impact devolve contagens, valor, itens, impactToken e o que a tela exige', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const p = await env.insertProperty(h.tenants.A);
  await env.insertOwnerlessOffer(h.tenants.A, p.id);
  const d = await impactOf(`/properties/${p.id}/impact`);
  assert.equal(d.counts.offers, 1);
  assert.equal(d.totalAmountCents, 0);
  assert.deepEqual(d.blockers, []);
  assert.equal(d.level, 2);
  assert.equal(d.record.code, p.code);
  assert.deepEqual(d.confirm, { understood: true, typedCode: false, justification: false, justificationMin: 0 });
  assert.ok(d.impactToken.includes('.'));
  const other = await h.call('gestorB', 'GET', `/properties/${p.id}/impact`);
  assert.equal(other.status, 404, 'outra empresa não vê o imóvel (RLS)');
});

test('m9d852 nível 2: sem "Entendi o impacto" ou sem impactToken é recusado e o imóvel segue vivo; com os dois, exclui', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const p = await env.insertProperty(h.tenants.A);
  const d = await impactOf(`/properties/${p.id}/impact`);
  const none = await h.call('gestor', 'DELETE', `/properties/${p.id}`);
  assert.deepEqual([none.status, none.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  assert.deepEqual(none.body.error.details.missing.sort(), ['impactToken', 'understood']);
  const noUnderstood = await h.call('gestor', 'DELETE', `/properties/${p.id}`, { confirmation: { impactToken: d.impactToken } });
  assert.deepEqual(noUnderstood.body.error.details.missing, ['understood']);
  const forged = await h.call('gestor', 'DELETE', `/properties/${p.id}`, UNDERSTOOD(`${d.impactToken}x`));
  assert.deepEqual([forged.status, forged.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  assert.equal(await env.exists('real_estate.properties', p.id), true);
  const ok = await h.call('gestor', 'DELETE', `/properties/${p.id}`, UNDERSTOOD(d.impactToken));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await env.exists('real_estate.properties', p.id), false);
  const again = await h.call('gestor', 'DELETE', `/properties/${p.id}`, UNDERSTOOD(d.impactToken));
  assert.equal(again.status, 404, 'repetir depois de excluído não executa de novo');
});

test('m9d852 impacto mudou entre a simulação e o POST devolve 409 GOV_ACTION_IMPACT_CHANGED e nada executa', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const p = await env.insertProperty(h.tenants.A);
  const d = await impactOf(`/properties/${p.id}/impact`);
  await env.insertOwnerlessOffer(h.tenants.A, p.id);
  const res = await h.call('gestor', 'DELETE', `/properties/${p.id}`, UNDERSTOOD(d.impactToken));
  assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [409, 'GOV_ACTION_IMPACT_CHANGED', 'O impacto mudou. Revise e confirme novamente.']);
  assert.equal(await env.exists('real_estate.properties', p.id), true);
  const fresh = await impactOf(`/properties/${p.id}/impact`);
  assert.equal((await h.call('gestor', 'DELETE', `/properties/${p.id}`, UNDERSTOOD(fresh.impactToken))).status, 200);
});

test('m9d852 impactToken de outro registro não vale', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const a = await env.insertProperty(h.tenants.A);
  const b = await env.insertProperty(h.tenants.A);
  const tokenOfB = (await impactOf(`/properties/${b.id}/impact`)).impactToken;
  const res = await h.call('gestor', 'DELETE', `/properties/${a.id}`, UNDERSTOOD(tokenOfB));
  assert.deepEqual([res.status, res.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  assert.equal(await env.exists('real_estate.properties', a.id), true);
});

test('m9d852 o nível vem do parâmetro governanca.ui.confirmacao_por_nivel: imóvel em nível 3 pede código digitado e justificativa', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.setSetting(h.tenants.A, 'governanca.ui.confirmacao_por_nivel', 'property.delete=3');
  try {
    const p = await env.insertProperty(h.tenants.A);
    const d = await impactOf(`/properties/${p.id}/impact`);
    assert.equal(d.level, 3);
    const weak = await h.call('gestor', 'DELETE', `/properties/${p.id}`, { confirmation: { impactToken: d.impactToken, typedCode: 'errado', justification: 'Imóvel duplicado, exclusão pedida pela diretoria.' } });
    assert.deepEqual([weak.status, weak.body.error.message], [422, 'Confirme a ação digitando o código do registro.']);
    assert.deepEqual(weak.body.error.details.missing, ['typedCode']);
    const ok = await h.call('gestor', 'DELETE', `/properties/${p.id}`, { confirmation: { impactToken: d.impactToken, typedCode: p.code, justification: 'Imóvel duplicado, exclusão pedida pela diretoria.' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    await env.setSetting(h.tenants.A, 'governanca.ui.confirmacao_por_nivel', undefined);
  }
});

test('m9d852 ação nível 3 exige código digitado, justificativa e impactToken; a justificativa vai para a auditoria com o correlationId da requisição', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const c = await env.insertContract(h.tenants.A);
  const d = await impactOf(`/legal/contracts/${c.id}/impact`);
  assert.equal(d.level, 3);
  assert.equal(d.record.code, c.number);
  assert.deepEqual(d.confirm, { understood: true, typedCode: true, justification: true, justificationMin: 20 });
  const justification = 'Rescisão amigável acordada por e-mail com o locatário.';
  const base = { confirmation: { impactToken: d.impactToken, typedCode: c.number, justification } };
  for (const [name, confirmation, missing] of [
    ['sem confirmation', undefined, ['impactToken', 'justification', 'typedCode']],
    ['sem código', { ...base.confirmation, typedCode: undefined }, ['typedCode']],
    ['código errado', { ...base.confirmation, typedCode: 'OUTRO' }, ['typedCode']],
    ['justificativa curta', { ...base.confirmation, justification: 'curta' }, ['justification']],
  ]) {
    const res = await h.call('gestor', 'POST', `/legal/contracts/${c.id}/terminate`, confirmation ? { confirmation } : {});
    assert.deepEqual([res.status, res.body.error.code, res.body.error.details.missing.sort()], [422, 'GOV_CONFIRMATION_REQUIRED', missing], name);
  }
  assert.equal(await env.statusOf('legal.contracts', c.id), 'ACTIVE');
  const correlationId = randomUUID();
  const ok = await h.call('gestor', 'POST', `/legal/contracts/${c.id}/terminate`, base, { 'X-Correlation-Id': correlationId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.headers.get('x-correlation-id'), correlationId);
  assert.equal(await env.statusOf('legal.contracts', c.id), 'TERMINATED');
  const [confirmed] = await env.auditRows(h.tenants.A, 'governance.action.confirmed', c.id);
  assert.equal(confirmed.after_json.justification, justification);
  assert.equal(confirmed.after_json.actionKey, 'legal.contract.terminate');
  assert.equal(confirmed.correlation_id, correlationId, 'o traceId é o correlationId gravado na auditoria');
  const [terminated] = await env.auditRows(h.tenants.A, 'legal.contract.terminate', c.id);
  assert.equal(terminated.correlation_id, correlationId);
  const again = await h.call('gestor', 'POST', `/legal/contracts/${c.id}/terminate`, base);
  assert.deepEqual([again.status, again.body.error.code], [409, 'GOV_ACTION_BLOCKED'], 'confirmar duas vezes devolve 409');
});

test('m9d852 impacto com impedimento: parcelas em aberto aparecem com valor e a ação é recusada com GOV_ACTION_BLOCKED', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const c = await env.insertContract(h.tenants.A, { openInstallments: 12 });
  const d = await impactOf(`/legal/contracts/${c.id}/impact`);
  assert.equal(d.counts.openInstallments, 12);
  assert.equal(d.totalAmountCents, 1200000);
  assert.equal(d.items.length, 12);
  assert.ok(d.blockers.some((b) => b.code === 'OPEN_BILLING'));
  const res = await h.call('gestor', 'POST', `/legal/contracts/${c.id}/terminate`, { confirmation: { impactToken: d.impactToken, typedCode: c.number, justification: 'Tentativa com cobrança em aberto no contrato.' } });
  assert.deepEqual([res.status, res.body.error.code], [409, 'GOV_ACTION_BLOCKED']);
  assert.match(res.body.error.message, /^Não é possível continuar: .*cobrança em aberto/);
  assert.equal(await env.statusOf('legal.contracts', c.id), 'ACTIVE');
});

test('m9d852 toda resposta de erro traz traceId igual ao correlationId e ao cabeçalho X-Correlation-Id', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const id = randomUUID();
  for (const [who, method, path] of [['gestor', 'GET', `/properties/${id}/impact`], ['gestor', 'GET', '/properties/nao-e-uuid/impact'], ['gestor', 'DELETE', `/properties/${id}`], ['gestorB', 'GET', '/users/me/mfa/nada']]) {
    const correlationId = randomUUID();
    const res = await h.call(who, method, path, undefined, { 'X-Correlation-Id': correlationId });
    assert.ok(res.status >= 400, `${method} ${path} ${res.status}`);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.traceId, correlationId, `${method} ${path}`);
    assert.equal(res.headers.get('x-correlation-id'), correlationId);
    assert.equal(res.body.traceId, undefined, 'nunca na raiz');
  }
  const noAuth = await fetch(`${h.baseUrl}/properties/${id}/impact`);
  const body = await noAuth.json();
  assert.equal(noAuth.status, 401);
  assert.equal(body.error.traceId, noAuth.headers.get('x-correlation-id'));
});
