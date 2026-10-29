'use strict';

const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { readDefaultCountryCode } = require('./suppression.settings');

/** Telefone sem "+" e com até 11 dígitos recebe o código do país padrão (parâmetro do administrador). */
const NATIONAL_MAX_DIGITS = 11;

/** E-mail em minúsculas; telefone/WhatsApp em E.164 (+<país><número>). Devolve null se não houver endereço utilizável. */
function normalizeAddress(channel, value, countryCode) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return null;
  if (String(channel).toUpperCase() === 'EMAIL') return text.includes('@') ? text.toLowerCase() : null;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const withCountry = text.startsWith('+') || digits.length > NATIONAL_MAX_DIGITS ? digits : `${countryCode}${digits}`;
  return `+${withCountry}`;
}

/** sha256 em hexadecimal do endereço normalizado: é o único formato guardado na lista de supressão. */
const hashAddress = (normalized) => crypto.createHash('sha256').update(normalized).digest('hex');

const CONTACT_TYPES_BY_CHANNEL = Object.freeze({ WHATSAPP: ['WHATSAPP', 'PHONE'], EMAIL: ['EMAIL'], SMS: ['PHONE'] });

/** Endereços (já com hash) que a pessoa tem para o canal, o principal primeiro. */
async function resolvePersonAddresses(personId, channel, tenant, transaction) {
  const types = CONTACT_TYPES_BY_CHANNEL[String(channel).toUpperCase()] || [String(channel).toUpperCase()];
  const rows = await sequelize.query(
    `SELECT value_normalized FROM people.person_contacts
      WHERE company_id = :companyId AND person_id = :personId AND contact_type IN (:types) AND deleted_at IS NULL
      ORDER BY is_primary DESC, created_at ASC`,
    { replacements: { companyId: tenant.companyId, personId, types }, type: QueryTypes.SELECT, transaction }
  );
  const country = await readDefaultCountryCode(tenant, transaction);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const normalized = normalizeAddress(channel, row.value_normalized, country);
    if (normalized && !seen.has(normalized)) { seen.add(normalized); out.push({ hash: hashAddress(normalized) }); }
  }
  return out;
}

/** Pessoas da empresa cujo endereço tem este hash no canal (para cancelar o que está agendado para quem pediu para sair). */
async function personsOfAddressHash(addressHash, channel, tenant, transaction) {
  const types = CONTACT_TYPES_BY_CHANNEL[String(channel).toUpperCase()] || [String(channel).toUpperCase()];
  const rows = await sequelize.query(
    `SELECT person_id, value_normalized FROM people.person_contacts
      WHERE company_id = :companyId AND contact_type IN (:types) AND deleted_at IS NULL`,
    { replacements: { companyId: tenant.companyId, types }, type: QueryTypes.SELECT, transaction }
  );
  const country = await readDefaultCountryCode(tenant, transaction);
  const persons = new Set();
  for (const row of rows) {
    const normalized = normalizeAddress(channel, row.value_normalized, country);
    if (normalized && hashAddress(normalized) === addressHash) persons.add(row.person_id);
  }
  return [...persons];
}

module.exports = { normalizeAddress, hashAddress, resolvePersonAddresses, personsOfAddressHash };
