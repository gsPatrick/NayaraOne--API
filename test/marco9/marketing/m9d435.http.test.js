'use strict';

// M9-D435 — as 10 rotas /marketing/* por HTTP real: 401, 403 MKT_FORBIDDEN com a permissão exigida, códigos 201/200 da tabela, corpo com campo desconhecido recusado,
// resposta sem segredo nem endereço, isolamento entre empresas, paginação e filtros. Só em banco descartável. Nenhum endpoint de MFA é chamado.
process.env.PORT = process.env.M9D435_HTTP_TEST_PORT || '21735';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('../_helpers/mktHttp');
const { withConfirmation } = require('../_helpers/m9d852Confirm');

const PREFIX = 'QA-M9 D435';
const when = (min) => new Date(Date.now() + min * 60000).toISOString();
const ALL = ['marketing:content:read', 'marketing:content:write', 'marketing:content:publish', 'marketing:campaign:manage', 'marketing:automation:manage', 'marketing:attribution:read', 'marketing:killswitch:manage', 'marketing:template:manage'];
let sequelize;
let ids = {};
const seen = [];

before(async () => {
  if (!http.DISPOSABLE) return;
  ({ sequelize } = require('../../../src/models'));
  await http.start([
    { label: 'D435 editor', tenant: 'A', profile: 'gestor', permissions: ALL },
    { label: 'D435 aprovador', tenant: 'A', profile: 'leitura', permissions: ['marketing:content:approve', 'marketing:automation:publish'] },
    { label: 'D435 outra empresa', tenant: 'B', profile: 'gestor', permissions: [...ALL, 'marketing:content:approve', 'marketing:automation:publish'] },
  ]);
});
after(async () => {
  if (http.DISPOSABLE) {
    const flows = `SELECT id FROM marketing.automation_flows WHERE name LIKE '${PREFIX}%'`;
    await http.adminQuery(`UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id IN (${flows})`).catch(() => {});
    await http.adminQuery(`DELETE FROM marketing.automation_versions WHERE flow_id IN (${flows})`).catch(() => {});
    await http.adminQuery(`DELETE FROM marketing.automation_flows WHERE name LIKE '${PREFIX}%'`).catch(() => {});
    await http.adminQuery("DELETE FROM marketing.campaigns WHERE code LIKE 'QA-M9-D435-%'").catch(() => {});
    await http.adminQuery("DELETE FROM marketing.templates WHERE code LIKE 'qa-m9-d435%'").catch(() => {});
    await http.adminQuery("DELETE FROM governance.flag_versions WHERE key LIKE 'marketing.%.kill'").catch(() => {});
    await http.adminQuery("DELETE FROM governance.kill_switch_drills WHERE flag_key LIKE 'marketing.%'").catch(() => {});
    await http.adminQuery("DELETE FROM governance.feature_flags WHERE key LIKE 'marketing.%.kill'").catch(() => {});
    await http.adminQuery('ALTER TABLE marketing.kill_switch_log DISABLE TRIGGER kill_switch_log_guard').catch(() => {});
    await http.adminQuery('DELETE FROM marketing.kill_switch_log').catch(() => {});
    await http.adminQuery('ALTER TABLE marketing.kill_switch_log ENABLE TRIGGER kill_switch_log_guard').catch(() => {});
  }
  await http.stop(PREFIX);
  if (sequelize) await sequelize.close().catch(() => {});
  if (http.state.loaded) setTimeout(() => process.exit(0), 300);
});

/** Chamada que guarda a resposta para a conferência de segredo e endereço. */
async function call(who, method, route, body) {
  const res = await http.call(who, method, route, body);
  seen.push({ route: `${method} ${route.split('?')[0]}`, status: res.status, text: JSON.stringify(res.body) });
  return res;
}
const forbidden = (res, required) => { assert.equal(res.status, 403, JSON.stringify(res.body)); assert.equal(res.body.error.code, 'MKT_FORBIDDEN'); assert.equal(res.body.error.details.required, required); };
const automationBody = (owner, over = {}) => ({
  name: `${PREFIX} ${crypto.randomUUID().slice(0, 6)}`, ownerUserId: owner, riskLevel: 'MEDIUM', triggerType: 'EVENT', triggerConfig: { eventType: 'crm.opportunity.created' }, conditions: ['LEAD_SEM_RETORNO'],
  actions: [{ actionType: 'CREATE_TASK', title: 'Ligar para o lead' }, { actionType: 'SEND_MESSAGE', channel: 'WHATSAPP' }], cooldown: { amount: 72, unit: 'HOURS' }, frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' },
  validFrom: '2026-01-01T00:00:00Z', ...over,
});

