'use strict';

// M9-D417 — Cadência, quiet hours e frequency cap como parâmetros (MKT-005). Postgres real, transação com rollback. Só em banco
// descartável (o .env aponta para a homologação remota): node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test
// node --test --test-concurrency=1 test/m9d417.cadenciaParametros.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const { upsertSetting } = require('../src/features/settings/settings.service');
const P = require('../src/features/marketing/automations/cadence');
const { scanSource, scanDirectory } = require('../scripts/lib/noHardcodedCadence');

let tenant;
let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const run = (fn) => withRollbackTenantTransaction(tenant, fn);
const ELEVEN = '2026-11-10';

test('cadencia_vem_do_motor_de_regras_e_nao_do_codigo', async () => {
  await run(async (t) => {
    // Padrões do livro/CSV quando a empresa nada configurou.
    assert.deepEqual(await P.getMarketingParam(P.POS_KEYS_DAYS_KEY, tenant, t), [3, 30, 90, 365]);
    assert.deepEqual(await P.getMarketingParam(P.RENTAL_DAYS_KEY, tenant, t), [7, 15, 30, 90, 180]);
    assert.deepEqual(await P.getMarketingParam(P.NO_REPLY_DAYS_KEY, tenant, t), [1, 3, 7]);
    assert.deepEqual(await P.getMarketingParam(P.QUIET_HOURS_KEY, tenant, t), { startMinutes: 1260, endMinutes: 480, timeZone: 'America/Sao_Paulo' });
    assert.deepEqual(await P.getMarketingParam(P.FREQUENCY_CAP_KEY, tenant, t), { messages: 3, days: 7 });
    // Exemplo numérico do livro: entrega em 10/11/2026.
    const plan = await P.planCadence(P.POS_KEYS_DAYS_KEY, ELEVEN, tenant, t);
    assert.deepEqual(plan.map((p) => p.dueDate), ['2026-11-13', '2026-12-10', '2027-02-08', '2027-11-10']);
    // O valor lido vem da configuração da empresa, não de constante: outra empresa não é afetada.
    await upsertSetting(P.NO_REPLY_DAYS_KEY, '[2,4]', tenant, tenant.userId, t);
    assert.deepEqual(await P.getMarketingParam(P.NO_REPLY_DAYS_KEY, tenant, t), [2, 4]);
    assert.deepEqual(await P.getMarketingParam(P.NO_REPLY_DAYS_KEY, tenantB, t), [1, 3, 7]);
    // Código desconhecido: 404 MKT_PARAM_NOT_FOUND.
    await assert.rejects(P.getMarketingParam('marketing.cadencia.inexistente', tenant, t), (e) => e.statusCode === 404 && e.code === 'MKT_PARAM_NOT_FOUND');
  });
});

test('alterar_parametro_muda_proxima_execucao_sem_deploy', async () => {
  await run(async (t) => {
    await upsertSetting(P.POS_KEYS_DAYS_KEY, '3,45,120,365', tenant, tenant.userId, t);
    const plan = await P.planCadence(P.POS_KEYS_DAYS_KEY, ELEVEN, tenant, t);
    assert.deepEqual(plan.map((p) => p.dueDate), ['2026-11-13', '2026-12-25', '2027-03-10', '2027-11-10']);
    // Quiet hours e cap mudam o comportamento das verificações sem deploy.
    const noon = new Date('2026-11-10T15:00:00Z'); // 12:00 em São Paulo
    assert.equal((await P.checkQuietHours(noon, tenant, t)).quiet, false);
    await upsertSetting(P.QUIET_HOURS_KEY, '11:00 a 13:00 America/Sao_Paulo', tenant, tenant.userId, t);
    const after = await P.checkQuietHours(noon, tenant, t);
    assert.equal(after.quiet, true);
    assert.equal(after.nextAllowedAt.toISOString(), '2026-11-10T16:00:00.000Z');
    const sent = [new Date('2026-11-09T12:00:00Z'), new Date('2026-11-08T12:00:00Z')];
    assert.equal((await P.checkFrequencyCap(sent, noon, tenant, t)).allowed, true);
    await upsertSetting(P.FREQUENCY_CAP_KEY, '2 mensagens por 7 dias', tenant, tenant.userId, t);
    const capped = await P.checkFrequencyCap(sent, noon, tenant, t);
    assert.equal(capped.allowed, false);
    assert.equal(capped.releasesAt.toISOString(), '2026-11-15T12:00:00.000Z');
  });
});

test('quiet_hours_cruza_a_meia_noite_e_respeita_o_fuso', () => {
  const cfg = { startMinutes: 1260, endMinutes: 480, timeZone: 'America/Sao_Paulo' };
  assert.equal(P.isQuietNow(new Date('2026-11-11T00:30:00Z'), cfg), true); // 21:30 local
  assert.equal(P.isQuietNow(new Date('2026-11-10T05:00:00Z'), cfg), true); // 02:00 local
  assert.equal(P.isQuietNow(new Date('2026-11-10T11:00:00Z'), cfg), false); // 08:00 local (fim exclusivo)
  assert.equal(P.isQuietNow(new Date('2026-11-10T23:59:00Z'), cfg), false); // 20:59 local
});

