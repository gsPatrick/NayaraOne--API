'use strict';

// M9-D421 — Radar: imóvel novo compatível (radar.matched) -> sempre tarefa e notificação ao corretor; mensagem ao cliente só com OPT_IN de RADAR e canSend permitido.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d421.radar.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktLeads');
const agenda = require('../_helpers/mktAgenda');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
afterEach(() => agenda.reset());

const { allowTestUrls } = require('../_helpers/mktUrlPolicy');
const CODE = 'RADAR-NOVO-IMOVEL';
const inRollback = (fn) => env.withRollbackTenantTransaction(A, fn);
const radarMessages = async (t, personId) => (await env.outbound(t, personId)).filter((m) => m.purpose === 'RADAR');

/** Empresa pronta: base do endereço público do site (o link rastreável precisa dela) e a automação instalada. */
async function ready(t) {
  await allowTestUrls(t, A); // M9-D433: allowlist de URL externa por parâmetro
  await env.setParam(t, A, 'marketing.seo.url_base', 'https://www.exemplo.com.br');
  await env.setParam(t, A, 'marketing.review.url_base_rastreio', 'https://api.exemplo.com.br');
  await env.install(t, A, CODE);
}

/** Cliente com e-mail e OPT_IN em RADAR (ou sem), radar ativo do corretor e um imóvel público de R$ 500 mil. */
async function scenario(t, { optIn = ['RADAR'], radarStatus = 'ACTIVE', price = 500000 } = {}) {
  const broker = await env.broker(t, A);
  const lead = await env.lead(t, A, { name: 'Paulo Lima', source: 'SITE', owner: broker, optIn });
  const radarId = await env.radarOf(t, A, lead.personId, broker, radarStatus);
  const property = await agenda.fx.seedProperty(t, A, price);
  return { ...lead, broker, radarId, propertyId: property.id, internalCode: (await env.q(t, 'SELECT internal_code FROM real_estate.properties WHERE id = :id', { id: property.id }))[0].internal_code };
}

test('match_com_opt_in_dispara_mensagem_e_cria_tarefa', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t);
    const out = await env.run(t, A, env.radarEvent(A, s));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'COMPLETED');
    const [message] = await radarMessages(t, s.personId);
    assert.equal(message.status, 'SENT');
    assert.equal(env.sendEntry(row).purpose, 'RADAR');
    assert.match(message.body, /https:\/\/api\.exemplo\.com\.br\/t\/[A-Z0-9]{8}/, 'o link rastreável vai na mensagem');
    assert.ok(message.body.includes('Paulo'), 'a mensagem leva o primeiro nome');
    const tasks = await env.tasksOf(t, A, s.personId);
    const task = tasks.find((r) => r.title.startsWith('Cliente Paulo Lima tem match'));
    assert.equal(task.title, `Cliente Paulo Lima tem match com imóvel ${s.internalCode}`);
    assert.equal(task.assigned_to_user_id, s.broker, 'a tarefa vai ao corretor do radar');
    const notes = await env.notificationsOf(t, s.broker);
    assert.ok(notes.some((n) => (n.body || '').includes(`imóvel ${s.internalCode}`)), 'o corretor é avisado');
  });
});

test('match_sem_consentimento_apenas_sugere', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t, { optIn: [] });
    const out = await env.run(t, A, env.radarEvent(A, s));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'NO_CONSENT');
    assert.equal(env.sendEntry(row).status, 'SKIPPED');
    assert.equal((await radarMessages(t, s.personId)).length, 0, 'nenhum contato com o cliente');
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK', 'só a sugestão ao corretor: a tarefa');
    assert.equal(env.entry(row, 'NOTIFY_USER').status, 'OK', 'e a notificação');
  });
});

test('cliente_com_opt_out_nao_recebe_mas_o_corretor_e_avisado', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t);
    await env.optOut(t, A, s.personId, 'EMAIL');
    const out = await env.run(t, A, env.radarEvent(A, s));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.blocked_reason, 'SUPPRESSED');
    assert.equal((await radarMessages(t, s.personId)).length, 0);
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK');
  });
});

test('match_repetido_nao_reenvia', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t);
    const first = await env.run(t, A, env.radarEvent(A, s));
    const again = await env.run(t, A, env.radarEvent(A, s, { eventId: env.uid() })); // mesmo radar e imóvel, outro evento
    assert.equal(again.runs[0].replay, true);
    assert.equal(again.runs[0].runId, first.runs[0].runId);
    assert.equal((await radarMessages(t, s.personId)).length, 1, 'o mesmo imóvel nunca é enviado duas vezes ao mesmo radar');
    assert.equal((await env.tasksOf(t, A, s.personId)).filter((r) => r.title.startsWith('Cliente Paulo Lima tem match')).length, 1);
    const other = await agenda.fx.seedProperty(t, A, 450000);
    const next = await env.run(t, A, env.radarEvent(A, { ...s, propertyId: other.id }), { now: new Date(env.NOON_SP.getTime() + 3 * env.HOUR) });
    assert.equal(next.runs[0].replay, false, 'outro imóvel para o mesmo radar é um match novo');
  });
});

