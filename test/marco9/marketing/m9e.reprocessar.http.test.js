'use strict';

// Verificação K=7 do e-mail de campanha: a ação de reprocessar por HTTP real (POST /v1/marketing/campaigns/:id/deliveries/reprocess). Permissão
// marketing:campaign:manage (perfil sem ela = 403), isolamento entre empresas (404), motivo obrigatório (400), campanha fora de andamento (409) e o
// caminho feliz (200, entrega legada FAILED volta a RETRY, step reaberto, consulta mostra o novo estado). Dados COMMITADOS no banco descartável e
// removidos no fim. Nenhum endpoint de MFA é chamado nem token forjado.
process.env.PORT = process.env.M9E_HTTP_PORT || '47592';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery } = require('../../m9d801.helpers');

const GRANTS = { 'CI GESTOR': ['marketing:campaign:manage'] };
const MOTIVO = 'Cofre configurado; reenvio das entregas que falharam sem cofre';
let http; const created = [];
const hex = () => crypto.randomBytes(32).toString('hex');

/** Campanha da empresa no estado pedido, com 1 pessoa, step SENT e a entrega FAILED como o código antigo gravava (caso da cfc5c8e1). */
async function legacyCampaign(tenant, status) {
  const one = async (sql, params) => (await adminQuery(sql, params)).rows[0];
  const person = await one(`INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), $1, $2, 'PF', 'QA-M9E Pessoa', 'ACTIVE') RETURNING id`, [tenant.groupId, tenant.companyId]);
  const tpl = await one(`INSERT INTO marketing.templates (id, group_id, company_id, code, version_no, kind, channel, status, body, content_hash)
    VALUES (gen_random_uuid(), $1, $2, $3, 1, 'MESSAGE', 'EMAIL', 'PUBLISHED', 'Olá', $4) RETURNING id`, [tenant.groupId, tenant.companyId, `qa-m9e-${hex().slice(0, 8)}`, hex()]);
  const camp = await one(`INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, owner_user_id, status, objective_metric, target_value, budget_amount, channels, starts_at, ends_at)
    VALUES ($1, $2, $3, 'QA-M9E', 'objetivo de teste longo o bastante', $4, $5, 'VISITS', 10, 100, ARRAY['EMAIL'], now() - interval '1 hour', now() + interval '2 days') RETURNING id`,
  [tenant.groupId, tenant.companyId, `QA-M9E-${hex().slice(0, 8)}`, tenant.userId, status]);
  const aud = await one(`INSERT INTO marketing.campaign_audiences (group_id, company_id, campaign_id, kind, purpose) VALUES ($1, $2, $3, 'PERSON_LIST', 'MARKETING') RETURNING id`, [tenant.groupId, tenant.companyId, camp.id]);
  await adminQuery('INSERT INTO marketing.campaign_audience_members (group_id, company_id, campaign_id, audience_id, person_id) VALUES ($1, $2, $3, $4, $5)', [tenant.groupId, tenant.companyId, camp.id, aud.id, person.id]);
  const step = await one(`INSERT INTO marketing.campaign_steps (group_id, company_id, campaign_id, step_no, channel, template_id, status) VALUES ($1, $2, $3, 1, 'EMAIL', $4, 'SENT') RETURNING id`, [tenant.groupId, tenant.companyId, camp.id, tpl.id]);
  await adminQuery(`INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status, reason)
    VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE')`, [tenant.groupId, tenant.companyId, camp.id, step.id, person.id, hex()]);
  created.push({ campaign: camp.id, template: tpl.id, person: person.id });
  return { id: camp.id, stepId: step.id };
}

