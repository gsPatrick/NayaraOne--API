'use strict';

// M9-D908 — parâmetros do administrador (aba Governança): validação de cada chave (faixa, enum e fuso IANA) e padrões do livro. Cada chave tem o seu consumidor provado nos testes de
// relógio, fuso, ensaio e alertas desta demanda. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d908Env');
const { getSetting } = require('../../../src/features/settings/settings.service');
const { CLOCK_SETTING_DEFAULTS } = require('../../../src/features/migration-v2/clock/clock.settings');
const { TIMEZONE_SETTING_DEFAULTS } = require('../../../src/features/migration-v2/timezone/timezone.settings');
const { DRY_SETTING_DEFAULTS } = require('../../../src/features/migration-v2/dryrun/dry.settings');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

const read = (key, fallback) => env.openTenantTx(A, (tx) => getSetting(key, env.tenantOf(A), tx, fallback));

test('m9d908 os padrões são os do livro', { skip: skip() }, async () => {
  assert.equal(CLOCK_SETTING_DEFAULTS['migracao.relogio.deriva_max_s'], 2);
  assert.equal(CLOCK_SETTING_DEFAULTS['migracao.relogio.reverificar_min'], 5);
  assert.equal(TIMEZONE_SETTING_DEFAULTS['migracao.fuso_origem'], 'America/Sao_Paulo');
  assert.equal(TIMEZONE_SETTING_DEFAULTS['migracao.fuso.ambiguo'], 'FIRST_OCCURRENCE');
  assert.equal(TIMEZONE_SETTING_DEFAULTS['migracao.fuso.amostra_por_entidade'], 1000);
  assert.equal(DRY_SETTING_DEFAULTS['migracao.paralelo.prazo_dias'], 7);
  for (const [key, value] of Object.entries({ ...CLOCK_SETTING_DEFAULTS, ...TIMEZONE_SETTING_DEFAULTS, ...DRY_SETTING_DEFAULTS })) assert.equal(await read(key, value), value, key);
});

test('m9d908 valores fora da regra são recusados e valores bons são gravados e lidos', { skip: skip() }, async () => {
  const bad = [
    ['migracao.relogio.deriva_max_s', -1], ['migracao.relogio.deriva_max_s', 'dois'], ['migracao.relogio.reverificar_min', 0], ['migracao.relogio.ntp_timeout_ms', 5],
    ['migracao.relogio.ntp_ativo', 'talvez'], ['migracao.fuso_origem', 'Marte/Olympus'], ['migracao.fuso.ambiguo', 'LAST_OCCURRENCE'], ['migracao.fuso.amostra_por_entidade', 0],
    ['migracao.paralelo.prazo_dias', 0], ['migracao.dry3.janela_comparacao_min', 0], ['migracao.dry3.exemplos_no_relatorio', 101], ['migracao.dry3.dados_pessoais_em_claro', 'sim'], ['migracao.dry3.timeout_min', 0],
  ];
  for (const [key, value] of bad) {
    const refused = await env.fail(env.setParam(A, key, value));
    assert.ok(refused && refused.status === 400, `${key}=${value} deveria ser recusado`);
  }
  const good = {
    'migracao.relogio.deriva_max_s': 5, 'migracao.relogio.reverificar_min': 10, 'migracao.relogio.ntp_ativo': false, 'migracao.relogio.ntp_servidor': 'a.ntp.br', 'migracao.relogio.ntp_timeout_ms': 1500,
    'migracao.fuso_origem': 'America/Manaus', 'migracao.fuso.ambiguo': 'QUARANTINE', 'migracao.fuso.amostra_por_entidade': 500, 'migracao.paralelo.prazo_dias': 14,
    'migracao.dry3.janela_comparacao_min': 5, 'migracao.dry3.exemplos_no_relatorio': 0, 'migracao.dry3.dados_pessoais_em_claro': true, 'migracao.dry3.timeout_min': 60,
  };
  for (const [key, value] of Object.entries(good)) {
    await env.setParam(A, key, value);
    assert.equal(await read(key, null), value, key);
  }
});
