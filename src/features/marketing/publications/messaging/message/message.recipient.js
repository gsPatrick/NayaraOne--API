'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');

const CONTACT_TYPES = Object.freeze({ WHATSAPP: ['WHATSAPP', 'PHONE'], EMAIL: ['EMAIL'] });

/** O endereço principal da pessoa no canal (telefone ou e-mail), ou null. Só o adapter do canal o recebe; log e auditoria nunca. */
async function recipientAddress(personId, channel, tenant, transaction) {
  const [row] = await sequelize.query(
    `SELECT value_normalized FROM people.person_contacts
      WHERE company_id = :companyId AND person_id = :personId AND contact_type IN (:types) AND deleted_at IS NULL
      ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    { replacements: { companyId: tenant.companyId, personId, types: CONTACT_TYPES[channel] }, type: QueryTypes.SELECT, transaction }
  );
  return row ? row.value_normalized : null;
}

module.exports = { recipientAddress };
