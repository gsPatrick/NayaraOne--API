'use strict';

const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { ENVIRONMENTS } = require('./registry.constants');

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) {
    throw AppError.badRequest('Contexto da empresa é obrigatório.', 'VALIDATION_ERROR');
  }
}

/** O ambiente vem da configuração do servidor, nunca do pedido do usuário (D200 3.3). */
function getServerEnvironment(env = process.env) {
  const explicito = env.INTEGRATION_ENVIRONMENT;
  if (explicito) {
    const valor = String(explicito).trim().toUpperCase();
    if (!ENVIRONMENTS.includes(valor)) {
      throw AppError.internal(`INTEGRATION_ENVIRONMENT inválido no servidor. Use: ${ENVIRONMENTS.join(', ')}.`, 'INTEGRATION_ENVIRONMENT_INVALID');
    }
    return valor;
  }
  if (env.DEPLOY_ENVIRONMENT === 'staging') return 'HOMOLOG';
  if (env.DEPLOY_ENVIRONMENT === 'production' || env.NODE_ENV === 'production') return 'PRODUCTION';
  return 'SANDBOX';
}

function texto(valor, nome, max, { obrigatorio = false } = {}) {
  const t = String(valor ?? '').trim();
  if (!t) {
    if (obrigatorio) throw AppError.badRequest(`Informe o campo "${nome}".`, 'VALIDATION_ERROR');
    return null;
  }
  if (t.length > max) throw AppError.badRequest(`O campo "${nome}" deve ter até ${max} caracteres.`, 'VALIDATION_ERROR');
  return t;
}

async function comPlataforma(transaction) {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction });
}

module.exports = { ctxOk, getServerEnvironment, texto, comPlataforma };
