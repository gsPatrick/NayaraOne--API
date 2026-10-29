'use strict';

// Apoio dos testes das ações do operador (M9-D250): HTTP real, MFA do usuário de teste (pelo serviço, nunca pela rota), erros de integração ligados ao alvo e
// um fornecedor de IA real sem credencial. Roda em banco descartável (os testes COMMITAM). Quem usa define process.env.PORT ANTES de requerer.
const { Sequelize } = require('sequelize');
const { authenticator } = require('otplib');
const base215 = require('./m9d215Env');
const http249 = require('./m9d249Env');
const mfaService = require('../../../src/features/users/mfa.service');
const errors = require('../../../src/features/integrations/errors');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');

let adminDb = null;
function admin() {
  if (!adminDb) {
    const url = process.env.DATABASE_ADMIN_URL;
    if (!url || !/@127\.0\.0\.1:/.test(url)) throw new Error('DATABASE_ADMIN_URL ausente ou fora de 127.0.0.1: rode via scripts/withDisposableDb.js.');
    adminDb = new Sequelize(url, { dialect: 'postgres', logging: false });
  }
  return adminDb;
}

/** MFA habilitado para o usuário de teste e verificado AGORA (pelo serviço de MFA). Se já estava habilitado, só renova a verificação. */
async function ativarMfa(tenant) {
  const { sequelize, comTenant } = base215;
  const tem = (await admin().query('SELECT 1 FROM core.mfa_credentials WHERE user_id = :u AND enabled = true', { replacements: { u: tenant.userId } }))[0].length > 0;
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
  if (!tem) {
    await comTenant(tenant, async (t) => {
      const { otpauthUri } = await mfaService.setupMfa(tenant.userId, ctx, t);
      const segredo = /[?&]secret=([^&]+)/.exec(otpauthUri)[1];
      await mfaService.confirmMfa(tenant.userId, authenticator.generate(segredo), ctx, t);
      tenant.mfaSecret = segredo;
    });
  } else if (!tenant.mfaSecret) {
    // Habilitado por outro arquivo de teste (outro processo): só ele conhece o segredo. Reinicia o MFA do usuário de teste neste banco descartável.
    await admin().query('DELETE FROM core.mfa_step_ups WHERE user_id = :u', { replacements: { u: tenant.userId } });
    await admin().query('DELETE FROM core.mfa_credentials WHERE user_id = :u', { replacements: { u: tenant.userId } });
    await admin().query('UPDATE core.users SET mfa_enabled = false, mfa_method = NULL WHERE id = :u', { replacements: { u: tenant.userId } });
    return ativarMfa(tenant);
  }
  await comTenant(tenant, (t) => mfaService.verifyMfa(tenant.userId, authenticator.generate(tenant.mfaSecret), ctx, t));
  return sequelize;
}

/** Vence a verificação MFA recente (o usuário continua com MFA habilitado). */
const vencerMfa = (tenant) => admin().query("UPDATE core.mfa_step_ups SET expires_at = now() - interval '1 minute' WHERE user_id = :u", { replacements: { u: tenant.userId } });

/** Erro de integração ligado ao alvo (envio, evento de webhook ou fluxo) pelo `source_ref_id`, como as fontes reais gravam. */
function erroDe(tenant, { providerCode, connectionId, source, refId, errorClass = 'UNKNOWN', errorCode, message = 'Falha de teste da M9-D250.' }) {
  const { comTenant, ctxDe } = base215;
  return comTenant(tenant, (t) => errors.recordError(ctxDe(tenant), { providerCode, connectionId, source, sourceRefId: refId, errorClass, errorCode, message }, t));
}

const erroLinha = (tenant, id) => base215.comTenant(tenant, async (t) => (await base215.sequelize.query('SELECT * FROM integration.integration_errors WHERE id = :id', { replacements: { id }, transaction: t }))[0][0]);

/** Auditoria de uma entidade por ação (ordem cronológica). */
const trilha = (tenant, entityId, action) => base215.auditoria(tenant, entityId, action);

const trocados = new Set();
/** Troca o adapter registrado do fornecedor por uma classe de teste; `restaurarAdaptadores` devolve os de fábrica. */
function instalarTemporario(Classe) {
  const code = new Classe(null).providerCode();
  trocados.add(code);
  adapterRegistry.unregister(code);
  adapterRegistry.register(Classe);
}
function restaurarAdaptadores() {
  trocados.forEach((code) => adapterRegistry.unregister(code));
  trocados.clear();
  return registerBuiltInAdapters();
}

module.exports = { ...base215, instalarTemporario, restaurarAdaptadores, ...http249, admin, ativarMfa, vencerMfa, erroDe, erroLinha, trilha };
