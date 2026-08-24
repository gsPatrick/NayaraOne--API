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

/**
 * listPotentialDuplicatePairs — versão "varredura" do mesmo critério de dedup acima, aplicada ao
 * tenant inteiro em vez de a um payload de criação. Serve a listagem de contatos, que sinaliza
 * cadastros suspeitos ("possível duplicata") e oferece o merge controlado (POST /people/:id/merge).
 *
 * Usa exclusivamente o **match médio** (critério 2 de findPotentialDuplicate): duas pessoas que
 * compartilham o mesmo contato primário (mesmo contact_type + value_normalized). O match forte
 * (mesmo tax_id_normalized) NÃO pode gerar par aqui: `UNIQUE(group_id, tax_id_normalized)` é uma
 * constraint do banco (TAB-0100), então duas pessoas com o mesmo CPF/CNPJ não conseguem coexistir.
 *
 * Pessoas já mescladas (status='MERGED') são ignoradas — o par já foi resolvido.
 *
 * Retorna: [{ contactType, value, personIds: [id, id, ...] }]
 */
async function listPotentialDuplicatePairs(transaction) {
  const contacts = await PersonContact.findAll({
    where: { isPrimary: true },
    transaction,
  });

  const byValue = new Map();
  for (const contact of contacts) {
    const key = `${contact.contactType}|${contact.valueNormalized}`;
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(contact);
  }

  const pairs = [];
  for (const [key, group] of byValue) {
    const personIds = [...new Set(group.map((c) => c.personId))];
    if (personIds.length < 2) continue;

    // Descarta os já mesclados antes de decidir se ainda sobra um par de verdade.
    const persons = await Person.findAll({ where: { id: personIds }, transaction });
    const openIds = persons.filter((p) => p.status !== 'MERGED').map((p) => p.id);
    if (openIds.length < 2) continue;

    const [contactType, value] = key.split('|');
    pairs.push({ contactType, value, personIds: openIds });
  }

  return pairs;
}

module.exports = { findPotentialDuplicate, listPotentialDuplicatePairs };
