'use strict';

/**
 * Livro do Marco 3 pela ROTA (HTTP real contra o app):
 *  - Guia §13 "APIs mínimas" no caminho do livro: POST /crm/opportunities, /crm/opportunities/:id/interactions,
 *    /crm/opportunities/:id/visits, /crm/opportunities/:id/lost, POST /crm/radars, GET /crm/radars/:id/matches,
 *    POST /crm/occurrences.
 *  - §12: canal SITE, occurredAt, externalMessageId único (reenvio devolve a mesma interação).
 *  - §15: interação abre ocorrência; classificação com atendimento inadequado e retorno pendente; reclamação grave escala
 *    para a gerência; ocorrência não se apaga (CRM-TS-015, rota e banco). §17: evento crm.occurrence.opened.
 * Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3_LIVRO_API_HTTP_PORT || '21613';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { FeedbackCase, OutboxEvent, AuditLog, Notification } = require('../src/models');

let tenant;
let baseUrl;
let token;
const FUTURE = () => new Date(Date.now() + 2 * 86400000).toISOString();

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: [
      'people:create', 'people:read', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:update',
      'crm:messages:create', 'crm:messages:read', 'crm:visits:create', 'radar:create', 'radar:read',
      'crm:feedback:create', 'crm:feedback:read', 'crm:feedback:update', 'properties:create', 'properties:update',
    ],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function pessoa(label) {
  const p = await http('POST', '/people', { personType: 'PF', legalName: `${label} ${uniqueSuffix()}`, allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return p.body.data.id;
}

async function oportunidade(personId) {
  const o = await http('POST', '/crm/opportunities', { personId, stage: 'NEW', nextAction: 'Ligar para qualificar', nextActionDueAt: FUTURE() });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  return o.body.data;
}

const outbox = (eventType, aggregateId) => withTenantTransaction(tenant, (t) => OutboxEvent.findAll({ where: { eventType, aggregateId }, transaction: t }));

test('LIVRO §13: POST /crm/opportunities cria com próxima ação e recusa sem ela', async () => {
  const personId = await pessoa('Lead livro');
  const sem = await http('POST', '/crm/opportunities', { personId, stage: 'NEW' });
  assert.equal(sem.status, 422);
  assert.equal(sem.body.error.code, 'OPPORTUNITY_NEXT_ACTION_REQUIRED');
  const op = await oportunidade(personId);
  assert.equal(op.personId, personId);
  assert.ok(op.nextAction);
});

test('LIVRO §10/§12: POST /crm/opportunities/:id/interactions grava canal SITE com occurredAt e não duplica pelo externalMessageId', async () => {
  const personId = await pessoa('Lead interação');
  const op = await oportunidade(personId);
  const quando = new Date(Date.now() - 3600000).toISOString();
  const ext = `site-form-${uniqueSuffix()}`;
  const i1 = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'SITE', direction: 'IN', occurredAt: quando, summary: 'Formulário do site: quer visitar no sábado.', externalMessageId: ext });
  assert.equal(i1.status, 201, JSON.stringify(i1.body));
  assert.equal(i1.body.data.channel, 'SITE');
  assert.equal(i1.body.data.direction, 'INBOUND');
  assert.equal(i1.body.data.opportunityId, op.id);
  assert.equal(i1.body.data.personId, personId);
  assert.equal(new Date(i1.body.data.occurredAt).toISOString(), quando);
  const i2 = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'SITE', direction: 'IN', occurredAt: quando, summary: 'Formulário do site: quer visitar no sábado.', externalMessageId: ext });
  assert.equal(i2.body.data.id, i1.body.data.id, 'mesmo externalMessageId devolve a mesma interação');
  const futuro = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'PHONE', direction: 'OUT', occurredAt: FUTURE(), summary: 'Ligação' });
  assert.equal(futuro.status, 400);
  assert.equal(futuro.body.error.code, 'MESSAGE_VALIDATION');
  const semResumo = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'PHONE', direction: 'OUT' });
  assert.equal(semResumo.status, 400);
  const canalLivre = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'TELEPATIA', direction: 'OUT', summary: 'x' });
  assert.equal(canalLivre.status, 400);
  // o mesmo limite do registro de POST /messages (DI-M9R-16, integration.messaging.record_body_max_chars, padrão 65536)
  const longo = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'PHONE', direction: 'OUT', summary: 's'.repeat(65537) });
  assert.deepEqual([longo.status, longo.body.error.code, longo.body.error.details.maxChars], [400, 'MESSAGE_VALIDATION', 65536]);
  assert.equal((await outbox('crm.interaction.recorded', i1.body.data.id)).length, 1);
});

test('LIVRO §13: visita, perda com motivo e radar pelos caminhos do livro', async () => {
  const personId = await pessoa('Lead visita');
  const op = await oportunidade(personId);
  const imovel = await http('POST', '/properties', { title: `Casa livro ${uniqueSuffix()}`, internalCode: `LV-${uniqueSuffix()}`, propertyType: 'RESIDENTIAL', city: 'Campinas', state: 'SP' });
  assert.equal(imovel.status, 201, JSON.stringify(imovel.body));
  const visita = await http('POST', `/crm/opportunities/${op.id}/visits`, { propertyId: imovel.body.data.id, scheduledAt: FUTURE() });
  assert.equal(visita.status, 201, JSON.stringify(visita.body));
  assert.equal(visita.body.data.opportunityId, op.id);
  const semMotivo = await http('POST', `/crm/opportunities/${op.id}/lost`, {});
  assert.equal(semMotivo.status, 422);
  assert.equal(semMotivo.body.error.code, 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');
  const perdida = await http('POST', `/crm/opportunities/${op.id}/lost`, { reasonCode: 'PRICE_TOO_HIGH' });
  assert.equal(perdida.status, 200, JSON.stringify(perdida.body));
  assert.equal(perdida.body.data.stage, 'LOST');
  assert.equal(perdida.body.data.lostReason, 'PRICE_TOO_HIGH');
  const radar = await http('POST', '/crm/radars', { personId, criteriaJson: { city: 'Campinas', offerType: 'SALE' } });
  assert.equal(radar.status, 201, JSON.stringify(radar.body));
  const matches = await http('GET', `/crm/radars/${radar.body.data.id}/matches`);
  assert.equal(matches.status, 200);
});

test('LIVRO §15/§17: a interação abre a ocorrência (atendimento inadequado e retorno pendente) e publica crm.occurrence.opened', async () => {
  const personId = await pessoa('Cliente ocorrência');
  const op = await oportunidade(personId);
  const msg = await http('POST', `/crm/opportunities/${op.id}/interactions`, { channel: 'WHATSAPP', direction: 'IN', summary: 'Ninguém me retornou sobre a proposta.' });
  assert.equal(msg.status, 201);
  const oc = await http('POST', '/crm/occurrences', { personId, messageId: msg.body.data.id, type: 'POOR_SERVICE', severity: 'MEDIUM', description: 'Atendimento inadequado: sem retorno há 5 dias.' });
  assert.equal(oc.status, 201, JSON.stringify(oc.body));
  assert.equal(oc.body.data.messageId, msg.body.data.id);
  assert.equal(oc.body.data.opportunityId, op.id, 'herda a oportunidade da interação');
  assert.equal(oc.body.data.status, 'OPEN');
  assert.ok(oc.body.data.slaDueAt);
  const ev = await outbox('crm.occurrence.opened', oc.body.data.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payloadJson.messageId, msg.body.data.id);
  const retorno = await http('POST', '/crm/feedback-cases', { personId, type: 'PENDING_RETURN', description: 'Cliente aguarda retorno da documentação.' });
  assert.equal(retorno.status, 201, JSON.stringify(retorno.body));
  const outra = await pessoa('Outra pessoa');
  const errada = await http('POST', '/crm/occurrences', { personId: outra, messageId: msg.body.data.id, type: 'COMPLAINT', description: 'x' });
  assert.equal(errada.status, 422);
  assert.equal(errada.body.error.code, 'FEEDBACK_CASE_INTERACTION_MISMATCH');
  const tipoLivre = await http('POST', '/crm/occurrences', { personId, type: 'FOFOCA', description: 'x' });
  assert.equal(tipoLivre.status, 400);
});

test('LIVRO §15: reclamação grave nasce escalonada e avisa a gerência (quem vê o painel do CRM)', async () => {
  const personId = await pessoa('Cliente grave');
  const grave = await http('POST', '/crm/occurrences', { personId, type: 'COMPLAINT', severity: 'HIGH', description: 'Cobrança indevida e ofensa no atendimento.' });
  assert.equal(grave.status, 201, JSON.stringify(grave.body));
  assert.equal(grave.body.data.status, 'ESCALATED');
  assert.ok(grave.body.data.escalatedAt);
  // Gestores pela regra padrão (crm.gerencia.permissao = crm:dashboard:read), lidos no contexto da empresa (RLS), sem engolir erro.
  const [gestores] = await withTenantTransaction(tenant, (t) => sequelize.query(
    `SELECT DISTINCT um.user_id FROM core.user_memberships um JOIN core.role_permissions rp ON rp.role_id = um.role_id
       JOIN core.permissions p ON p.id = rp.permission_id WHERE um.company_id = :c AND um.status = 'ACTIVE' AND p.code = :code`,
    { replacements: { c: tenant.companyId, code: 'crm:dashboard:read' }, transaction: t }
  ));
  assert.ok(gestores.length >= 1, 'a empresa de teste tem ao menos um gestor (o administrador)');
  const ev = await outbox('crm.feedback_case.escalated', grave.body.data.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payloadJson.reason, 'GRAVE_COMPLAINT');
  const avisados = ev[0].payloadJson.notifiedUserIds;
  for (const g of gestores) assert.ok(avisados.includes(g.user_id), 'todo gestor é avisado');
  const notes = await withTenantTransaction(tenant, (t) => Notification.findAll({ where: { userId: avisados, title: 'Reclamação grave escalonada para a gerência' }, transaction: t }));
  assert.ok(notes.length >= avisados.length);
  const leve = await http('POST', '/crm/occurrences', { personId, type: 'COMPLAINT', severity: 'LOW', description: 'Demorou para atender.' });
  assert.equal(leve.body.data.status, 'OPEN', 'só a grave escala na abertura');
});

test('CRM-TS-015: apagar ocorrência é recusado pela rota (auditado) e pelo banco (delete e soft delete)', async () => {
  const personId = await pessoa('Cliente apagar');
  const oc = await http('POST', '/crm/occurrences', { personId, type: 'COMPLAINT', severity: 'MEDIUM', description: 'Reclamação que alguém quer sumir.' });
  assert.equal(oc.status, 201);
  for (const rota of [`/crm/feedback-cases/${oc.body.data.id}`, `/crm/occurrences/${oc.body.data.id}`]) {
    const del = await http('DELETE', rota);
    assert.equal(del.status, 409, JSON.stringify(del.body));
    assert.equal(del.body.error.code, 'FEEDBACK_CASE_DELETE_FORBIDDEN');
  }
  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findAll({ where: { entityId: oc.body.data.id, action: 'feedback_case.delete_refused' }, transaction: t }));
  assert.equal(aud.length, 2, 'cada tentativa auditada');
  await assert.rejects(
    withTenantTransaction(tenant, (t) => sequelize.query('DELETE FROM crm.feedback_cases WHERE id = :id', { replacements: { id: oc.body.data.id }, transaction: t })),
    /FEEDBACK_CASE_DELETE_FORBIDDEN/
  );
  await assert.rejects(
    withTenantTransaction(tenant, async (t) => (await FeedbackCase.findByPk(oc.body.data.id, { transaction: t })).destroy({ transaction: t })),
    /FEEDBACK_CASE_DELETE_FORBIDDEN/
  );
  const ainda = await http('GET', `/crm/feedback-cases/${oc.body.data.id}`);
  assert.equal(ainda.status, 200);
  assert.equal(ainda.body.data.deletedAt ?? null, null);
});
