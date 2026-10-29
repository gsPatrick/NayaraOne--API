'use strict';

// M9-D800 — Alicerce da governança (rotas HTTP, módulos por empresa e exceções ao prefixo GOV_).
// Rodar SEMPRE em banco descartável (nunca no .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d800.http.test.js"
// Os testes que dependem do cluster descartável (DISPOSABLE_DB=1) ou do seed de dois tenants são PULADOS com motivo explícito
// fora dele; os estáticos rodam em qualquer lugar.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  setupEnv, teardownEnv, API_ROOT, EXPECTED_MODULES, adminQuery, call,
} = require('./helpers/m9d800Env');

let sequelize;
let httpSkip;

before(async () => {
  ({ sequelize, httpSkip } = await setupEnv());
});

after(async () => {
  await teardownEnv();
});


test('m9d800 rota sem permissão devolve 403 (e 401 sem login, 200 com a permissão)', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const semToken = await call(null, 'GET', '/calendar');
  assert.equal(semToken.status, 401);
  assert.equal(semToken.body.success, false);
  assert.equal(semToken.body.error.code, 'MISSING_ACCESS_TOKEN');
  assert.equal(semToken.body.error.message, 'Token de acesso ausente.');
  assert.equal(semToken.body.error.traceId, semToken.correlation, 'traceId DENTRO de error, igual ao X-Correlation-Id');
  assert.equal(semToken.body.traceId, undefined, 'nunca traceId na raiz');

  const semPermissao = await call('A:leitura', 'GET', '/calendar');
  assert.equal(semPermissao.status, 403);
  assert.equal(semPermissao.body.error.code, 'PERMISSION_DENIED');
  assert.equal(semPermissao.body.error.details.required, 'governance:calendar:read');
  assert.equal(semPermissao.body.error.traceId, semPermissao.correlation);

  const comPermissao = await call('A:gestor', 'GET', '/calendar');
  assert.equal(comPermissao.status, 200, JSON.stringify(comPermissao.body));
  assert.equal(comPermissao.body.success, true);
  // M9-D801 trocou o corpo do alicerce pela lista real do calendário (itens + paginação).
  assert.ok(Array.isArray(comPermissao.body.data));
  assert.equal(comPermissao.body.pagination.page, 1);

  // Rota de outro módulo exige a permissão dele: o gestor de CI não tem flags:manage.
  const flags = await call('A:gestor', 'GET', '/feature-flags');
  assert.equal(flags.status, 403);
  assert.equal(flags.body.error.details.required, 'governance:flags:manage');
  // O mesmo gestor tem finops:read (concedido no before) e vê o health do FinOps.
  const finops = await call('A:gestor', 'GET', '/finops/health');
  assert.equal(finops.status, 200);
  // As 8 rotas do esqueleto existem sob os prefixos do livro.
  for (const route of ['/data-quality', '/data-lineage', '/dlp', '/bcp', '/api-governance/consumers', '/feature-flags']) {
    const r = await call('A:leitura', 'GET', route);
    assert.equal(r.status, 403, `${route} deve exigir permissão`);
    assert.equal(r.body.error.traceId, r.correlation);
  }
});

test('m9d800 o administrador liga e desliga cada módulo (configuração por empresa)', async (t) => {
  if (httpSkip) return t.skip(httpSkip);
  const { upsertSetting } = require('../src/features/settings/settings.service');
  const { rows: [company] } = await adminQuery("SELECT c.id, c.group_id FROM core.companies c WHERE c.name LIKE 'CI%Empresa Fictícia A%'");
  const tenant = { groupId: company.group_id, companyId: company.id };
  const { rows: [user] } = await adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-gestor@ci.nayaraone.test'");
  const withTenant = (fn) => sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: tenant.groupId, c: tenant.companyId, u: user.id }, transaction: t });
    return fn(t);
  });
  await withTenant((t) => upsertSetting('governanca.modulos.calendar.habilitado', false, tenant, user.id, t));
  try {
    const off = await call('A:gestor', 'GET', '/calendar');
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, 'GOV_MODULE_DISABLED');
    assert.equal(off.body.error.traceId, off.correlation);
    // Só vale para a empresa que desligou: a empresa B (se tiver a permissão) não é afetada; sem permissão continua 403 por permissão.
    const semPermissaoPrimeiro = await call('A:leitura', 'GET', '/calendar');
    assert.equal(semPermissaoPrimeiro.body.error.code, 'PERMISSION_DENIED', 'a permissão é checada antes do módulo ligado');
  } finally {
    await withTenant((t) => upsertSetting('governanca.modulos.calendar.habilitado', true, tenant, user.id, t));
  }
  const on = await call('A:gestor', 'GET', '/calendar');
  assert.equal(on.status, 200);
  // Chave desconhecida continua recusada (fail closed) e as chaves novas têm faixa/tipo.
  await assert.rejects(() => withTenant((t) => upsertSetting('governanca.modulos.calendar.habilitado', 'sim', tenant, user.id, t)), /booleano/);
  await assert.rejects(() => withTenant((t) => upsertSetting('governanca.modulos.inexistente.habilitado', true, tenant, user.id, t)), /desconhecida/);
});

