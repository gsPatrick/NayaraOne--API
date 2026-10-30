'use strict';

// M9-D420 C — Cliente frio: agenda semanal (segunda 09:00), nutrição com conteúdo aprovado, consentimento NUTRICAO e limite de 4 em 90 dias (janela móvel) lido do parâmetro.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d420.frio.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktLeads');
const agenda = require('../_helpers/mktAgenda');
const { BLOCK_REASONS } = require('../../../src/features/marketing/automations/policy.reasons');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
afterEach(() => agenda.reset());

const CODE = 'LEAD-CLIENTE-FRIO';
const inRollback = (fn) => env.withRollbackTenantTransaction(A, fn);
const monday9 = (day) => new Date(`${day}T12:00:00.000Z`); // 09:00 em São Paulo
const MONDAYS = ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'];
const LONG_AGO = new Date('2026-07-01T12:00:00.000Z'); // mais de 60 dias antes de 09/11

/** Conteúdo aprovado por uma pessoa (pipeline completo) e o tipo dele liberado para a nutrição. */
async function approvedContent(t) {
  const reviewer = await env.broker(t, A);
  const item = await agenda.approvedItem(t, { tenant: A, reviewer });
  await env.setParam(t, A, 'marketing.cliente_frio.tipos_conteudo', 'NEW_PROPERTY');
  return item;
}

/** Cliente frio: oportunidade antiga e nenhuma interação. */
async function coldClient(t, over = {}) {
  const lead = await env.lead(t, A, { source: 'FORM', optIn: ['NUTRICAO'], ...over });
  await env.ageOpportunities(t, lead.personId, LONG_AGO);
  return lead;
}

async function weekly(t, personId, day) {
  const out = await env.runner.runScheduleTick(A, t, { now: monday9(day), mode: 'SANDBOX' });
  await env.retime(t, personId, monday9(day));
  return out;
}
const nutrition = async (t, personId) => (await env.outbound(t, personId)).filter((m) => m.purpose === 'NUTRICAO');
/** A run da semana `day` (o horário das runs é o da transação do teste, então a janela do evento é quem as distingue). */
const runOf = async (t, personId, day) => (await env.q(t, 'SELECT * FROM marketing.automation_runs WHERE subject_id = :p AND trigger_event_id = :e', { p: personId, e: `cliente-frio:${personId}:${monday9(day).toISOString()}` }))[0];

test('cliente_frio_respeita_limite_de_4_em_90_dias', async () => {
  await inRollback(async (t) => {
    await approvedContent(t);
    await env.install(t, A, CODE);
    const client = await coldClient(t);
    const sent = [];
    for (const day of MONDAYS) {
      await weekly(t, client.personId, day);
      sent.push((await nutrition(t, client.personId)).length);
    }
    assert.deepEqual(sent, [1, 2, 3, 4, 4], 'quatro mensagens; a quinta fica de fora');
    const run = await runOf(t, client.personId, MONDAYS[4]);
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.blocked_reason, 'FREQUENCY_CAP');
    assert.equal(env.sendEntry(run).error_code, 'FREQUENCY_CAP');
    assert.equal(BLOCK_REASONS.FREQUENCY_CAP.code, 'MKT_FREQUENCY_CAP_EXCEEDED');
    // a janela é móvel: 90 dias depois da primeira mensagem a contagem cai e volta a enviar sozinha
    await weekly(t, client.personId, '2027-02-08');
    assert.equal((await nutrition(t, client.personId)).length, 5, 'janela móvel: a primeira mensagem saiu da janela de 90 dias');
  });
});

test('cliente_frio_sem_opt_in_nao_recebe', async () => {
  await inRollback(async (t) => {
    await approvedContent(t);
    await env.install(t, A, CODE);
    const client = await coldClient(t, { optIn: [] });
    await weekly(t, client.personId, MONDAYS[0]);
    assert.equal((await nutrition(t, client.personId)).length, 0);
    const run = await runOf(t, client.personId, MONDAYS[0]);
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.blocked_reason, 'NO_CONSENT');
    assert.equal(BLOCK_REASONS.NO_CONSENT.code, 'MKT_NO_CONSENT');
  });
});

test('cliente_frio_limite_usa_o_cap_da_versao_lido_do_parametro', async () => {
  await inRollback(async (t) => {
    await approvedContent(t);
    await env.install(t, A, CODE);
    const [version] = await env.q(t, 'SELECT v.frequency_cap FROM marketing.automation_flows f JOIN marketing.automation_versions v ON v.id = f.published_version_id WHERE f.code = :c', { c: CODE });
    assert.deepEqual(version.frequency_cap, { maxParam: 'marketing.cliente_frio.max_mensagens', windowDaysParam: 'marketing.cliente_frio.janela_dias', scope: 'PERSON_CHANNEL_PURPOSE' }, 'a versão guarda os NOMES dos parâmetros, não os números');
    const client = await coldClient(t);
    await weekly(t, client.personId, MONDAYS[0]);
    await env.setParam(t, A, 'marketing.cliente_frio.max_mensagens', 1); // vale na próxima avaliação, sem nova versão
    await weekly(t, client.personId, MONDAYS[1]);
    assert.equal((await nutrition(t, client.personId)).length, 1);
    const run = await runOf(t, client.personId, MONDAYS[1]);
    assert.equal(run.blocked_reason, 'FREQUENCY_CAP');
    await env.setParam(t, A, 'marketing.cliente_frio.max_mensagens', 4);
    await env.setParam(t, A, 'marketing.cliente_frio.janela_dias', 7); // a primeira mensagem (7 dias atrás) saiu da janela de 7 dias? precisa passar de 7
    await weekly(t, client.personId, MONDAYS[2]);
    assert.equal((await nutrition(t, client.personId)).length, 2, 'cap aumentado pelo parâmetro: volta a enviar');
  });
});

