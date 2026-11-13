'use strict';

// Livro do Marco 3 §18 ("Corretor visualizar carteira alheia — Escopo conforme política de equipe") e §19 CRM-TS-012 ("Cross company —
// Corretor A lê B — Bloqueado"), pela ROTA, com login real (CI empresa A: maker = corretor A, checker = corretor B, gestor vê tudo).
// A carteira não vaza por nenhum caminho do CRM: listas, registro por id, criação com oportunidade alheia, carrinho, tarefa, painel.
// Banco descartável: node scripts/withDisposableDb.js --port <p> -- ... node --test test/m3cb.carteira.http.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/m3cbCarteiraEnv');

let env; let A; let B; let semOp;
const KEY = 'crm.carteira.registro_sem_oportunidade';
const as = (who) => env.tokens[`A:${who}`];
const ids = (res) => (res.body.data || []).map((r) => r.id);

/** O "mundo" de um corretor: oportunidade com visita, mensagem, proposta, carrinho, radar, ocorrência e tarefa, criados pelo gestor. */
async function mundo(ownerUserId, label) {
  const { personId, opportunityId } = await H.oportunidadeDe(env, ownerUserId, label);
  const propertyId = await H.imovel(env);
  const g = as('gestor');
  const visit = await env.call('POST', '/visits', g, { personId, opportunityId, propertyId, scheduledAt: H.FUTURE() });
  const message = await env.call('POST', '/messages', g, { personId, opportunityId, direction: 'INBOUND', authorType: 'CLIENT', channel: 'WHATSAPP', body: `Mensagem de ${label}` });
  const proposal = await env.call('POST', '/crm/proposals', g, { opportunityId, propertyId, value: 500000 });
  const cart = await env.call('POST', `/opportunities/${opportunityId}/carts`, g, { propertyIds: [propertyId] });
  const radar = await env.call('POST', '/radar', g, { personId, opportunityId, criteriaJson: { city: 'Campinas' } });
  const feedback = await env.call('POST', '/crm/feedback-cases', g, { personId, opportunityId, type: 'COMPLAINT', severity: 'LOW', description: `Reclamação de ${label}` });
  const task = await env.call('POST', `/opportunities/${opportunityId}/tasks`, g, { title: `Retornar ${label}`, dueAt: H.FUTURE() });
  for (const [nome, r] of Object.entries({ visit, message, proposal, cart, radar, feedback, task })) assert.ok([200, 201].includes(r.status), `${nome}: ${JSON.stringify(r.body)}`);
  const cartId = cart.body.data.id || cart.body.data.cart.id;
  return {
    personId, opportunityId, propertyId, visitId: visit.body.data.id, messageId: message.body.data.id, proposalId: proposal.body.data.id,
    cartId, radarId: (radar.body.data.radar || radar.body.data).id, feedbackId: feedback.body.data.id, taskId: task.body.data.id,
  };
}

