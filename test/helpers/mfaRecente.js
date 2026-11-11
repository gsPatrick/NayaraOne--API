'use strict';

// MFA recente REAL pela camada de serviço (setupMfa -> confirmMfa -> verifyMfa com o código TOTP gerado do segredo), para os testes que gravam um parâmetro
// sensível (`requiresMfa` no SETTINGS_SCHEMA, src/features/settings/settingMfa.js). Nunca pela rota HTTP de MFA e nunca com token forjado (COMO_RETOMAR §3).
// Dentro da transação do teste: com rollback, o estado do usuário volta ao que era; num teste que commita, o usuário fica com MFA habilitado (como os
// testes que provam "MFA exigido" já esperam: eles mesmos tiram o MFA do usuário antes, ver test/marco9/_helpers/semMfa.js).
const { authenticator } = require('otplib');
const mfaService = require('../../src/features/users/mfa.service');
const { MfaCredential, MfaStepUp, User } = require('../../src/models');

/** Tira o MFA do usuário (credencial e verificação recente) dentro da transação. */
async function semMfa(userId, transaction) {
  await MfaStepUp.destroy({ where: { userId }, transaction });
  await MfaCredential.destroy({ where: { userId }, force: true, transaction });
  await User.update({ mfaEnabled: false, mfaMethod: null }, { where: { id: userId }, transaction });
}

/** Habilita o MFA do usuário do zero e abre a janela de MFA recente com um código TOTP válido. Devolve o segredo (para verificar de novo). */
async function comMfaRecente(userId, ctx, transaction) {
  await semMfa(userId, transaction);
  const tenant = { groupId: ctx.groupId, companyId: ctx.companyId };
  const { otpauthUri } = await mfaService.setupMfa(userId, tenant, transaction);
  const secret = new URL(otpauthUri).searchParams.get('secret');
  await mfaService.confirmMfa(userId, authenticator.generate(secret), tenant, transaction);
  await mfaService.verifyMfa(userId, authenticator.generate(secret), tenant, transaction);
  return secret;
}

/** MFA habilitado, mas sem verificação recente (a janela venceu). */
async function mfaVencido(userId, transaction) {
  await MfaStepUp.update({ expiresAt: new Date(Date.now() - 60 * 1000) }, { where: { userId }, transaction });
}

/**
 * Grava um parâmetro sensível (requiresMfa) como faria um administrador com MFA recente: um operador NOVO do teste (não o usuário do seed, para não mudar
 * o estado de MFA de quem as outras baterias usam) com MFA real verificado agora, na mesma transação. Para os testes que não são sobre MFA e só precisam
 * do parâmetro gravado (ex.: desligar o MFA de produção das provas do registro de integrações).
 */
async function gravarParametroSensivel(key, value, tenant, transaction, options = {}) {
  const operador = await User.create({ email: `operador-parametros-${Date.now()}${Math.floor(Math.random() * 1e6)}@nayaraone.dev`, name: 'Operador de parâmetros (teste)', passwordHash: 'x', status: 'ACTIVE' }, { transaction });
  await comMfaRecente(operador.id, tenant, transaction);
  const { upsertSetting } = require('../../src/features/settings/settings.service');
  return upsertSetting(key, value, { groupId: tenant.groupId, companyId: tenant.companyId }, operador.id, transaction, options);
}

/** Grava qualquer parâmetro pelo serviço: o sensível (requiresMfa) por um operador com MFA recente real, o comum pelo usuário do tenant (como antes). */
async function gravarParametro(key, value, tenant, transaction, options = {}) {
  const { SETTINGS_SCHEMA, upsertSetting } = require('../../src/features/settings/settings.service');
  if (SETTINGS_SCHEMA[key] && SETTINGS_SCHEMA[key].requiresMfa === true) return gravarParametroSensivel(key, value, tenant, transaction, options);
  return upsertSetting(key, value, tenant, tenant.userId, transaction, options);
}

module.exports = { semMfa, comMfaRecente, mfaVencido, gravarParametroSensivel, gravarParametro };