test('quem_interagiu_ha_menos_dias_que_o_parametro_nao_e_cliente_frio', async () => {
  await inRollback(async (t) => {
    await approvedContent(t);
    await env.install(t, A, CODE);
    const warm = await coldClient(t);
    await env.contact(t, A, warm.personId, new Date('2026-10-20T12:00:00.000Z'), 'INBOUND'); // 20 dias antes de 09/11
    await weekly(t, warm.personId, MONDAYS[0]);
    assert.equal((await nutrition(t, warm.personId)).length, 0, 'interagiu há 20 dias: não é frio');
    await env.setParam(t, A, 'marketing.cliente_frio.dias_inatividade', 15);
    await weekly(t, warm.personId, MONDAYS[1]);
    assert.equal((await nutrition(t, warm.personId)).length, 1, 'com 15 dias de inatividade no parâmetro, passa a ser frio');
  });
});

test('mensagem_automatica_nao_conta_como_interacao_e_a_resposta_tira_da_nutricao', async () => {
  await inRollback(async (t) => {
    await approvedContent(t);
    await env.install(t, A, CODE);
    const client = await coldClient(t);
    await weekly(t, client.personId, MONDAYS[0]);
    await weekly(t, client.personId, MONDAYS[1]);
    assert.equal((await nutrition(t, client.personId)).length, 2, 'a nutrição enviada não esfria nem aquece o cliente');
    await env.contact(t, A, client.personId, new Date('2026-11-18T12:00:00.000Z'), 'INBOUND'); // o cliente respondeu
    await weekly(t, client.personId, MONDAYS[2]);
    assert.equal((await nutrition(t, client.personId)).length, 2, 'deixou de ser cliente frio por uma interação');
  });
});

test('sem_conteudo_aprovado_nada_e_enviado', async () => {
  await inRollback(async (t) => {
    await env.install(t, A, CODE);
    const client = await coldClient(t);
    await weekly(t, client.personId, MONDAYS[0]);
    assert.equal((await nutrition(t, client.personId)).length, 0, 'nunca inventa conteúdo');
    const run = await runOf(t, client.personId, MONDAYS[0]);
    assert.equal(env.sendEntry(run).error_code, 'MKT_VARIABLE_NOT_AVAILABLE');
  });
});

test('a_nutricao_leva_so_o_conteudo_aprovado_e_sai_no_canal_com_opt_in', async () => {
  await inRollback(async (t) => {
    const content = await approvedContent(t);
    await env.install(t, A, CODE);
    const client = await coldClient(t, { phone: true });
    await env.q(t, "DELETE FROM people.communication_consents WHERE person_id = :p AND channel = 'WHATSAPP' RETURNING id", { p: client.personId }); // só o e-mail tem OPT_IN
    await weekly(t, client.personId, MONDAYS[0]);
    const [message] = await nutrition(t, client.personId);
    assert.equal(message.channel, 'EMAIL', 'o canal escolhido é o que tem OPT_IN para NUTRICAO');
    const [version] = await env.q(t, 'SELECT body_json FROM marketing.content_versions WHERE content_item_id = :i ORDER BY version_no DESC LIMIT 1', { i: content.itemId });
    assert.ok(message.body.includes(version.body_json.renderizado || version.body_json.texto), 'o texto aprovado do conteúdo');
  });
});

test('mesma_semana_duas_vezes_nao_repete_a_nutricao_e_a_agenda_so_dispara_na_segunda', async () => {
  await inRollback(async (t) => {
    await approvedContent(t);
    await env.install(t, A, CODE);
    const client = await coldClient(t);
    const notMonday = await env.runner.runScheduleTick(A, t, { now: monday9('2026-11-10'), mode: 'SANDBOX' }); // terça-feira
    assert.equal(notMonday.created, 0);
    await env.runner.runScheduleTick(A, t, { now: monday9('2026-11-09'), mode: 'SANDBOX' });
    await env.runner.runScheduleTick(A, t, { now: new Date(monday9('2026-11-09').getTime() + 20000), mode: 'SANDBOX' });
    assert.equal((await nutrition(t, client.personId)).length, 1);
    const [version] = await env.q(t, 'SELECT v.trigger_config, v.risk_level, v.cooldown FROM marketing.automation_flows f JOIN marketing.automation_versions v ON v.id = f.published_version_id WHERE f.code = :c', { c: CODE });
    assert.equal(version.trigger_config.cron, '0 9 * * 1');
    assert.equal(version.risk_level, 'MEDIUM');
    assert.deepEqual(version.cooldown, { amount: 7, unit: 'DAYS' });
  });
});