before(async () => {
  if (!H.DISPOSABLE) return;
  env = await H.subir(Number(process.env.M3CB_CARTEIRA_HTTP_PORT) || 34230);
  A = await mundo(env.ids.maker, 'Corretor A');
  B = await mundo(env.ids.checker, 'Corretor B');
  // Mensagem SEM oportunidade, do cliente da carteira do A, registrada pelo gestor: depende da política de equipe.
  const m = await env.call('POST', '/messages', as('gestor'), { personId: A.personId, direction: 'INBOUND', authorType: 'CLIENT', channel: 'PHONE', body: 'Cliente do A ligou sem oportunidade' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  semOp = m.body.data.id;
});
after(async () => {
  if (!H.DISPOSABLE || !env) return;
  await H.admin('DELETE FROM core.tenant_settings WHERE key = $1', [KEY]);
  await H.encerrar();
});

test('CRM-TS-012 listas: o corretor A só vê a própria carteira em visitas, mensagens, propostas, radares e ocorrências; o gestor vê tudo', { skip: H.SKIP }, async () => {
  for (const [rota, chave] of [['/visits', 'visitId'], ['/messages', 'messageId'], ['/crm/proposals', 'proposalId'], ['/radar', 'radarId'], ['/crm/feedback-cases', 'feedbackId']]) {
    const doA = await env.call('GET', rota, as('maker'));
    assert.equal(doA.status, 200, `${rota}: ${JSON.stringify(doA.body)}`);
    assert.ok(ids(doA).includes(A[chave]), `${rota}: A vê o próprio registro`);
    assert.ok(!ids(doA).includes(B[chave]), `${rota}: A NÃO vê o registro da carteira de B`);
    const doGestor = await env.call('GET', rota, as('gestor'));
    assert.ok(ids(doGestor).includes(A[chave]) && ids(doGestor).includes(B[chave]), `${rota}: o gestor vê as duas carteiras`);
  }
  const filtro = await env.call('GET', `/visits?opportunityId=${B.opportunityId}`, as('maker'));
  assert.equal(filtro.status, 404, 'filtrar pela oportunidade de B responde 404, não lista vazia');
  assert.equal(filtro.body.error.code, 'OPPORTUNITY_NOT_FOUND');
});

test('CRM-TS-012 por id: registro da carteira de B responde 404 ao corretor A (leitura e escrita), sem revelar que existe', { skip: H.SKIP }, async () => {
  const casos = [
    ['GET', `/visits/${B.visitId}`, null, 'VISIT_NOT_FOUND'], ['PATCH', `/visits/${B.visitId}`, { status: 'CANCELLED' }, 'VISIT_NOT_FOUND'],
    ['GET', `/messages/${B.messageId}`, null, 'MESSAGE_NOT_FOUND'], ['PATCH', `/messages/${B.messageId}/status`, { status: 'READ' }, 'MESSAGE_NOT_FOUND'],
    ['GET', `/crm/proposals/${B.proposalId}`, null, 'PROPOSAL_NOT_FOUND'], ['PATCH', `/crm/proposals/${B.proposalId}/status`, { status: 'SENT' }, 'PROPOSAL_NOT_FOUND'],
    ['PATCH', `/carts/${B.cartId}/items`, { propertyIds: [A.propertyId] }, 'CART_NOT_FOUND'], ['POST', `/carts/${B.cartId}/share-link`, {}, 'CART_NOT_FOUND'],
    ['GET', `/radar/${B.radarId}`, null, 'RADAR_NOT_FOUND'], ['GET', `/radar/${B.radarId}/matches`, null, 'RADAR_NOT_FOUND'], ['GET', `/crm/radars/${B.radarId}/matches`, null, 'RADAR_NOT_FOUND'],
    ['GET', `/crm/feedback-cases/${B.feedbackId}`, null, 'FEEDBACK_CASE_NOT_FOUND'], ['PATCH', `/tasks/${B.taskId}`, { status: 'DONE' }, 'OPPORTUNITY_TASK_NOT_FOUND'],
  ];
  for (const [metodo, rota, corpo, codigo] of casos) {
    const r = await env.call(metodo, rota, as('maker'), corpo === null ? undefined : corpo);
    assert.equal(r.status, 404, `${metodo} ${rota}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, codigo, `${metodo} ${rota}`);
  }
  // O próprio registro continua acessível ao dono, e o de B ao gestor.
  assert.equal((await env.call('GET', `/visits/${A.visitId}`, as('maker'))).status, 200);
  assert.equal((await env.call('GET', `/crm/proposals/${A.proposalId}`, as('maker'))).status, 200);
  assert.equal((await env.call('PATCH', `/carts/${A.cartId}/items`, as('maker'), { propertyIds: [A.propertyId] })).status, 200);
  assert.equal((await env.call('GET', `/messages/${B.messageId}`, as('gestor'))).status, 200);
  const intacto = await env.call('GET', `/visits/${B.visitId}`, as('checker'));
  assert.equal(intacto.body.data.status, 'SCHEDULED', 'a tentativa do A não alterou a visita de B');
});

test('CRM-TS-012 criação: o corretor A não grava visita, mensagem, proposta, radar nem ocorrência na oportunidade de B', { skip: H.SKIP }, async () => {
  const base = { personId: B.personId, opportunityId: B.opportunityId };
  const casos = [
    ['/visits', { ...base, propertyId: B.propertyId, scheduledAt: H.FUTURE() }], ['/messages', { ...base, direction: 'INBOUND', authorType: 'CLIENT', body: 'x' }],
    ['/crm/proposals', { opportunityId: B.opportunityId, value: 1000 }], ['/radar', { ...base, criteriaJson: { city: 'Campinas' } }],
    ['/crm/radars', { ...base, criteriaJson: { city: 'Campinas' } }], ['/crm/feedback-cases', { ...base, type: 'COMPLAINT', severity: 'LOW', description: 'x' }],
    ['/crm/occurrences', { ...base, type: 'COMPLAINT', severity: 'LOW', description: 'x' }],
  ];
  for (const [rota, corpo] of casos) {
    const r = await env.call('POST', rota, as('maker'), corpo);
    assert.equal(r.status, 404, `POST ${rota}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'OPPORTUNITY_NOT_FOUND', rota);
  }
  const visitasDeB = await env.call('GET', `/visits?opportunityId=${B.opportunityId}`, as('checker'));
  assert.equal(visitasDeB.body.data.length, 1, 'nenhuma visita a mais na carteira de B');
});

test('CRM-TS-012 painel: o corretor A vê só os números da própria carteira, mesmo pedindo o responsável B', { skip: H.SKIP }, async () => {
  const doA = await env.call('GET', `/crm/dashboard?ownerUserId=${env.ids.checker}`, as('maker'));
  assert.equal(doA.status, 200, JSON.stringify(doA.body));
  const doB = await env.call('GET', '/crm/dashboard', as('checker'));
  const total = (d) => Number(d.body.data.opportunities.total);
  const [{ n: deA }] = (await H.admin('SELECT count(*)::int AS n FROM crm.opportunities WHERE owner_user_id = $1 AND deleted_at IS NULL', [env.ids.maker])).rows;
  const [{ n: deB }] = (await H.admin('SELECT count(*)::int AS n FROM crm.opportunities WHERE owner_user_id = $1 AND deleted_at IS NULL', [env.ids.checker])).rows;
  assert.equal(total(doA), deA, 'o filtro pedido (B) foi trocado pela carteira do próprio A');
  assert.equal(total(doB), deB);
  const propostasA = Number(doA.body.data.proposals.total);
  const [{ n: propDeA }] = (await H.admin('SELECT count(*)::int AS n FROM crm.proposals p JOIN crm.opportunities o ON o.id = p.opportunity_id WHERE o.owner_user_id = $1 AND p.deleted_at IS NULL', [env.ids.maker])).rows;
  assert.equal(propostasA, propDeA, 'as propostas do painel também são só da carteira do A');
});

test('CRM-TS-012 política de equipe: registro sem oportunidade do cliente do A segue o parâmetro crm.carteira.registro_sem_oportunidade', { skip: H.SKIP }, async () => {
  assert.equal((await env.call('GET', `/messages/${semOp}`, as('maker'))).status, 200, 'padrão CLIENTE_DA_CARTEIRA: a pessoa tem oportunidade na carteira do A');
  assert.equal((await env.call('GET', `/messages/${semOp}`, as('checker'))).status, 404, 'o B não vê o cliente do A');
  const put = await env.call('PUT', `/settings/${KEY}`, as('gestor'), { value: 'SOMENTE_PROPRIOS' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const restrito = await env.call('GET', `/messages/${semOp}`, as('maker'));
  assert.equal(restrito.status, 404, 'SOMENTE_PROPRIOS: o A não criou a mensagem, ela não está ligada à oportunidade dele');
  assert.ok(!ids(await env.call('GET', '/messages', as('maker'))).includes(semOp));
  assert.ok(ids(await env.call('GET', '/messages', as('maker'))).includes(A.messageId), 'a mensagem ligada à oportunidade do A continua visível');
  const invalido = await env.call('PUT', `/settings/${KEY}`, as('gestor'), { value: 'TODOS' });
  assert.ok([400, 403, 422].includes(invalido.status), 'valor fora do catálogo é recusado');
});
