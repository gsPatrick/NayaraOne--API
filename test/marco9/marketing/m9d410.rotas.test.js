'use strict';

// M9-D410 — rotas por HTTP real: schedule (201/200/409), GET /marketing/publications (content:read), cancelamento com confirmação de impacto (linha 18 do inventário).
// Só em banco descartável. Nenhum endpoint de MFA é chamado.
process.env.PORT = process.env.M9D410_HTTP_TEST_PORT || '21710';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/mktHttp');
const { confirmationFor } = require('../_helpers/m9d852Confirm');

const PREFIX = 'QA-M9 D410';
const when = (min) => new Date(Date.now() + min * 60000).toISOString();
let sequelize;

before(async () => {
  if (!http.DISPOSABLE) return;
  ({ sequelize } = require('../../../src/models'));
  await http.start([
    { label: 'D410 publicador', tenant: 'A', profile: 'gestor', permissions: ['marketing:content:read', 'marketing:content:write', 'marketing:content:publish'] },
    { label: 'D410 aprovador', tenant: 'A', profile: 'leitura', permissions: ['marketing:content:approve'] },
    { label: 'D410 outra empresa', tenant: 'B', profile: 'gestor', permissions: ['marketing:content:read', 'marketing:content:publish'] },
  ]);
});
after(async () => {
  await http.stop(PREFIX);
  if (sequelize) await sequelize.close().catch(() => {});
  if (http.state.loaded) setTimeout(() => process.exit(0), 300);
});

async function approvedContent(title) {
  const created = await http.call('D410 publicador', 'POST', '/marketing/content', { type: 'INSTITUTIONAL', title: `${PREFIX} ${title}`, texto: 'Somos uma imobiliária de Salvador.' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const approved = await http.call('D410 aprovador', 'POST', `/marketing/content/${id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return id;
}

test('rotas_de_agendamento_listagem_e_cancelamento', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const id = await approvedContent('rotas');
  const body = { channels: ['SITE', 'LINKEDIN'], when: when(120) };
  assert.equal((await http.call('D410 aprovador', 'POST', `/marketing/content/${id}/schedule`, body)).status, 403);
  const first = await http.call('D410 publicador', 'POST', `/marketing/content/${id}/schedule`, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.jobs.length, 2);
  const again = await http.call('D410 publicador', 'POST', `/marketing/content/${id}/schedule`, body);
  assert.equal(again.status, 200);
  const other = await http.call('D410 publicador', 'POST', `/marketing/content/${id}/schedule`, { ...body, when: when(240) });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'MKT_JOB_ALREADY_ACTIVE');

  // listagem: content:read lista; sem ela 403; outra empresa não enxerga
  const list = await http.call('D410 publicador', 'GET', '/marketing/publications?channel=SITE');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.data.some((j) => j.contentItemId === id && j.channel === 'SITE'));
  assert.equal(list.body.pagination.pageSize, 50);
  const denied = await http.call('D410 aprovador', 'GET', '/marketing/publications');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'MKT_FORBIDDEN');
  const foreign = await http.call('D410 outra empresa', 'GET', '/marketing/publications');
  assert.equal(foreign.status, 200);
  assert.ok(!foreign.body.data.some((j) => j.contentItemId === id));
  assert.equal((await http.call('D410 publicador', 'GET', '/marketing/publications?status=XYZ')).status, 400);

  // cancelamento: sem confirmação 422; impacto mostra canal e horário; token de impacto vencido pelo horário alterado 409; com confirmação 200
  const job = list.body.data.find((j) => j.contentItemId === id && j.channel === 'SITE');
  const path = `/marketing/publications/${job.id}`;
  const noConfirm = await http.call('D410 publicador', 'POST', `${path}/cancel`, {});
  assert.equal(noConfirm.status, 422);
  assert.equal(noConfirm.body.error.code, 'GOV_CONFIRMATION_REQUIRED');
  assert.equal((await http.call('D410 aprovador', 'GET', `${path}/impact`)).status, 403);
  const { confirmation, impact } = await confirmationFor(http, 'D410 publicador', `${path}/impact`);
  assert.equal(impact.level, 2);
  assert.equal(impact.blockers.length, 0);
  assert.match(JSON.stringify(impact.items), /SITE/);
  const rest = (await http.call('D410 publicador', 'GET', '/marketing/publications?channel=LINKEDIN')).body.data.find((j) => j.contentItemId === id);
  assert.equal(impact.counts.otherActiveChannels, 1);
  await http.adminQuery("UPDATE marketing.publication_jobs SET status = 'CANCELLED' WHERE id = $1", [rest.id]); // o impacto mudou depois de visto
  const changed = await http.call('D410 publicador', 'POST', `${path}/cancel`, { confirmation });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, 'GOV_ACTION_IMPACT_CHANGED');
  const fresh = await confirmationFor(http, 'D410 publicador', `${path}/impact`);
  const done = await http.call('D410 publicador', 'POST', `${path}/cancel`, { reason: 'Segurar a publicação até o fim da semana.', confirmation: fresh.confirmation });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.status, 'CANCELLED');
  const gone = await http.call('D410 publicador', 'POST', `${path}/cancel`, { confirmation: fresh.confirmation });
  assert.ok([409, 422].includes(gone.status), 'job já cancelado não cancela de novo');
  // job RUNNING aparece como impedimento no impacto
  await http.adminQuery("UPDATE marketing.publication_jobs SET status = 'RUNNING' WHERE id = $1", [rest.id]);
  const blocked = await http.call('D410 publicador', 'GET', `/marketing/publications/${rest.id}/impact`);
  assert.equal(blocked.status, 200);
  assert.ok(blocked.body.data.blockers.length > 0);
  await http.adminQuery("UPDATE marketing.publication_jobs SET status = 'PUBLISHED' WHERE id = $1", [rest.id]);
});

test('schedule_com_aprovacao_invalidada_confirma_a_invalidacao_e_responde_409', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const id = await approvedContent('invalidada');
  await http.adminQuery("UPDATE marketing.content_versions SET approved_hash = repeat('0', 64) WHERE content_item_id = $1", [id]);
  const res = await http.call('D410 publicador', 'POST', `/marketing/content/${id}/schedule`, { channels: ['SITE'], when: when(120) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'MKT_APPROVAL_INVALIDATED');
  const timeline = await http.call('D410 publicador', 'GET', `/marketing/content/${id}`);
  assert.equal(timeline.body.data.status, 'PENDING_APPROVAL', 'a invalidação foi confirmada (commit) antes do erro');
  assert.equal(timeline.body.data.jobs.length, 0);
});

test('item_nao_aprovado_no_agendamento_por_http_da_409_MKT_CONTENT_NOT_APPROVED', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const created = await http.call('D410 publicador', 'POST', '/marketing/content', { type: 'INSTITUTIONAL', title: `${PREFIX} pendente`, texto: 'Somos uma imobiliária de Salvador.' });
  const res = await http.call('D410 publicador', 'POST', `/marketing/content/${created.body.data.id}/schedule`, { channels: ['SITE'], when: when(120) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'MKT_CONTENT_NOT_APPROVED');
  assert.equal(sequelize === undefined, false);
});