test('valor_invalido_e_recusado', async () => {
  await run(async (t) => {
    const bad = [
      [P.QUIET_HOURS_KEY, '25:00 a 08:00 America/Sao_Paulo'],
      [P.QUIET_HOURS_KEY, '21:00 a 08:00 Marte/Fantasma'],
      [P.QUIET_HOURS_KEY, '21:00 a 21:00 America/Sao_Paulo'],
      [P.POS_KEYS_DAYS_KEY, '[30,3]'],
      [P.POS_KEYS_DAYS_KEY, '[3,3]'],
      [P.POS_KEYS_DAYS_KEY, '[0,3]'],
      [P.POS_KEYS_DAYS_KEY, 'abc'],
      [P.RENTAL_DAYS_KEY, '[1,99999]'],
      [P.FREQUENCY_CAP_KEY, '0 mensagens por 7 dias'],
      [P.FREQUENCY_CAP_KEY, '3 mensagens por 400 dias'],
      [P.FREQUENCY_CAP_KEY, 'três por semana'],
    ];
    for (const [key, value] of bad) {
      await assert.rejects(upsertSetting(key, value, tenant, tenant.userId, t), (e) => e.statusCode === 422 && e.code === 'MKT_PARAM_INVALID' && e.message === 'Valor inválido para o parâmetro.', `${key}=${value}`);
    }
    // Aceita as duas grafias de lista.
    await upsertSetting(P.NO_REPLY_DAYS_KEY, '2, 5, 9', tenant, tenant.userId, t);
    assert.deepEqual(await P.getMarketingParam(P.NO_REPLY_DAYS_KEY, tenant, t), [2, 5, 9]);
  });
});

test('historico_guarda_antes_e_depois_e_ator', async () => {
  await run(async (t) => {
    await upsertSetting(P.POS_KEYS_DAYS_KEY, '[3,45,120,365]', tenant, tenant.userId, t);
    await upsertSetting(P.POS_KEYS_DAYS_KEY, '[5,60]', tenant, tenant.userId, t);
    const history = await P.listMarketingParamHistory(P.POS_KEYS_DAYS_KEY, tenant, t);
    assert.equal(history.length, 2);
    assert.equal(history[0].before, '[3,45,120,365]');
    assert.equal(history[0].after, '[5,60]');
    assert.equal(history[0].changedBy, tenant.userId);
    assert.equal(history[1].before, null);
    const list = await P.listMarketingParams(tenant, t);
    assert.equal(list.length, P.CADENCE_KEYS.length); // M9-D422 acrescentou o horário de envio da cadência
    assert.ok(list.some((p) => p.code === P.SEND_TIME_KEY && p.isDefault && p.value === '10:00'));
    assert.equal(list.find((p) => p.code === P.POS_KEYS_DAYS_KEY).isDefault, false);
    assert.equal(list.find((p) => p.code === P.QUIET_HOURS_KEY).isDefault, true);
  });
});

test('acoes_ja_agendadas_nao_mudam', async () => {
  await run(async (t) => {
    const scheduled = await P.planCadence(P.POS_KEYS_DAYS_KEY, ELEVEN, tenant, t);
    const snapshot = JSON.stringify(scheduled);
    await upsertSetting(P.POS_KEYS_DAYS_KEY, '[3,45,120,365]', tenant, tenant.userId, t);
    assert.equal(JSON.stringify(scheduled), snapshot);
    assert.throws(() => { scheduled[1].dueDate = '2030-01-01'; }, TypeError);
    const fresh = await P.planCadence(P.POS_KEYS_DAYS_KEY, ELEVEN, tenant, t);
    assert.equal(fresh[1].dueDate, '2026-12-25');
    assert.equal(scheduled[1].dueDate, '2026-12-10');
  });
});

test('ci_falha_com_cadencia_literal_no_codigo', () => {
  const ruim = {
    cadencia: 'const dias = [3, 30, 90, 365];',
    horario: "const quiet = '21:00';",
    fuso: "const tz = 'America/Sao_Paulo';",
    cap: "const cap = '3 mensagens por 7 dias';",
  };
  const kinds = Object.entries(ruim).map(([k, src]) => [k, scanSource('src/features/marketing/automations/x.js', src).map((f) => f.kind)]);
  assert.deepEqual(kinds, [['cadencia', ['cadencia']], ['horario', ['horario_de_silencio']], ['fuso', ['fuso']], ['cap', ['frequency_cap']]]);
  // Comentário, lista não crescente e arquivos de padrões/dicionários não contam.
  assert.deepEqual(scanSource('src/features/marketing/a.js', '// [3, 30, 90, 365] e 21:00\nconst x = [5, 4, 3];'), []);
  assert.deepEqual(scanSource('src/features/marketing/automations/cadence/cadence.defaults.js', ruim.cadencia), []);
  assert.deepEqual(scanSource('src/features/marketing/marketing.settings.js', ruim.horario), []);
  // O código real do módulo está limpo.
  assert.deepEqual(scanDirectory(path.join(__dirname, '..', 'src', 'features', 'marketing')), []);
});

test('parametros_do_csv_existem_no_dicionario_e_na_tela', () => {
  const root = path.join(__dirname, '..', '..');
  const csv = fs.readFileSync(path.join(root, 'Maturacao', 'demandas', 'parametros.csv'), 'utf8');
  const { SETTINGS_SCHEMA } = (() => { const s = require('../src/features/settings/settings.service'); return { SETTINGS_SCHEMA: s.SETTINGS_SCHEMA }; })();
  for (const key of P.CADENCE_KEYS) {
    assert.ok(csv.includes(`"${key}"`), `${key} no parametros.csv`);
    assert.ok(SETTINGS_SCHEMA[key], `${key} no SETTINGS_SCHEMA`);
    assert.ok(P.PARSERS[key](P.CADENCE_DEFAULTS[key]), `${key}: o padrão passa na própria validação`);
  }
  const tab = fs.readFileSync(path.join(root, 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes', 'marketingCadenceGroups.js'), 'utf8');
  for (const key of P.CADENCE_KEYS) assert.ok(tab.includes(key), `${key} na aba Marketing`);
});
