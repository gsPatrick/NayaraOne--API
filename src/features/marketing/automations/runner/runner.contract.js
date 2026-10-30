'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const OPEN_OCCURRENCE_STATUSES = Object.freeze(['OPEN', 'IN_PROGRESS', 'ESCALATED']);

const rows = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/**
 * Regra comum da cadência por contrato (M9-D422): no vencimento de cada ação o contrato precisa estar ATIVO (`requireActiveContract`) e a pessoa não pode ter ocorrência
 * aberta (`requireNoOpenOccurrence`: caso de reclamação, elogio ou conflito do CRM OPEN, IN_PROGRESS ou ESCALATED). Contrato inexistente conta como não ativo.
 */
async function contractAllowsMessages(contractId, personId, triggerConfig, transaction) {
  if (triggerConfig.requireActiveContract) {
    const [contract] = await rows('SELECT status FROM legal.contracts WHERE id = :id AND deleted_at IS NULL', { id: contractId }, transaction);
    if (!contract || contract.status !== 'ACTIVE') return false;
  }
  if (triggerConfig.requireNoOpenOccurrence && personId) {
    const [open] = await rows('SELECT 1 AS ok FROM crm.feedback_cases WHERE person_id = :p AND status IN (:statuses) AND deleted_at IS NULL LIMIT 1', { p: personId, statuses: OPEN_OCCURRENCE_STATUSES }, transaction);
    if (open) return false;
  }
  return true;
}

module.exports = { contractAllowsMessages, OPEN_OCCURRENCE_STATUSES };
