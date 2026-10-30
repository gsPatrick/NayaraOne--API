'use strict';

// M9-D425 (critério acrescentado pela M9-D239) — o kill switch global, de canal e de campanha entra pela verificação registrada em `registerKillSwitchCheck` do gate de
// publicação em rede social: publishToSocial responde 403 INTEGRATION_SOCIAL_KILL_SWITCH_ACTIVE e o envio já agendado ESPERA sem gastar tentativa. Banco descartável (COMMITA e limpa).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const m = require('../_helpers/m9d239Env');
const env = require('../_helpers/m9d425Env');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const { removeCommittedContent } = require('../_helpers/mktContentCleanup');

const { sequelize, comTenant, carregarTenants, ctxDe, limparTudo, restaurar, forcar, ler, dispatch, instalarRedes, removerRedes, dispatchesDe, publicar } = m;
const createdItems = [];
const createdConnections = [];
/** Cria o conteúdo (COMMITADO) e guarda o id para a limpeza: o teste de schema conta linhas de conteúdo por empresa. */
const criarConteudo = async (...args) => { const c = await m.criarConteudo(...args); createdItems.push(c.itemId); return c; };
const { ks } = env;
let tenant;
let redes;
const ids = () => redes.map((r) => r.connection.id);
const recusa = (e) => e.statusCode === 403 && e.code === 'INTEGRATION_SOCIAL_KILL_SWITCH_ACTIVE';
const setSwitch = (scope, targetId, active) => comTenant(tenant, async (t) => ks.changeKillSwitch({
  tenant, actorUserId: tenant.userId, transaction: t, input: await ks.parseChange({ scope, targetId, active, reason: 'QA-M9 kill switch da publicação social' }, tenant, t),
}));
async function cleanKill() {
  await env.adminQuery("DELETE FROM governance.flag_versions WHERE company_id = $1 AND key LIKE 'marketing.%.kill'", [tenant.companyId]);
  await env.adminQuery("DELETE FROM governance.feature_flags WHERE company_id = $1 AND key LIKE 'marketing.%.kill'", [tenant.companyId]);
  await env.adminQuery('ALTER TABLE marketing.kill_switch_log DISABLE TRIGGER kill_switch_log_guard');
  await env.adminQuery('DELETE FROM marketing.kill_switch_log WHERE company_id = $1', [tenant.companyId]);
  await env.adminQuery('ALTER TABLE marketing.kill_switch_log ENABLE TRIGGER kill_switch_log_guard');
}

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => { redes = await instalarRedes(tenant); createdConnections.push(...ids()); clearCircuitCache(); await limparTudo(tenant); await cleanKill(); });
after(async () => {
  await cleanKill();
  await limparTudo(tenant);
  await env.adminQuery("UPDATE integration.connections SET status = 'DISABLED' WHERE id = ANY($1::uuid[])", [createdConnections]); // não deixa conexão ativa para outros testes
  await removeCommittedContent(createdItems);
  removerRedes();
  restaurar();
  await sequelize.close();
});

