'use strict';

const { Op } = require('sequelize');
const { Person, PersonContact, PersonAddress } = require('../../models');
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
 * Match fraco (nome semelhante + endereço/data de nascimento, CRMX-010/seção 4 do Caderno):
 * "abre revisão; não mescla automaticamente" — diferente dos dois matches acima, NUNCA bloqueia
 * a criação (não lança erro, nem é afetado por `allowDuplicate`), só retorna candidatos de
 * revisão. Critério determinístico (não é fuzzy/fonético sofisticado): normaliza o nome
 * (lowercase, sem acento, sem pontuação) e compara por IGUALDADE do primeiro + último token,
 * combinado com (mesma data de nascimento/fundação OU mesmo endereço atual normalizado).
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

function normalizeNameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * nameFirstLastTokens — "nome semelhante" (seção 4) é tratado, de forma determinística, como o
 * mesmo PRIMEIRO + ÚLTIMO token do nome normalizado — cobre o caso comum (mesmo nome completo
 * digitado com abreviação/acento diferente) sem exigir uma biblioteca de distância fonética.
 */
function nameFirstLastTokens(name) {
  const tokens = normalizeNameKey(name).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  return `${tokens[0]}|${tokens[tokens.length - 1]}`;
}

function normalizeAddressKeyForPerson(address) {
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  const street = normalize(address?.street);
  const city = normalize(address?.city);
  if (!street || !city) return null;
  return `${street}|${normalize(address?.number)}|${city}`;
}

/**
 * findWeakDuplicateCandidates — match fraco isolado: NÃO bloqueia, NÃO é chamado
 * automaticamente por `createPerson` (que só usa forte/médio) — é oferecido como checagem de
 * revisão explícita (ex.: UI de cadastro consulta antes de confirmar, ou listagem periódica).
 * `personData` aceita `legalName`, `birthOrFoundationDate` e opcionalmente `addresses` (mesmo
 * formato de payload de criação — primeiro item é usado).
 */
async function findWeakDuplicateCandidates(personData, transaction) {
  const nameKey = nameFirstLastTokens(personData.legalName);
  if (!nameKey) return [];

  const birthDate = personData.birthOrFoundationDate || null;
  const address = Array.isArray(personData.addresses) ? personData.addresses[0] : null;
  const addressKey = address ? normalizeAddressKeyForPerson(address) : null;
  if (!birthDate && !addressKey) return [];

  const where = { status: { [Op.ne]: 'MERGED' } };
  if (personData.excludePersonId) where.id = { [Op.ne]: personData.excludePersonId };
  if (birthDate) where.birthOrFoundationDate = birthDate;

  const candidates = [];

  if (birthDate) {
    const byBirthDate = await Person.findAll({ where, transaction });
    for (const candidate of byBirthDate) {
      if (nameFirstLastTokens(candidate.legalName) === nameKey) {
        candidates.push({ personId: candidate.id, legalName: candidate.legalName, reason: 'NOME_E_DATA_NASCIMENTO_SEMELHANTES' });
      }
    }
  }

  if (addressKey) {
    const addressWhere = { ...where };
    delete addressWhere.birthOrFoundationDate;
    const personAddresses = await PersonAddress.findAll({ where: { isCurrent: true }, transaction });
    const matchingPersonIds = personAddresses
      .filter((a) => normalizeAddressKeyForPerson(a) === addressKey)
      .map((a) => a.personId);
    if (matchingPersonIds.length > 0) {
      const byAddress = await Person.findAll({
        where: { ...addressWhere, id: matchingPersonIds },
        transaction,
      });
      for (const candidate of byAddress) {
        if (nameFirstLastTokens(candidate.legalName) === nameKey && !candidates.some((c) => c.personId === candidate.id)) {
          candidates.push({ personId: candidate.id, legalName: candidate.legalName, reason: 'NOME_E_ENDERECO_SEMELHANTES' });
        }
      }
    }
  }

  return candidates;
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

module.exports = { findPotentialDuplicate, listPotentialDuplicatePairs, findWeakDuplicateCandidates };