test('as_10_rotas_existem_e_exigem_permissao: sem token 401 e sem a permissão 403 MKT_FORBIDDEN com a permissão exigida', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const id = crypto.randomUUID();
  const rows = [
    ['POST', '/marketing/content', 'D435 aprovador', 'marketing:content:write', {}],
    ['POST', `/marketing/content/${id}/approve`, 'D435 editor', 'marketing:content:approve', {}],
    ['POST', `/marketing/content/${id}/schedule`, 'D435 aprovador', 'marketing:content:publish', {}],
    ['POST', '/marketing/campaigns', 'D435 aprovador', 'marketing:campaign:manage', {}],
    ['POST', '/marketing/automations', 'D435 aprovador', 'marketing:automation:manage', {}],
    ['POST', `/marketing/automations/${id}/publish`, 'D435 editor', 'marketing:automation:publish', {}],
    ['POST', `/marketing/automations/${id}/pause`, 'D435 aprovador', 'marketing:automation:manage', {}],
    ['GET', '/marketing/publications', 'D435 aprovador', 'marketing:content:read'],
    ['GET', '/marketing/attribution', 'D435 aprovador', 'marketing:attribution:read'],
    ['POST', '/marketing/kill-switch', 'D435 aprovador', 'marketing:killswitch:manage', { scope: 'GLOBAL', active: true }],
  ];
  for (const [method, route, who, permission, body] of rows) {
    assert.equal((await call(null, method, route, body)).status, 401, `${method} ${route} sem token`);
    forbidden(await call(who, method, route, body), permission);
  }
});

test('codigos_201_e_200_da_tabela_e_x_correlation_id', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const owner = (await http.adminQuery("SELECT u.id FROM core.users u WHERE u.email = $1", [require('../../../scripts/seed-ci-two-tenants').emailFor('A', 'gestor')])).rows[0].id;
  // 1 e 2 e 3: conteúdo
  const created = await call('D435 editor', 'POST', '/marketing/content', { type: 'INSTITUTIONAL', title: `${PREFIX} conteúdo`, texto: 'Somos uma imobiliária de Salvador.' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'PENDING_APPROVAL');
  ids.content = created.body.data.id;
  assert.equal((await call('D435 editor', 'POST', '/marketing/content', { contentItemId: ids.content })).status, 200, 'retomar devolve 200');
  assert.equal((await call('D435 aprovador', 'POST', `/marketing/content/${ids.content}/approve`, {})).status, 200);
  const at = when(180);
  const sched = await call('D435 editor', 'POST', `/marketing/content/${ids.content}/schedule`, { channels: ['SITE'], when: at });
  assert.equal(sched.status, 201, JSON.stringify(sched.body));
  assert.equal((await call('D435 editor', 'POST', `/marketing/content/${ids.content}/schedule`, { channels: ['SITE'], when: at })).status, 200, 'repetir o agendamento devolve 200');

  // 4: campanha
  const code = `QA-M9-D435-${crypto.randomUUID().slice(0, 8)}`;
  const camp = await call('D435 editor', 'POST', '/marketing/campaigns', { code, name: 'Campanha D435', objective: 'Gerar visitas' });
  assert.equal(camp.status, 201, JSON.stringify(camp.body));
  ids.campaign = camp.body.data.id;
  assert.equal((await call('D435 editor', 'POST', '/marketing/campaigns', { campaignId: ids.campaign, name: 'Campanha D435 completa' })).status, 200, 'completar o DRAFT devolve 200');
  // 5, 6 e 7: automação
  const auto = await call('D435 editor', 'POST', '/marketing/automations', automationBody(owner));
  assert.equal(auto.status, 201, JSON.stringify(auto.body));
  ids.flow = auto.body.data.flow.id;
  assert.equal((await call('D435 aprovador', 'POST', `/marketing/automations/${ids.flow}/publish`, { versionNo: 1, reason: 'Publicação de teste.' })).status, 200);
  const paused = await call('D435 editor', 'POST', `/marketing/automations/${ids.flow}/pause`, { reason: 'Pausa de teste.' });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  // 8 e 9
  const list = await call('D435 editor', 'GET', '/marketing/publications');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((j) => j.contentItemId === ids.content));
  assert.equal((await call('D435 editor', 'GET', '/marketing/attribution')).status, 200);
  ids.job = list.body.data.find((j) => j.contentItemId === ids.content).id;
  const tpl = await call('D435 editor', 'POST', '/marketing/templates', { code: `qa-m9-d435-${crypto.randomUUID().slice(0, 6)}`, kind: 'MESSAGE', channel: 'EMAIL', body: 'Olá {{nome}}', variables: [{ name: 'nome', type: 'text' }] });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
  ids.template = tpl.body.data.id;
  // 10: kill switch da campanha (200) e restauração limpa no after
  const impact = '/marketing/kill-switch/impact';
  const reason = 'Teste da D435: parando a campanha de teste.';
  const ks = await call('D435 editor', 'POST', '/marketing/kill-switch', await withConfirmation(http, 'D435 editor', impact, { scope: 'CAMPAIGN', targetId: ids.campaign, active: true, reason }, { method: 'POST', body: { scope: 'CAMPAIGN', targetId: ids.campaign, action: 'activate' } }));
  assert.equal(ks.status, 200, JSON.stringify(ks.body));
  // correlation_id: o cabeçalho do cliente volta na resposta
  const cid = crypto.randomUUID();
  const echo = await fetch(`${http.state.baseUrl}/marketing/publications`, { headers: { Authorization: `Bearer ${http.state.tokens['D435 editor']}`, 'X-Correlation-Id': cid } });
  assert.equal(echo.headers.get('x-correlation-id'), cid);
});

