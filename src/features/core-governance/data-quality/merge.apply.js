'use strict';

const { mergePersons } = require('../../people/personMerge.service');
const { mergeProperties } = require('../../properties/propertyMerge.service');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const references = require('./merge.references');
const { resolveConflicts } = require('./merge.conflicts');

/**
 * Papéis que o absorvido tem e o sobrevivente já tem (a chave de person_roles é pessoa + papel + empresa, então o serviço de união não consegue
 * movê-los): a linha repetida do absorvido é encerrada (deleted_at), nunca apagada; os papéis que só o absorvido tem seguem para o sobrevivente.
 */
async function retireSharedRoles(survivorId, otherId, actorUserId, transaction) {
  await sequelize.query(
    `UPDATE people.person_roles o SET deleted_at = now(), deleted_by = :actorUserId
      WHERE o.person_id = :otherId AND o.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM people.person_roles s WHERE s.person_id = :survivorId AND s.role_code = o.role_code AND s.company_id = o.company_id)`,
    { type: QueryTypes.UPDATE, transaction, replacements: { survivorId, otherId, actorUserId } }
  );
}

/**
 * Efeito do MERGED (M9-D805 §3.4), na transação da decisão: conflitos de campo crítico pela escolha do steward e pelo guard da M9-D807; união pelo
 * serviço do módulo (pessoa e fornecedor: mergePersons; imóvel: mergeProperties), que reaponta as suas tabelas, marca o absorvido como unido
 * (merged_into) e registra o evento e a auditoria com o mapa de referências; por fim o que sobrou (references.remapLeftovers). Nunca apaga.
 * Devolve { choices, moved }.
 */
async function applyMerge(entityType, survivor, other, input, ctx) {
  const resolution = await resolveConflicts(entityType, survivor, other, input, ctx);
  await resolution.apply();
  if (entityType !== 'PROPERTY') await retireSharedRoles(survivor.id, other.id, ctx.actorUserId, ctx.transaction);
  const done = entityType === 'PROPERTY'
    ? await mergeProperties(survivor.id, other.id, ctx.actorUserId, ctx.transaction)
    : await mergePersons(survivor.id, other.id, ctx.actorUserId, ctx.transaction);
  const moved = await references.remapLeftovers(entityType, survivor.id, other.id, ctx.transaction);
  return { choices: resolution.choices, moved, remappedByModule: done.remappedReferences || {} };
}

module.exports = { applyMerge };
