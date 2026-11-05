'use strict';

// M9-D418 — canSend(person, channel, purpose): supressão/opt-out > quiet hours > frequency cap > consentimento/política. Postgres real,
// role de runtime (RLS FORCE), transação com rollback. Rodar SOMENTE em banco descartável (ver m9d416.cap.test.js para o comando).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { canSend } = require('../../../src/features/marketing/suppression/canSend');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const env = require('../_helpers/mktPolicyEnv');

const { addMessage, addConsent, readyPerson, uid, HOUR } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
// Os instantes do cenário foram escritos sobre a segunda 09/11/2026; `at` os desloca em dias inteiros para a semana
// do NOON_SP (que acompanha a execução), mantendo hora e dia da semana. Os consentimentos que readyPerson grava
// partem do NOON_SP; com datas fixas o cenário ficaria antes deles com o tempo.
const SHIFT_MS = env.NOON_SP.getTime() - Date.parse('2026-11-09T17:00:00Z');
const at = (iso) => new Date(Date.parse(iso) + SHIFT_MS);
const FOURTEEN = at('2026-11-09T17:00:00Z'); // 14:00 em São Paulo
const send = (t, personId, instant, purpose = 'MARKETING', channel = 'WHATSAPP', over = {}) => canSend(personId, channel, purpose, instant,
  { tenant: A, transaction: t, officialTemplate: true, ...over });
const fill = async (t, personId, purpose = 'MARKETING') => { for (let i = 1; i <= 3; i += 1) await addMessage(t, A, { personId, purpose, at: new Date(FOURTEEN.getTime() - i * 24 * HOUR) }); };