test('kill_switch_global_e_de_canal_seguram_a_publicacao_social_e_o_envio_agendado_espera', async () => {
  const livre = await criarConteudo(tenant, { estado: 'APPROVED' });
  assert.equal((await publicar(tenant, { contentItemId: livre.itemId, connectionIds: ids().slice(0, 1) })).results[0].ok, true, 'sem kill switch a publicação é enfileirada');
  // agendado antes do kill switch
  const agendado = await criarConteudo(tenant, { estado: 'APPROVED' });
  await publicar(tenant, { contentItemId: agendado.itemId, connectionIds: ids().slice(1, 2) });
  await setSwitch('GLOBAL', null, true);
  const novo = await criarConteudo(tenant, { estado: 'APPROVED' });
  await assert.rejects(publicar(tenant, { contentItemId: novo.itemId, connectionIds: ids() }), recusa);
  await assert.rejects(publicar(tenant, { contentItemId: novo.itemId, connectionIds: ids(), mode: 'AUTO' }), recusa);
  assert.equal((await dispatchesDe(tenant, novo.itemId)).length, 0, 'nada nasce com o kill switch ligado');
  // o envio já agendado espera sem gastar tentativa e não chama a rede
  await dispatch.runDispatchCycle(ctxDe(tenant), { now: new Date() });
  const [espera] = await dispatchesDe(tenant, agendado.itemId);
  assert.deepEqual([espera.status, espera.attempts], ['RETRY_WAIT', 0]);
  assert.equal(redes[1].S.chamadas.length, 0);
  // reativado, o mesmo envio sai
  await setSwitch('GLOBAL', null, false);
  await forcar(tenant, espera.id, "next_attempt_at = now() - interval '1 second'");
  await dispatch.runDispatchCycle(ctxDe(tenant), { now: new Date() });
  assert.equal((await ler(tenant, espera.id)).status, 'CONFIRMED');
  // canal: um canal social ligado segura a publicação social (a rede só é conhecida depois); canal que não é social não interfere
  await setSwitch('CHANNEL', 'EMAIL', true);
  assert.equal((await publicar(tenant, { contentItemId: (await criarConteudo(tenant, { estado: 'APPROVED' })).itemId, connectionIds: ids().slice(2, 3) })).results[0].ok, true);
  await setSwitch('CHANNEL', 'EMAIL', false);
  await setSwitch('CHANNEL', 'INSTAGRAM', true);
  await assert.rejects(publicar(tenant, { contentItemId: (await criarConteudo(tenant, { estado: 'APPROVED' })).itemId, connectionIds: ids() }), recusa);
  await setSwitch('CHANNEL', 'INSTAGRAM', false);
  assert.equal((await publicar(tenant, { contentItemId: (await criarConteudo(tenant, { estado: 'APPROVED' })).itemId, connectionIds: ids().slice(0, 1) })).results[0].ok, true);
});

test('kill_switch_de_campanha_segura_so_o_conteudo_dela_e_estado_ilegivel_segura_tudo', async () => {
  const campaignId = crypto.randomUUID();
  await env.adminQuery(`INSERT INTO marketing.campaigns (id, group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, budget_justification, channels, owner_user_id)
    VALUES ($1, $2, $3, $4, 'Campanha QA-M9 social', 'Objetivo da campanha de teste', 'LEADS', 10, 0, 'teste', '{INSTAGRAM}', $5)`, [campaignId, tenant.groupId, tenant.companyId, `KS-${Date.now().toString(36)}`, tenant.userId]);
  try {
    const daCampanha = await criarConteudo(tenant, { estado: 'APPROVED', campaignId });
    const avulso = await criarConteudo(tenant, { estado: 'APPROVED' });
    await setSwitch('CAMPAIGN', campaignId, true);
    await assert.rejects(publicar(tenant, { contentItemId: daCampanha.itemId, connectionIds: ids() }), recusa);
    assert.equal((await publicar(tenant, { contentItemId: avulso.itemId, connectionIds: ids().slice(0, 1) })).results[0].ok, true, 'conteúdo de outra campanha segue');
    await setSwitch('CAMPAIGN', campaignId, false);
    assert.equal((await publicar(tenant, { contentItemId: daCampanha.itemId, connectionIds: ids().slice(1, 2) })).results[0].ok, true);
    // fail-closed: se o estado não puder ser lido, nada é publicado
    const outro = await criarConteudo(tenant, { estado: 'APPROVED' });
    await env.withBrokenState(() => assert.rejects(publicar(tenant, { contentItemId: outro.itemId, connectionIds: ids() }), recusa));
    assert.equal((await publicar(tenant, { contentItemId: outro.itemId, connectionIds: ids().slice(2, 3) })).results[0].ok, true, 'lido de novo, volta ao normal');
  } finally {
    await limparTudo(tenant);
    await removeCommittedContent(createdItems.splice(0));
    await env.adminQuery('UPDATE marketing.content_items SET campaign_id = NULL WHERE campaign_id = $1', [campaignId]);
    await env.adminQuery('DELETE FROM marketing.campaigns WHERE id = $1', [campaignId]);
  }
});
