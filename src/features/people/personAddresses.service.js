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

  // FIX (homologação 23/09/2026 — auditoria adversarial): o UPDATE acima (isCurrent=false WHERE
  // isCurrent=true) só protege quando JÁ existe uma linha atual pra travar — se essa é a
  // primeira criação de endereço da pessoa (nada pra desmarcar), duas criações concorrentes
  // inserem duas linhas isCurrent=true ao mesmo tempo, sem nenhum lock em memória capaz de
  // impedir isso. Corrigido com constraint única parcial no banco (migration
  // 20260101000174-add-unique-current-address-per-person) — se disparar (corrida real, janela
  // mínima), converte pro mesmo formato de erro de negócio do resto do projeto.
  try {
    return await PersonAddress.create(
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
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Já existe um endereço atual sendo criado para esta pessoa ao mesmo tempo (corrida concorrente detectada) — tente novamente.',
        'PERSON_ADDRESS_CURRENT_RACE'
      );
    }
    throw err;
  }
}

async function listAddresses(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return PersonAddress.findAll({ where: { personId }, order: [['created_at', 'DESC']], transaction });
}

module.exports = { createAddress, listAddresses };