test('match_as_21h30_agenda_mensagem_para_08h_e_cria_tarefa_na_hora', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t);
    const night = new Date(env.NOON_SP.getTime() + 7.5 * env.HOUR); // dia seguinte ao NOON_SP, 00:30Z = 21:30 em São Paulo
    const out = await env.run(t, A, env.radarEvent(A, s), { now: night });
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'WAITING');
    assert.equal(env.sendEntry(row).status, 'SCHEDULED');
    assert.equal(new Date(env.sendEntry(row).due_at).toISOString(), env.MORNING.toISOString(), 'mensagem às 08:00');
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK', 'tarefa na hora');
    assert.ok((await env.tasksOf(t, A, s.personId)).some((r) => r.title.startsWith('Cliente Paulo Lima')));
    assert.equal((await radarMessages(t, s.personId)).length, 0);
    await env.runner.runDueActions(A, t, { now: new Date(env.MORNING.getTime() + 5 * 60000), mode: 'SANDBOX' });
    const [message] = await radarMessages(t, s.personId);
    assert.equal(message.status, 'SENT', 'enviada às 08:00 depois de novo canSend');
    assert.match(message.body, /\/t\/[A-Z0-9]{8}/, 'o imóvel e o link chegam também na mensagem adiada');
  });
});

test('mensagem_usa_apenas_dados_publicos', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t);
    await env.run(t, A, env.radarEvent(A, s));
    const [message] = await radarMessages(t, s.personId);
    assert.ok(message.body.includes('Jardim Europa'), 'bairro público');
    assert.ok(message.body.includes('3 quartos'), 'quartos');
    assert.ok(message.body.includes('500.000'), 'preço');
    assert.ok(!message.body.includes('Acácias'), 'nunca o logradouro');
    assert.ok(!message.body.includes(s.internalCode), 'nunca o código interno');
    assert.ok(!message.body.includes('01310'), 'nunca o CEP');
    const [tracked] = await env.q(t, "SELECT target_url FROM marketing.tracking_links WHERE company_id = :c ORDER BY created_at DESC LIMIT 1", { c: A.companyId });
    assert.match(tracked.target_url, /^https:\/\/www\.exemplo\.com\.br\/imoveis\/[0-9a-f-]{36}$/, 'o link aponta para a página pública pelo publicId');
  });
});

test('radar_inativo_nao_dispara', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t, { radarStatus: 'PAUSED' });
    const out = await env.run(t, A, env.radarEvent(A, s));
    assert.equal(out.runs.length, 0);
    assert.equal((await radarMessages(t, s.personId)).length, 0);
  });
});

test('o_frequency_cap_global_limita_os_disparos', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const s = await scenario(t);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const property = await agenda.fx.seedProperty(t, A, 400000 + i * 10000);
      const now = new Date(env.NOON_SP.getTime() + i * 2 * env.HOUR);
      const out = await env.run(t, A, env.radarEvent(A, { ...s, propertyId: property.id }), { now });
      await env.retime(t, s.personId, now);
      results.push((await env.runRow(t, out.runs[0].runId)).blocked_reason);
    }
    assert.deepEqual(results, [null, null, null, 'FREQUENCY_CAP'], 'três por 7 dias (cap global): a quarta é bloqueada');
    assert.equal((await radarMessages(t, s.personId)).length, 3);
  });
});

test('a_automacao_nasce_publicada_media_risco_com_deduplicacao_por_radar_e_imovel', async () => {
  await inRollback(async (t) => {
    await ready(t);
    const [row] = await env.q(t, `SELECT f.owner_user_id, f.status, v.status AS vstatus, v.risk_level, v.cooldown, v.trigger_config FROM marketing.automation_flows f
      JOIN marketing.automation_versions v ON v.id = f.published_version_id WHERE f.code = :c`, { c: CODE });
    assert.deepEqual([row.status, row.vstatus, row.risk_level], ['ACTIVE', 'PUBLISHED', 'MEDIUM']);
    assert.equal(row.owner_user_id, A.userId);
    assert.equal(row.trigger_config.eventType, 'radar.matched');
    assert.equal(row.trigger_config.dedupeKey, 'radar:{radarId}:{propertyId}');
    assert.ok(row.cooldown && row.cooldown.amount >= 1);
  });
});