before(async () => {
  http = await startHttp({ port: Number(process.env.PORT), grants: GRANTS, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  if (http.skip) return;
  require('../../../src/features/marketing/publications/messaging').installCampaignSendPort(); // no servidor publicado quem registra é o job de campanhas
});
after(async () => {
  for (const c of created) {
    for (const [sql, id] of [['DELETE FROM marketing.campaign_step_deliveries WHERE campaign_id = $1', c.campaign], ['DELETE FROM marketing.campaign_steps WHERE campaign_id = $1', c.campaign],
      ['DELETE FROM marketing.campaign_audience_members WHERE campaign_id = $1', c.campaign], ['DELETE FROM marketing.campaign_audiences WHERE campaign_id = $1', c.campaign],
      ['DELETE FROM marketing.campaigns WHERE id = $1', c.campaign], ['DELETE FROM marketing.templates WHERE id = $1', c.template], ['DELETE FROM people.persons WHERE id = $1', c.person]]) {
      await adminQuery(sql, [id]).catch(() => {});
    }
  }
  await stopHttp(GRANTS);
});

const reprocess = (who, id, body = { reason: MOTIVO }) => http.call(who, 'POST', `/marketing/campaigns/${id}/deliveries/reprocess`, body);

test('reprocessar_por_http_exige_permissao_isola_empresas_e_devolve_a_entrega_a_fila', { skip: DISPOSABLE ? false : SKIP_DISPOSABLE }, async () => {
  const running = await legacyCampaign(http.tenants.A, 'RUNNING');
  const scheduled = await legacyCampaign(http.tenants.B, 'SCHEDULED');

  const semPermissao = await reprocess('leituraA', running.id);
  assert.deepEqual([semPermissao.status, semPermissao.body.error.code], [403, 'MKT_FORBIDDEN']);
  assert.deepEqual([(await reprocess('gestorB', running.id)).status, (await reprocess('gestorB', running.id)).body.error.code], [404, 'MKT_NOT_FOUND'], 'campanha de outra empresa não existe para quem é de fora');
  assert.equal((await reprocess('gestorA', crypto.randomUUID())).status, 404);
  const curto = await reprocess('gestorA', running.id, { reason: 'curto' });
  assert.deepEqual([curto.status, curto.body.error.code], [400, 'MKT_CAMPAIGN_VALIDATION']);
  const naoIniciada = await reprocess('gestorB', scheduled.id);
  assert.deepEqual([naoIniciada.status, naoIniciada.body.error.code], [409, 'MKT_CAMPAIGN_NOT_RUNNING']);
  const intocada = (await adminQuery('SELECT status FROM marketing.campaign_step_deliveries WHERE campaign_id = $1', [running.id])).rows[0];
  assert.equal(intocada.status, 'FAILED', 'nenhuma recusa alterou a entrega');

  const ok = await reprocess('gestorA', running.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.reprocessed, ok.body.data.asRetry, ok.body.data.stepsReopened], [1, 1, 1]);
  const d = (await adminQuery('SELECT status, attempts, next_attempt_at FROM marketing.campaign_step_deliveries WHERE campaign_id = $1', [running.id])).rows[0];
  assert.deepEqual([d.status, d.attempts], ['RETRY', 0]);
  assert.ok(d.next_attempt_at, 'volta na próxima rodada do job');
  assert.equal((await adminQuery('SELECT status FROM marketing.campaign_steps WHERE id = $1', [running.stepId])).rows[0].status, 'SCHEDULED');
  const consulta = await http.call('gestorA', 'GET', `/marketing/campaigns/${running.id}`);
  assert.equal(consulta.status, 200);
  assert.deepEqual([consulta.body.data.deliveries.byStatus.RETRY, consulta.body.data.deliveries.open, consulta.body.data.deliveries.reprocessable], [1, 1, 0]);
  const aud = (await adminQuery("SELECT user_id, reason, before_json FROM audit.audit_log WHERE action = 'marketing.campaign.deliveries.reprocess' AND entity_id = $1", [running.id])).rows;
  assert.equal(aud.length, 1);
  assert.equal(aud[0].user_id, http.tenants.A.userId); assert.equal(aud[0].reason, MOTIVO);
  assert.equal(aud[0].before_json.deliveries[0].reason, 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE');
});
