'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');

const logger = require('../../../src/utils/logger');
const win = require('../../../src/features/users/mfa.testWindow');

const secret = authenticator.generateSecret();
const codeAt = (msAgo) => authenticator.clone({ epoch: Date.now() - msAgo }).generate(secret);
const MIN = 60 * 1000;
const LOCAL = { NODE_ENV: 'test', DISPOSABLE_DB: '1', MFA_TOTP_TEST_WINDOW_I_AM_LOCAL: '1', MFA_TOTP_TEST_WINDOW_MINUTES: '120' };

let erros;
beforeEach(() => {
  win.resetLogStateForTests();
  erros = [];
  logger.error = (...a) => erros.push(a);
  logger.warn = () => {};
});

test('sem a variável: comportamento de hoje (5 min atrás recusa, atual aceita)', () => {
  const env = { NODE_ENV: 'test', DISPOSABLE_DB: '1', MFA_TOTP_TEST_WINDOW_I_AM_LOCAL: '1' };
  assert.equal(win.resolveWindowSteps(env), 0);
  assert.equal(win.checkTotp(codeAt(0), secret, env), true);
  assert.equal(win.checkTotp(codeAt(5 * MIN), secret, env), false);
  assert.equal(erros.length, 0);
});

test('variável + banco descartável + não produção: 1 h aceita, 3 h recusa', () => {
  assert.equal(win.checkTotp(codeAt(60 * MIN), secret, LOCAL), true);
  assert.equal(win.checkTotp(codeAt(3 * 60 * MIN), secret, LOCAL), false);
  assert.equal(win.resolveWindowSteps({ ...LOCAL, MFA_TOTP_TEST_WINDOW_MINUTES: '1' }), 2);
});

test('o authenticator global não é mutado', () => {
  win.checkTotp(codeAt(0), secret, LOCAL);
  assert.equal(authenticator.check(codeAt(60 * MIN), secret), false);
});

test('sem banco descartável (ou sem declaração local): ignora e loga erro uma única vez', () => {
  for (const extra of [{ DISPOSABLE_DB: undefined }, { MFA_TOTP_TEST_WINDOW_I_AM_LOCAL: undefined }]) {
    win.resetLogStateForTests();
    erros.length = 0;
    const env = { ...LOCAL, ...extra };
    assert.equal(win.checkTotp(codeAt(60 * MIN), secret, env), false);
    assert.equal(win.checkTotp(codeAt(60 * MIN), secret, env), false);
    assert.equal(erros.length, 1);
    assert.match(erros[0][1], /MFA_TOTP_TEST_WINDOW ignorado: ambiente não descartável/);
  }
});

test('valor fora de 1..120 ou não inteiro é ignorado', () => {
  for (const v of ['0', '121', '1.5', 'abc', '-3']) {
    assert.equal(win.resolveWindowSteps({ ...LOCAL, MFA_TOTP_TEST_WINDOW_MINUTES: v }), 0, v);
  }
});

test('NODE_ENV=production com a variável: lança', () => {
  const env = { ...LOCAL, NODE_ENV: 'production' };
  assert.throws(() => win.resolveWindowSteps(env), /MFA_TOTP_TEST_WINDOW_MINUTES/);
  assert.throws(() => win.assertSafeForBoot(env), /produção/);
  assert.doesNotThrow(() => win.assertSafeForBoot({ NODE_ENV: 'production' }));
});

test('produção em qualquer grafia (NODE_ENV) com a variável: lança e ignora', () => {
  for (const v of ['Production', 'PRODUCTION', ' production', 'production ', 'production\n']) {
    const env = { ...LOCAL, NODE_ENV: v };
    assert.throws(() => win.resolveWindowSteps(env), /MFA_TOTP_TEST_WINDOW_MINUTES/, JSON.stringify(v));
    assert.throws(() => win.assertSafeForBoot(env), /produção/, JSON.stringify(v));
    assert.doesNotThrow(() => win.assertSafeForBoot({ NODE_ENV: v }));
  }
});

test('NODE_ENV não local (staging, homologacao, ausente, vazio): ignora e loga erro', () => {
  for (const v of ['staging', 'homologacao', undefined, '', '  ']) {
    win.resetLogStateForTests();
    erros.length = 0;
    const env = { ...LOCAL, NODE_ENV: v };
    assert.equal(win.resolveWindowSteps(env), 0, JSON.stringify(v));
    assert.equal(erros.length, 1, JSON.stringify(v));
  }
  assert.equal(win.resolveWindowSteps({ ...LOCAL, NODE_ENV: ' Development ' }), 240);
  assert.equal(win.resolveWindowSteps({ ...LOCAL, NODE_ENV: 'TEST' }), 240);
});

test('DEPLOY_ENVIRONMENT: production lança; staging ignora com erro', () => {
  assert.throws(() => win.resolveWindowSteps({ ...LOCAL, DEPLOY_ENVIRONMENT: 'production' }), /MFA_TOTP_TEST_WINDOW_MINUTES/);
  assert.throws(() => win.assertSafeForBoot({ ...LOCAL, DEPLOY_ENVIRONMENT: ' Production ' }), /produção/);
  assert.doesNotThrow(() => win.assertSafeForBoot({ NODE_ENV: 'test', DEPLOY_ENVIRONMENT: 'production' }));
  win.resetLogStateForTests();
  erros.length = 0;
  assert.equal(win.resolveWindowSteps({ ...LOCAL, DEPLOY_ENVIRONMENT: 'staging' }), 0);
  assert.equal(erros.length, 1);
});

test('MINUTES estrito: espaço, quebra de linha, notação e prefixos são inválidos', () => {
  for (const v of [' 60', '60 ', '60\n', '1e2', '0x10', '+5', '1_0', '010', '1000']) {
    win.resetLogStateForTests();
    erros.length = 0;
    assert.equal(win.resolveWindowSteps({ ...LOCAL, MFA_TOTP_TEST_WINDOW_MINUTES: v }), 0, JSON.stringify(v));
    assert.equal(erros.length, 1, JSON.stringify(v));
  }
  assert.equal(win.resolveWindowSteps({ ...LOCAL, MFA_TOTP_TEST_WINDOW_MINUTES: '60' }), 120);
});

test('boot fora de produção com variável incoerente: loga erro sem lançar', () => {
  assert.doesNotThrow(() => win.assertSafeForBoot({ NODE_ENV: 'test', MFA_TOTP_TEST_WINDOW_MINUTES: '60' }));
  assert.equal(erros.length, 1);
});
