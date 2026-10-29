'use strict';

const AppError = require('../../../utils/AppError');

/** Campos de config_json que dizem o que o provedor de IA aceita receber (M9-D011): só quem tem ai:admin os altera. */
const AI_ADMIN_FIELDS = Object.freeze(['allowsConfidential', 'allowsRestricted']);

const flag = (config, campo) => Boolean(config && config[campo] === true);

/**
 * Regras próprias da família AI na gravação de uma conexão (M9-D011), além do schema do fornecedor:
 *  - allowsRestricted=true exige data_retention=NONE (422 INTEGRATION_CONFIG_INVALID);
 *  - mudar allowsConfidential ou allowsRestricted exige a permissão ai:admin em `ctx.permissions` (403 AI_ADMIN_REQUIRED).
 * `antes` é o config_json atual (null na criação). A auditoria antes/depois é a do registro de integrações.
 */
function validarRegrasIA(provider, configJson, antes, ctx) {
  if (!provider || provider.domain !== 'AI') return;
  const novo = configJson || {};
  if (flag(novo, 'allowsRestricted') && novo.data_retention !== 'NONE') {
    throw AppError.unprocessable('Um provedor só pode receber dado restrito com retenção NONE.', 'INTEGRATION_CONFIG_INVALID', { problemas: ['allowsRestricted exige data_retention NONE'] });
  }
  const mudou = AI_ADMIN_FIELDS.some((campo) => flag(novo, campo) !== flag(antes, campo));
  if (mudou && !(Array.isArray(ctx && ctx.permissions) && ctx.permissions.includes('ai:admin'))) {
    throw AppError.forbidden('Só quem administra a NAY altera o que o provedor aceita receber.', 'AI_ADMIN_REQUIRED');
  }
}

/** Provedor real de IA (não sandbox) só fica ativo com a referência do segredo (400 AI_PROVIDER_NOT_CONFIGURED). */
function exigirSegredoParaAtivarIA(provider, connection) {
  if (!provider || provider.domain !== 'AI' || provider.sandboxAvailable === true) return;
  if (!connection.secretRef) throw AppError.badRequest('Informe a credencial do provedor antes de ativá-lo.', 'AI_PROVIDER_NOT_CONFIGURED');
}

module.exports = { validarRegrasIA, exigirSegredoParaAtivarIA, AI_ADMIN_FIELDS };