test('m9d800 a lista de exceções ao prefixo GOV_ configurada pelo administrador vale de fato', async (t) => {
  // Parte pura (sem banco): o enforcement troca código fora do padrão e respeita a lista recebida.
  const errors = require('../src/features/core-governance/governance.errors');
  assert.equal(typeof errors.enforceErrorCode, 'function', 'a lista configurável precisa de consumidor (enforceErrorCode)');
  const only = errors.parseExceptions('MFA_STEP_UP_REQUIRED, ');
  assert.deepEqual(only, ['MFA_STEP_UP_REQUIRED']);
  const trocado = errors.enforceErrorCode({ code: 'PERMISSION_DENIED', message: 'x', details: { required: 'a' } }, only);
  assert.equal(trocado.code, 'GOV_CODIGO_FORA_DO_PADRAO');
  assert.equal(trocado.details.codigoOriginal, 'PERMISSION_DENIED');
  assert.equal(trocado.details.required, 'a');
  assert.equal(errors.enforceErrorCode({ code: 'PERMISSION_DENIED' }, errors.DEFAULT_PREFIX_EXCEPTIONS).code, 'PERMISSION_DENIED');
  assert.equal(errors.enforceErrorCode({ code: 'GOV_NOT_FOUND' }, only).code, 'GOV_NOT_FOUND');

  if (httpSkip) return t.skip(httpSkip);
  const { upsertSetting } = require('../src/features/settings/settings.service');
  const { rows: [company] } = await adminQuery("SELECT c.id, c.group_id FROM core.companies c WHERE c.name LIKE 'CI%Empresa Fictícia A%'");
  const tenant = { groupId: company.group_id, companyId: company.id };
  const { rows: [user] } = await adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-gestor@ci.nayaraone.test'");
  const withTenant = (fn) => sequelize.transaction(async (tx) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", { replacements: { g: tenant.groupId, c: tenant.companyId, u: user.id }, transaction: tx });
    return fn(tx);
  });
  const antes = await call('A:leitura', 'GET', '/calendar');
  assert.equal(antes.body.error.code, 'PERMISSION_DENIED', 'padrão do livro: PERMISSION_DENIED é exceção permitida');
  await withTenant((tx) => upsertSetting('governanca.erros.excecoes_prefixo_gov', 'MISSING_ACCESS_TOKEN', tenant, user.id, tx));
  try {
    const depois = await call('A:leitura', 'GET', '/calendar');
    assert.equal(depois.status, 403, 'o status HTTP não muda');
    assert.equal(depois.body.error.code, 'GOV_CODIGO_FORA_DO_PADRAO');
    assert.equal(depois.body.error.details.codigoOriginal, 'PERMISSION_DENIED');
    assert.equal(depois.body.error.traceId, depois.correlation);
    // A configuração é por empresa: a empresa B continua com o padrão.
    const outra = await call('B:gestor', 'GET', '/feature-flags');
    assert.equal(outra.body.error.code, 'PERMISSION_DENIED');
  } finally {
    await withTenant((tx) => upsertSetting('governanca.erros.excecoes_prefixo_gov', 'PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR', tenant, user.id, tx));
  }
  const restaurado = await call('A:leitura', 'GET', '/calendar');
  assert.equal(restaurado.body.error.code, 'PERMISSION_DENIED');
});

test('m9d800 configurações de governança registradas no dicionário com os padrões do catálogo', () => {
  const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
  const gov = require('../src/features/core-governance/governance.settings');
  assert.equal(SETTINGS_SCHEMA['governanca.erros.excecoes_prefixo_gov'].type, 'string');
  assert.equal(gov.GOVERNANCE_SETTING_DEFAULTS['governanca.erros.excecoes_prefixo_gov'], 'PERMISSION_DENIED, MISSING_ACCESS_TOKEN, MFA_STEP_UP_REQUIRED, MFA_REQUIRED_NOT_ENABLED, INTERNAL_ERROR, VALIDATION_ERROR');
  for (const mod of EXPECTED_MODULES) {
    const key = `governanca.modulos.${mod.replace(/-/g, '_')}.habilitado`;
    assert.equal(SETTINGS_SCHEMA[key].type, 'boolean', key);
    assert.equal(gov.GOVERNANCE_SETTING_DEFAULTS[key], true, key);
  }
  for (const key of ['governanca.permissoes.perfis_gestao', 'governanca.permissoes.perfis_financeiro']) assert.equal(SETTINGS_SCHEMA[key].type, 'string', key);
  // Todo parâmetro do dicionário de governança consta no catálogo de parâmetros (parametros.csv).
  const csv = fs.readFileSync(path.join(API_ROOT, '..', 'Maturacao', 'demandas', 'parametros.csv'), 'utf8');
  for (const key of Object.keys(gov.GOVERNANCE_SETTING_DEFAULTS)) assert.ok(csv.includes(`"${key}"`), `${key} ausente de parametros.csv`);
});
