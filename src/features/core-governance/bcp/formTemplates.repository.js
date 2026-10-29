'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Leitura de governance.bcp_form_templates (M9-D834): catálogo do sistema, só leitura para o runtime. */
const COLUMNS = `t.id, t.sector, t.form_type AS "formType", t.title, t.intended_action AS "intendedAction", t.fields, t.payload_schema AS "payloadSchema"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Todos os modelos (ou só os dos setores dados), na ordem dos setores do livro e do tipo. */
function listTemplates(transaction, sectors) {
  return select(
    `SELECT ${COLUMNS} FROM governance.bcp_form_templates t JOIN governance.bcp_sectors s ON s.sector = t.sector
      WHERE (CAST(:all AS boolean) OR t.sector IN (:sectors)) ORDER BY s.position, t.form_type`,
    { all: !sectors, sectors: sectors && sectors.length ? sectors : [''] }, transaction
  );
}

/** O modelo de um tipo de formulário (o tipo é único no catálogo), ou null. */
async function findByFormType(formType, transaction) {
  if (typeof formType !== 'string') return null;
  return (await select(`SELECT ${COLUMNS} FROM governance.bcp_form_templates t WHERE t.form_type = :formType`, { formType }, transaction))[0] || null;
}

/** O modelo do tipo dentro do setor, ou null. */
async function findInSector(sector, formType, transaction) {
  const template = await findByFormType(formType, transaction);
  return template && template.sector === sector ? template : null;
}

module.exports = { listTemplates, findByFormType, findInSector };
