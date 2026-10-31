'use strict';

const AppError = require('../../utils/AppError');

/**
 * Permissões da PLATAFORMA (Marco 9, M9-D200 R3-M2): valem para todas as empresas (catálogo global de fornecedores, hosts de saída, destino de token).
 * Nenhum papel de empresa pode recebê-las pela API: nem ao criar ou editar papel (roles), nem ao vincular um usuário a um papel que já as tenha (memberships).
 * A equipe da plataforma as concede por operação própria (fora da API de empresa). Para criar outra permissão de plataforma, basta acrescentar o código aqui.
 */
const PLATFORM_PERMISSION_CODES = Object.freeze(['integration:platform']);

const isPlatformPermission = (code) => PLATFORM_PERMISSION_CODES.includes(String(code));

const notAssignable = (codes) => AppError.forbidden(
  'Permissão de plataforma não pode ser atribuída a papel de empresa.', 'PLATFORM_PERMISSION_NOT_ASSIGNABLE', { permissions: [...codes] },
);

/** Recusa (403) se algum código for de plataforma. */
function assertNoPlatformPermission(codes) {
  const achados = [...new Set((codes || []).map(String))].filter(isPlatformPermission);
  if (achados.length) throw notAssignable(achados);
}

module.exports = { PLATFORM_PERMISSION_CODES, isPlatformPermission, assertNoPlatformPermission };
