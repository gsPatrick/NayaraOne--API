'use strict';

/**
 * Janela de tolerância do TOTP para CAPTURA LOCAL (DI-MFA-TESTE-1).
 *
 * Pedido do Patrick: para tirar prints e fazer testes de tela localmente, o código TOTP precisa
 * valer por até 2 horas. Fora disso o comportamento é EXATAMENTE o de sempre (código de 30 s,
 * janela padrão da biblioteca, `authenticator` global intocado).
 *
 * A janela ampliada só liga quando TODAS as condições são verdadeiras:
 *  (a) MFA_TOTP_TEST_WINDOW_MINUTES é um inteiro de 1 a 120;
 *  (b) NODE_ENV não é 'production';
 *  (c) o processo roda sobre banco descartável (DISPOSABLE_DB=1, marcado por scripts/withDisposableDb.js);
 *  (d) MFA_TOTP_TEST_WINDOW_I_AM_LOCAL=1.
 * Definida a variável mas falhando (b)-(d) ou (a), o valor é IGNORADO e um erro é registrado uma vez.
 * Em NODE_ENV=production, definir a variável derruba o boot (throw).
 */
const { authenticator } = require('otplib');
const logger = require('../../utils/logger');

const VAR = 'MFA_TOTP_TEST_WINDOW_MINUTES';
const STEP_SECONDS = 30;
const MAX_MINUTES = 120;

let ignoredLogged = false;
let activeLogged = false;

function isDefined(env) {
  return env[VAR] !== undefined && String(env[VAR]).trim() !== '';
}

/** Falha alto no boot de produção se a variável estiver definida. */
function assertSafeForBoot(env = process.env) {
  if (env.NODE_ENV === 'production' && isDefined(env)) {
    throw new Error(`${VAR} está definida em NODE_ENV=production: remova a variável (uso só para captura local em banco descartável).`);
  }
}

/** Devolve a janela em passos de 30 s (0 = padrão da biblioteca, sem mudança de comportamento). */
function resolveWindowSteps(env = process.env) {
  assertSafeForBoot(env);
  if (!isDefined(env)) return 0;

  const raw = String(env[VAR]).trim();
  const minutes = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const valueOk = Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MINUTES;
  const disposable = env.DISPOSABLE_DB === '1';
  const local = env.MFA_TOTP_TEST_WINDOW_I_AM_LOCAL === '1';

  if (!valueOk || !disposable || !local) {
    if (!ignoredLogged) {
      ignoredLogged = true;
      logger.error({ valorValido: valueOk, bancoDescartavel: disposable, declaradoLocal: local }, 'MFA_TOTP_TEST_WINDOW ignorado: ambiente não descartável');
    }
    return 0;
  }

  if (!activeLogged) {
    activeLogged = true;
    logger.warn({ minutos: minutes }, `MFA_TOTP_TEST_WINDOW ATIVO: códigos TOTP valem ±${minutes} min (só captura local em banco descartável)`);
  }
  return Math.ceil((minutes * 60) / STEP_SECONDS);
}

/** Verifica o TOTP com a janela resolvida; sem a variável é idêntico a `authenticator.check`. */
function checkTotp(code, secret, env = process.env) {
  const steps = resolveWindowSteps(env);
  if (steps === 0) return authenticator.check(code, secret);
  return authenticator.clone({ window: steps }).check(code, secret);
}

function resetLogStateForTests() {
  ignoredLogged = false;
  activeLogged = false;
}

module.exports = { checkTotp, resolveWindowSteps, assertSafeForBoot, resetLogStateForTests, VAR };