test('opt_out_recebe_automacao_bloqueado', async () => {
  await run(async (t) => {
    const byConsent = await readyPerson(t, A);
    await addConsent(t, A, byConsent, 'WHATSAPP', 'MARKETING', 'OPT_OUT', new Date(FOURTEEN.getTime() - HOUR));
    const consent = await send(t, byConsent, FOURTEEN);
    assert.deepEqual([consent.allowed, consent.reason, consent.code], [false, 'OPT_OUT', 'MKT_SUPPRESSED']);
    assert.equal(consent.message, 'Esta pessoa pediu para não receber mensagens.');
    // OPT_IN posterior reabre; OPT_OUT geral (ALL) mais recente bloqueia toda finalidade
    await addConsent(t, A, byConsent, 'WHATSAPP', 'MARKETING', 'OPT_IN', FOURTEEN);
    assert.equal((await send(t, byConsent, new Date(FOURTEEN.getTime() + HOUR))).allowed, true);
    await addConsent(t, A, byConsent, 'WHATSAPP', 'ALL', 'OPT_OUT', new Date(FOURTEEN.getTime() + 2 * HOUR));
    assert.equal((await send(t, byConsent, new Date(FOURTEEN.getTime() + 3 * HOUR))).reason, 'OPT_OUT');

    const byList = await readyPerson(t, A);
    await suppress({ personId: byList, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    const listed = await send(t, byList, FOURTEEN);
    assert.deepEqual([listed.allowed, listed.reason, listed.code], [false, 'SUPPRESSED', 'MKT_SUPPRESSED']);
    assert.equal((await send(t, byList, FOURTEEN, 'MARKETING', 'EMAIL')).allowed, true, 'a supressão é por canal');
  });
});

test('ordem_de_precedencia_supressao_quiet_cap_consent', async () => {
  await run(async (t) => {
    const night = at('2026-11-10T01:00:00Z'); // 22:00 em São Paulo
    // opt-out + 22:00 + cap estourado + sem consentimento de NUTRICAO: vence a supressão
    const p = await readyPerson(t, A, { optIn: [] });
    await fill(t, p, 'NUTRICAO');
    await suppress({ personId: p, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    assert.equal((await send(t, p, night, 'NUTRICAO')).reason, 'SUPPRESSED');
    // sem supressão, 22:30, cap estourado, sem consentimento: quiet hours, liberando às 08:00 do dia seguinte
    const q2 = await readyPerson(t, A, { optIn: [] });
    await fill(t, q2, 'NUTRICAO');
    const quiet = await send(t, q2, at('2026-11-10T01:30:00Z'), 'NUTRICAO');
    assert.equal(quiet.reason, 'QUIET_HOURS');
    assert.equal(quiet.code, 'MKT_QUIET_HOURS');
    assert.equal(quiet.nextEligibleAt.toISOString(), at('2026-11-10T11:00:00.000Z').toISOString());
    // fora do silêncio, cap estourado e sem consentimento: o cap vem antes do consentimento
    const cap = await send(t, q2, FOURTEEN, 'NUTRICAO');
    assert.equal(cap.reason, 'FREQUENCY_CAP');
    // fora do silêncio, dentro do cap, sem OPT_IN para NUTRICAO: NO_CONSENT
    const noConsent = await readyPerson(t, A, { optIn: [] });
    const decision = await send(t, noConsent, FOURTEEN, 'NUTRICAO');
    assert.deepEqual([decision.reason, decision.code, decision.message], ['NO_CONSENT', 'MKT_NO_CONSENT', 'Não há consentimento para esta finalidade.']);
    // com tudo em dia: allowed
    const ok = await readyPerson(t, A);
    assert.deepEqual(await send(t, ok, FOURTEEN), { allowed: true, reason: null, nextEligibleAt: null, count: 0, limit: 3 });
  });
});

test('quiet_hours_cruza_meia_noite', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const sp = (hhmm) => at(`2026-11-10T${hhmm}:00Z`); // helper: hora UTC; São Paulo = UTC-3
    // 21:00-08:00: 23:00 (02:00Z), 02:00 (05:00Z) e 07:30 (10:30Z) em silêncio; 12:00 (15:00Z) livre
    for (const [utc, quiet] of [['02:00', true], ['05:00', true], ['10:30', true], ['15:00', false]]) {
      assert.equal((await send(t, p, sp(utc))).reason === 'QUIET_HOURS', quiet, `UTC ${utc}`);
    }
    // o silêncio não perde a ação: a resposta traz o instante em que volta a poder enviar
    assert.equal((await send(t, p, sp('02:00'))).nextEligibleAt.toISOString(), at('2026-11-10T11:00:00.000Z').toISOString());
    // o administrador muda a janela sem deploy: 20:00-09:00 passa a incluir 08:30 (11:30Z) e libera 20:00 (23:00Z -> silêncio)
    await upsertSetting('marketing.quiet_hours', '20:00 a 09:00 America/Sao_Paulo', A, A.userId, t);
    assert.equal((await send(t, p, sp('11:30'))).reason, 'QUIET_HOURS');
    assert.equal((await send(t, p, sp('12:00'))).allowed, true);
    assert.equal((await send(t, p, sp('23:30'))).reason, 'QUIET_HOURS');
    // janela que não cruza a meia-noite
    await upsertSetting('marketing.quiet_hours', '11:00 a 13:00 America/Sao_Paulo', A, A.userId, t);
    assert.equal((await send(t, p, sp('15:00'))).reason, 'QUIET_HOURS');
    assert.equal((await send(t, p, sp('02:00'))).allowed, true);
  });
});

test('quiet_hours_borda_08_00_liberado_e_21_00_bloqueado', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const cases = [
      ['2026-11-10T10:59:59Z', 'QUIET_HOURS'], // 07:59:59 em São Paulo
      ['2026-11-10T11:00:00Z', null], // 08:00:00: liberado
      ['2026-11-10T23:59:59Z', null], // 20:59:59: liberado
      ['2026-11-11T00:00:00Z', 'QUIET_HOURS'], // 21:00:00: bloqueado
    ];
    for (const [iso, reason] of cases) {
      const d = await send(t, p, at(iso));
      assert.equal(d.allowed, reason === null, `${iso}: ${JSON.stringify(d)}`);
      if (reason) assert.equal(d.reason, reason);
    }
  });
});

test('transacional_nao_exige_opt_in_mas_respeita_supressao', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A, { optIn: [] });
    assert.equal((await send(t, p, FOURTEEN, 'TRANSACTIONAL')).allowed, true, 'confirmação de lead sem OPT_IN, 14:00');
    assert.equal((await send(t, p, FOURTEEN, 'ACOMPANHAMENTO')).allowed, true);
    assert.equal((await send(t, p, at('2026-11-10T01:30:00Z'), 'TRANSACTIONAL')).reason, 'QUIET_HOURS', 'o horário vale para todas');
    await fill(t, p); // mensagens de MARKETING: não consomem o cap do transacional (cap por finalidade)
    assert.equal((await send(t, p, FOURTEEN, 'TRANSACTIONAL')).allowed, true);
    for (let i = 1; i <= 3; i += 1) await addMessage(t, A, { personId: p, purpose: 'TRANSACTIONAL', at: new Date(FOURTEEN.getTime() - i * 24 * HOUR) });
    assert.equal((await send(t, p, FOURTEEN, 'TRANSACTIONAL')).reason, 'FREQUENCY_CAP', 'o cap vale para todas as finalidades');
    const q2 = await readyPerson(t, A, { optIn: [] });
    await suppress({ personId: q2, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    assert.equal((await send(t, q2, FOURTEEN, 'TRANSACTIONAL')).reason, 'SUPPRESSED');
  });
});

