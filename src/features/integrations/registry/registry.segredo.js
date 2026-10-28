'use strict';

const AppError = require('../../../utils/AppError');
const { getSetting } = require('../../settings/settings.service');
const { acharSegredo, chaveParecidaComSegredo, textoParecidoComSegredoEmbutido, TAMANHO_MINIMO_PADRAO } = require('./secretScan');
const { CAMPOS_CONEXAO_EDITAVEIS } = require('./registry.constants');

/** Recusa de segredo em configuração (M9-D202): nenhum segredo entra no registro. */

async function tamanhoMinimoDeSegredo(ctx, transaction) {
  const valor = await getSetting('integration.registry.secret_scan_min_length', ctx, transaction, TAMANHO_MINIMO_PADRAO);
  return Number.isInteger(valor) ? valor : TAMANHO_MINIMO_PADRAO;
}

function recusarSegredo() {
  return AppError.unprocessable(
    'O segredo não entra na configuração. Informe somente a referência do cofre em "secretRef".',
    'INTEGRATION_SECRET_IN_CONFIG'
  );
}

async function conferirSemSegredo(payload, ctx, transaction) {
  const tamanhoMinimo = await tamanhoMinimoDeSegredo(ctx, transaction);
  for (const campo of ['configJson', 'policyJson']) {
    if (payload[campo] === undefined) continue;
    if (payload[campo] === null || typeof payload[campo] !== 'object' || Array.isArray(payload[campo])) {
      throw AppError.badRequest(`O campo "${campo}" deve ser um objeto.`, 'VALIDATION_ERROR');
    }
    if (acharSegredo(payload[campo], { tamanhoMinimo })) throw recusarSegredo();
  }
  // Campo de segredo solto no corpo (apiKey, token...), fora dos campos conhecidos.
  for (const [chave, valor] of Object.entries(payload)) {
    if (CAMPOS_CONEXAO_EDITAVEIS.includes(chave) || chave === 'providerCode' || chave === 'environment' || chave === 'status') continue;
    if (chaveParecidaComSegredo(chave) && valor !== undefined && valor !== null && String(valor) !== '') throw recusarSegredo();
  }
  if (payload.secretRef !== undefined && payload.secretRef !== null && textoParecidoComSegredoEmbutido(payload.secretRef)) throw recusarSegredo();
}

module.exports = { recusarSegredo, conferirSemSegredo };
