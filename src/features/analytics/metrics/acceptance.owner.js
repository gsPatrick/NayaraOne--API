'use strict';

/**
 * M9-D708 (3.4) — quem é o owner de uma métrica. O owner da definição é um papel (`owner_role`, parâmetro analytics.owner.<código>): vale para os usuários
 * ATIVOS da empresa que têm esse papel. O texto do parâmetro pode vir como "Diretoria Financeira (papel financeiro-gestor)"; o papel é reconhecido pelo texto
 * inteiro, pelo nome do papel entre parênteses ("financeiro-gestor") ou pelo nome da área antes dos parênteses ("Diretoria Financeira"), sem diferenciar maiúsculas.
 * Leitura de core.user_memberships/core.roles pelo mesmo caminho dos alertas (owner.members), sob a RLS da empresa.
 */
const { activeUsersOfRole } = require('../alerts/owner.members');

/** Nomes de papel que o texto do owner pode designar, do mais específico ao mais geral. */
function roleNamesOf(ownerRole) {
  if (typeof ownerRole !== 'string' || !ownerRole.trim()) return [];
  const text = ownerRole.trim();
  const names = [text];
  const inParens = /\(\s*papel\s+([^)]+?)\s*\)/i.exec(text);
  if (inParens) names.push(inParens[1]);
  const before = text.replace(/\(.*\)\s*$/, '').trim();
  if (before && before !== text) names.push(before);
  return [...new Set(names)];
}

/** Ids dos usuários ativos da empresa que ocupam o papel de owner da métrica. */
async function ownerUserIds(definition, companyId, transaction) {
  const ids = new Set();
  for (const name of roleNamesOf(definition.owner_role)) {
    for (const id of await activeUsersOfRole(name, companyId, transaction)) ids.add(id);
  }
  return [...ids].sort();
}

async function isOwner(definition, userId, companyId, transaction) {
  return (await ownerUserIds(definition, companyId, transaction)).includes(userId);
}

module.exports = { roleNamesOf, ownerUserIds, isOwner };
