'use strict';

/**
 * Permissões com que o ator busca no índice do RAG (M9-D041). A identidade de serviço de um canal é só de leitura e não pode ter `ai:use`
 * (conversar); o conhecimento homologado exige `ai:use`. Para o ator SERVICE, `ai:read` vale como a leitura do conhecimento: o mesmo
 * direito de leitura, sem nenhuma permissão a mais. Para pessoas nada muda.
 */
function ragPermissions(permissions, actorType) {
  const lista = [...(permissions || [])];
  if (actorType === 'SERVICE' && lista.includes('ai:read') && !lista.includes('ai:use')) lista.push('ai:use');
  return lista;
}

module.exports = { ragPermissions };