test('campo_desconhecido_recusado: 400 MKT_VALIDATION em todas as rotas com corpo', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const unknown = { campoQueNaoExiste: 1 };
  const cases = [
    ['D435 editor', '/marketing/content', { type: 'INSTITUTIONAL', title: `${PREFIX} x`, texto: 'x', ...unknown }],
    ['D435 aprovador', `/marketing/content/${ids.content}/approve`, { ...unknown }],
    ['D435 editor', `/marketing/content/${ids.content}/schedule`, { channels: ['SITE'], when: when(300), ...unknown }],
    ['D435 editor', '/marketing/campaigns', { code: 'QA-M9-D435-zz', name: 'x', objective: 'y', ...unknown }],
    ['D435 editor', '/marketing/automations', { flowId: ids.flow, ...unknown }],
    ['D435 aprovador', `/marketing/automations/${ids.flow}/publish`, { versionNo: 1, reason: 'Teste.', ...unknown }],
    ['D435 editor', `/marketing/automations/${ids.flow}/pause`, { reason: 'Teste.', ...unknown }],
    ['D435 editor', '/marketing/kill-switch', { scope: 'GLOBAL', active: true, reason: 'Motivo de teste longo.', ...unknown }, true],
    ['D435 editor', '/marketing/tracking-links', { channel: 'EMAIL', targetUrl: 'https://exemplo.com.br/imovel', ...unknown }],
    ['D435 editor', '/marketing/templates', { code: 'qa-m9-d435', kind: 'MESSAGE', channel: 'EMAIL', body: 'Olá', ...unknown }],
    ['D435 editor', `/marketing/templates/${ids.template}/publish`, { ...unknown }],
    ['D435 editor', `/marketing/publications/${ids.job}/cancel`, { reason: 'Teste de campo desconhecido.', ...unknown }, true],
  ];
  const wrong = [];
  for (const [who, route, plain, confirm] of cases.map((c) => [c[0], c[1], c[2], c[3]])) {
    // kill switch e cancelamento passam antes pela confirmação de impacto (M9-D852): a confirmação vai no corpo, como a tela faria
    let body = plain;
    if (confirm && route.endsWith('/kill-switch')) body = await withConfirmation(http, who, '/marketing/kill-switch/impact', plain, { method: 'POST', body: { scope: 'GLOBAL', action: 'activate' } });
    if (confirm && route.endsWith('/cancel')) body = await withConfirmation(http, who, route.replace('/cancel', '/impact'), plain);
    const res = await call(who, 'POST', route, body);
    if (res.status !== 400 || !res.body.error || res.body.error.code !== 'MKT_VALIDATION') wrong.push(`${route} => ${res.status} ${res.body && res.body.error && res.body.error.code}`);
  }
  assert.deepEqual(wrong, [], 'rotas que não recusaram o campo desconhecido com 400 MKT_VALIDATION');
});

test('resposta_sem_segredo_nem_endereco: nenhuma resposta das rotas traz segredo, e-mail, telefone ou CPF', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  assert.ok(seen.length >= 20, 'as chamadas anteriores alimentam esta conferência');
  const patterns = [/[\w.+-]+@[\w-]+\.[\w.]+/, /(?<![\w.-])(?:\+?55\s?)?(?:\(\d{2}\)\s?|\d{2}\s?)9?\d{4}-?\d{4}(?![\w-])/, /\d{3}\.\d{3}\.\d{3}-\d{2}/, /"(password|senha|secret|apiKey|api_key|accessToken|refreshToken|authorization)"/i, /Bearer\s+\S+/];
  // ids (UUID, traceId) e datas saem antes; o telefone exige fronteira de palavra (não casa no meio de hash, código ou contador)
  const plain = (text) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '');
  for (const { route, text } of seen) for (const re of patterns) assert.ok(!re.test(plain(text)), `${route}: ${re} em ${text.slice(0, 200)}`);
});

