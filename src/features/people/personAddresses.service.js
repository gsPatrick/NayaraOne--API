'use strict';

const { PersonAddress, Person } = require('../../models');
const AppError = require('../../utils/AppError');

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

/**
 * createAddress — cria um novo endereço para a pessoa. Se `isCurrent` (default true), marca
 * qualquer endereço atual anterior como histórico (is_current=false, valid_until=hoje),
 * implementando o versionamento simples: só um endereço "atual" por pessoa.
 */
async function createAddress(personId, payload, actorUserId, transaction) {
  const person = await assertPersonExists(personId, transaction);
  const isCurrent = payload.isCurrent !== undefined ? !!payload.isCurrent : true;

  if (isCurrent) {
    await PersonAddress.update(
      { isCurrent: false, validUntil: payload.validFrom || new Date().toISOString().slice(0, 10) },
      { where: { personId, isCurrent: true }, transaction }
    );
  }

  return PersonAddress.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      personId,
      zipCode: payload.zipCode || null,
      street: payload.street || null,
      number: payload.number || null,
      complement: payload.complement || null,
      neighborhood: payload.neighborhood || null,
      city: payload.city || null,
      state: payload.state || null,
      isCurrent,
      validFrom: payload.validFrom || null,
      validUntil: payload.validUntil || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listAddresses(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return PersonAddress.findAll({ where: { personId }, order: [['created_at', 'DESC']], transaction });
}

module.exports = { createAddress, listAddresses };
