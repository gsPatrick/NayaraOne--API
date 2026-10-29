'use strict';

/**
 * Identidade de serviço só de leitura (AI-004). A ação de uma permissão é o último trecho do código (`finance:read`) ou, nos
 * escopos `read:own` e `read:all`, o trecho anterior ao escopo. Só read, view e list entram; a mesma regra está na CHECK
 * `service_identities_read_only_chk` do banco (função ai.permissions_are_read_only).
 */
const READ_ACTIONS = Object.freeze(['read', 'view', 'list']);
const SCOPE_SUFFIX = /:(own|all)$/;
const CODE_FORMAT = /^[a-z][a-z0-9_]*(:[a-zA-Z0-9_]+)+$/;
const MAX_PERMISSIONS = 200;

function permissionAction(code) {
  const semEscopo = code.replace(SCOPE_SUFFIX, '');
  return semEscopo.slice(semEscopo.lastIndexOf(':') + 1);
}

const isReadOnlyPermission = (code) => typeof code === 'string' && CODE_FORMAT.test(code) && READ_ACTIONS.includes(permissionAction(code));

module.exports = { READ_ACTIONS, MAX_PERMISSIONS, isReadOnlyPermission };