test('isolamento_entre_empresas_nas_10_rotas: a outra empresa recebe 404 e nenhum dado da primeira', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const B = 'D435 outra empresa';
  const notFound = (res, codes = ['MKT_NOT_FOUND']) => { assert.equal(res.status, 404, JSON.stringify(res.body)); assert.ok(codes.includes(res.body.error.code), res.body.error.code); };
  notFound(await call(B, 'GET', `/marketing/content/${ids.content}`));
  notFound(await call(B, 'POST', `/marketing/content/${ids.content}/approve`, {}));
  notFound(await call(B, 'POST', `/marketing/content/${ids.content}/schedule`, { channels: ['SITE'], when: when(400) }));
  notFound(await call(B, 'POST', '/marketing/content', { contentItemId: ids.content }));
  notFound(await call(B, 'GET', `/marketing/campaigns/${ids.campaign}`));
  notFound(await call(B, 'POST', '/marketing/campaigns', { campaignId: ids.campaign, name: 'invasão' }));
  // automação e kill switch mantêm o código 404 próprio da dona (M9-D413 e M9-D425), já testado por ela (DI-D435-3)
  notFound(await call(B, 'POST', `/marketing/automations/${ids.flow}/publish`, { versionNo: 1, reason: 'Invasão.' }), ['MKT_AUTOMATION_NOT_FOUND']);
  notFound(await call(B, 'POST', `/marketing/automations/${ids.flow}/pause`, { reason: 'Invasão.' }), ['MKT_AUTOMATION_NOT_FOUND']);
  const ksBody = { scope: 'CAMPAIGN', targetId: ids.campaign, active: true, reason: 'Invasão de outra empresa.' };
  const sim = await call(B, 'POST', '/marketing/kill-switch/impact', { scope: 'CAMPAIGN', targetId: ids.campaign, action: 'activate' });
  if (sim.status === 200) notFound(await call(B, 'POST', '/marketing/kill-switch', { ...ksBody, confirmation: { understood: true, impactToken: sim.body.data.impactToken } }), ['MKT_KILL_SWITCH_TARGET_NOT_FOUND', 'MKT_NOT_FOUND']);
  else notFound(sim, ['MKT_KILL_SWITCH_TARGET_NOT_FOUND', 'MKT_NOT_FOUND']);
  const list = await call(B, 'GET', '/marketing/publications');
  assert.equal(list.status, 200);
  assert.ok(!list.body.data.some((j) => j.contentItemId === ids.content));
  const report = await call(B, 'GET', `/marketing/attribution?campaignId=${ids.campaign}`);
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.data.campaigns, [], 'o relatório da outra empresa não traz dado da primeira');
});

test('paginacao_e_filtros: padrão 50, máximo 200, filtros por status, canal e período', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const def = await call('D435 editor', 'GET', '/marketing/publications');
  assert.equal(def.body.pagination.pageSize, 50);
  const big = await call('D435 editor', 'GET', '/marketing/publications?pageSize=1000');
  assert.equal(big.status, 200);
  assert.equal(big.body.pagination.pageSize, 200, 'o máximo é 200');
  const one = await call('D435 editor', 'GET', '/marketing/publications?page=1&pageSize=1');
  assert.equal(one.body.data.length, 1);
  assert.ok(one.body.pagination.total >= 1);
  assert.equal((await call('D435 editor', 'GET', '/marketing/publications?channel=SITE&status=PENDING')).body.data.every((j) => j.channel === 'SITE' && j.status === 'PENDING'), true);
  const period = await call('D435 editor', 'GET', `/marketing/publications?from=${new Date(Date.now() + 86400000 * 30).toISOString()}`);
  assert.equal(period.body.data.length, 0, 'período no futuro distante: nada');
  for (const bad of ['status=XYZ', 'page=0', 'pageSize=0', 'from=ontem', 'channel=TELEGRAM']) {
    const res = await call('D435 editor', 'GET', `/marketing/publications?${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error.code, 'MKT_VALIDATION', bad);
  }
  const templates = await call('D435 editor', 'GET', '/marketing/templates?pageSize=1000');
  assert.equal(templates.status, 200);
  assert.equal(templates.body.data.pageSize, 200, 'a lista de templates também tem máximo 200');
  assert.equal((await call('D435 editor', 'GET', '/marketing/templates')).body.data.pageSize, 50, 'e padrão 50');
  const attribution = await call('D435 editor', 'GET', '/marketing/attribution?model=first&from=2026-01-01');
  assert.equal(attribution.status, 200);
  assert.equal((await call('D435 editor', 'GET', '/marketing/attribution?model=nenhum')).status >= 400, true);
});