test('finalidade_fora_das_listas_e_recusada_e_pos_venda_exige_opt_in', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A, { optIn: [] });
    await assert.rejects(send(t, p, FOURTEEN, 'PROMOCAO_QUALQUER'), (e) => {
      assert.equal(e.statusCode, 422);
      assert.equal(e.code, 'MKT_PURPOSE_UNKNOWN');
      assert.equal(e.message, 'Finalidade de mensagem não reconhecida.');
      return true;
    });
    for (const purpose of ['POS_VENDA', 'AVALIACAO', 'RADAR', 'NUTRICAO', 'MARKETING']) assert.equal((await send(t, p, FOURTEEN, purpose)).reason, 'NO_CONSENT', purpose);
    assert.equal((await send(t, p, FOURTEEN, 'ACOMPANHAMENTO')).allowed, true);
    await addConsent(t, A, p, 'WHATSAPP', 'POS_VENDA', 'OPT_IN');
    assert.equal((await send(t, p, FOURTEEN, 'POS_VENDA')).allowed, true);
    // a lista é do administrador: uma finalidade nova entra pelo parâmetro (e sai da recusa)
    await upsertSetting('marketing.consent.exige_opt_in_para', 'MARKETING, NUTRICAO, RADAR, AVALIACAO, POS_VENDA, LANCAMENTO', A, A.userId, t);
    assert.equal((await send(t, p, FOURTEEN, 'LANCAMENTO')).reason, 'NO_CONSENT');
    await assert.rejects(upsertSetting('marketing.consent.exige_opt_in_para', 'marketing, !!', A, A.userId, t), (e) => e.code === 'MKT_PARAM_INVALID');
  });
});

test('politica_de_canal_whatsapp_fora_da_janela_so_com_template_oficial', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const plain = { officialTemplate: false };
    assert.equal((await send(t, p, FOURTEEN, 'MARKETING', 'WHATSAPP', plain)).reason, 'CHANNEL_POLICY');
    assert.equal((await send(t, p, FOURTEEN, 'MARKETING', 'WHATSAPP', { officialTemplate: true })).allowed, true);
    assert.equal((await send(t, p, FOURTEEN, 'MARKETING', 'EMAIL', plain)).allowed, true, 'e-mail não tem janela de atendimento');
    await addMessage(t, A, { personId: p, direction: 'INBOUND', status: 'RECEIVED', at: new Date(FOURTEEN.getTime() - 23 * HOUR) });
    assert.equal((await send(t, p, FOURTEEN, 'MARKETING', 'WHATSAPP', plain)).allowed, true, 'respondeu há 23 h: dentro da janela de 24 h');
    await upsertSetting('marketing.whatsapp.janela_atendimento_h', 12, A, A.userId, t);
    assert.equal((await send(t, p, FOURTEEN, 'MARKETING', 'WHATSAPP', plain)).reason, 'CHANNEL_POLICY');
  });
});

test('sem_endereco_utilizavel_e_bloqueado_e_endereco_formatado_de_outro_jeito_e_o_mesmo', async () => {
  await run(async (t) => {
    const none = await readyPerson(t, A, { phone: null, email: null });
    assert.deepEqual([(await send(t, none, FOURTEEN)).reason, (await send(t, none, FOURTEEN)).code], ['NO_ADDRESS', 'MKT_NO_ADDRESS']);
    const a = await readyPerson(t, A, { phone: '+55 (11) 98765-4321', email: `QA-M9-${uid().slice(0, 6)}@Exemplo.Test` });
    const b = await readyPerson(t, A, { phone: '11987654321' });
    await suppress({ personId: a, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    assert.equal((await send(t, b, FOURTEEN)).reason, 'SUPPRESSED', 'o mesmo número em outro formato cai na mesma supressão (hash)');
  });
});
