'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { readDefaultCountryCode } = require('./suppression.settings');

/**
 * M9-D419 regra 3 — "público alcançável" de uma campanha: nunca inclui quem está suprimido nem quem pediu para sair. Só contagens
 * (nenhuma lista de pessoas sai daqui). Por canal da campanha, cada pessoa do público congelado é classificada: REACHABLE, SUPPRESSED
 * (supressão ativa por pessoa ou por endereço), OPT_OUT (consentimento mais recente da finalidade do público ou geral é OPT_OUT) ou
 * NO_ADDRESS. A pessoa é alcançável se for em ALGUM canal; senão vale a classe do primeiro canal.
 */
const CONTACT_TYPES = Object.freeze({ WHATSAPP: ['WHATSAPP', 'PHONE'], EMAIL: ['EMAIL'], SMS: ['PHONE'] });

// Hash do endereço igual ao de address.js (e-mail em minúsculas; telefone em E.164 com o código do país padrão).
const ADDRESS_HASH_SQL = `encode(sha256(convert_to(CASE
    WHEN :isEmail THEN CASE WHEN position('@' in c.value_normalized) > 0 THEN lower(btrim(c.value_normalized)) END
    WHEN length(regexp_replace(c.value_normalized, '\\D', '', 'g')) < 8 THEN NULL
    WHEN btrim(c.value_normalized) LIKE '+%' OR length(regexp_replace(c.value_normalized, '\\D', '', 'g')) > 11 THEN '+' || regexp_replace(c.value_normalized, '\\D', '', 'g')
    ELSE '+' || :country || regexp_replace(c.value_normalized, '\\D', '', 'g') END, 'UTF8')), 'hex')`;

async function statusesForChannel(campaignId, channel, tenant, now, transaction) {
  const country = await readDefaultCountryCode(tenant, transaction);
  return sequelize.query(
    `WITH members AS (
       SELECT DISTINCT m.person_id, a.purpose FROM marketing.campaign_audience_members m
         JOIN marketing.campaign_audiences a ON a.id = m.audience_id AND a.company_id = m.company_id
        WHERE m.campaign_id = :campaignId AND m.company_id = :companyId),
     addr AS (
       SELECT c.person_id, ${ADDRESS_HASH_SQL} AS h FROM people.person_contacts c
        WHERE c.company_id = :companyId AND c.deleted_at IS NULL AND c.contact_type IN (:types) AND c.person_id IN (SELECT person_id FROM members))
     SELECT mem.person_id,
       EXISTS (SELECT 1 FROM addr WHERE addr.person_id = mem.person_id AND addr.h IS NOT NULL) AS has_address,
       EXISTS (SELECT 1 FROM marketing.suppression_list s
                WHERE s.company_id = :companyId AND s.active AND s.channel = :channel AND (s.expires_at IS NULL OR s.expires_at > :now)
                  AND (s.purpose IS NULL OR s.purpose = mem.purpose)
                  AND (s.person_id = mem.person_id OR s.address_hash IN (SELECT h FROM addr WHERE addr.person_id = mem.person_id AND h IS NOT NULL))) AS suppressed,
       COALESCE((SELECT x.status FROM people.communication_consents x
                  WHERE x.company_id = :companyId AND x.person_id = mem.person_id AND x.channel = :channel AND x.purpose IN ('ALL', mem.purpose)
                  ORDER BY x.recorded_at DESC LIMIT 1), '') = 'OPT_OUT' AS opted_out
       FROM members mem`,
    { replacements: { campaignId, companyId: tenant.companyId, channel, types: CONTACT_TYPES[channel] || [channel], isEmail: channel === 'EMAIL', country, now }, type: QueryTypes.SELECT, transaction }
  );
}

const classify = (row) => {
  if (row.suppressed) return 'SUPPRESSED';
  if (row.opted_out) return 'OPT_OUT';
  return row.has_address ? 'REACHABLE' : 'NO_ADDRESS';
};

/** { audienceSize, reachable, excludedSuppressed, excludedOptOut, excludedNoAddress } da campanha, nos canais dela. */
async function countReachable({ campaignId, channel, channels }, tenant, transaction, now = new Date()) {
  const list = (channels || [channel]).map((c) => String(c).toUpperCase());
  const perPerson = new Map();
  for (const ch of list) {
    for (const row of await statusesForChannel(campaignId, ch, tenant, now, transaction)) {
      const status = classify(row);
      const previous = perPerson.get(row.person_id);
      if (!previous || (previous !== 'REACHABLE' && status === 'REACHABLE')) perPerson.set(row.person_id, status);
    }
  }
  const counts = { audienceSize: perPerson.size, reachable: 0, excludedSuppressed: 0, excludedOptOut: 0, excludedNoAddress: 0 };
  const key = { REACHABLE: 'reachable', SUPPRESSED: 'excludedSuppressed', OPT_OUT: 'excludedOptOut', NO_ADDRESS: 'excludedNoAddress' };
  for (const status of perPerson.values()) counts[key[status]] += 1;
  return counts;
}

module.exports = { countReachable };
