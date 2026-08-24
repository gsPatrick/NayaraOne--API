'use strict';

const { Person, PersonContact } = require('../../models');
const { onlyDigits } = require('./personDocumentFormat.service');

/**
 * findPotentialDuplicate — checa, dentro do tenant corrente (company_id resolvido via RLS),
 * se já existe uma Person com o mesmo documento (tax_id_normalized/CPF/CNPJ) OU o mesmo valor
 * de contato principal (email/telefone) informado em `personData`.
 *
 * Lógica de aplicação direta (DedupService.findPossibleDuplicates do Caderno) — NÃO é uma
 * entrada no Motor de Regras (sem rule_code do tipo REG-PES-XXX; a dedup de pessoas não usa o
 * motor de regras nomeado, diferente do módulo de Imóveis).
 *
 * Critérios de checagem (nesta ordem — primeiro hit vence):
 *   1. Match forte: `personData.taxIdNormalized` (normalizado para dígitos) contra
 *      `persons.tax_id_normalized` existente — bloqueia criação, retorna a pessoa existente.
 *   2. Match médio: cada item de `personData.contacts` com `isPrimary: true` (ou o único item,
 *      se só um contato for enviado) contra `person_contacts.value_normalized` de contatos
 *      primários existentes, no mesmo `contactType` — sinaliza/bloqueia criação por padrão
 *      (o service que chama esta função decide se bloqueia ou apenas avisa).
 *
 * Match fraco (nome semelhante + endereço/data de nascimento) fica para revisão manual futura —
 * não implementado aqui: exigiria um serviço de similaridade fonética/fuzzy fora do escopo
 * desta função de checagem de match forte/médio.
 *
 * Retorna a Person existente (instância Sequelize) ou `null` se nenhuma duplicata foi encontrada.
 */
async function findPotentialDuplicate(personData, transaction) {
  const taxIdDigits = onlyDigits(personData.taxIdNormalized);
  if (taxIdDigits) {
    const byTaxId = await Person.findOne({ where: { taxIdNormalized: taxIdDigits }, transaction });
    if (byTaxId) return byTaxId;
  }

  const contacts = Array.isArray(personData.contacts) ? personData.contacts : [];
  const explicitPrimary = contacts.filter((c) => c.isPrimary);
  const primaryContacts = explicitPrimary.length > 0 ? explicitPrimary : contacts.length === 1 ? contacts : [];

  for (const contact of primaryContacts) {
    const value = contact.valueNormalized || contact.value;
    if (!value || !contact.contactType && !contact.channel) continue;
    const contactType = String(contact.contactType || contact.channel).toUpperCase();
    const existingContact = await PersonContact.findOne({
      where: { contactType, valueNormalized: value, isPrimary: true },
      transaction,
    });
    if (existingContact) {
      const owner = await Person.findByPk(existingContact.personId, { transaction });
      if (owner) return owner;
    }
  }

  return null;
}

module.exports = { findPotentialDuplicate };
