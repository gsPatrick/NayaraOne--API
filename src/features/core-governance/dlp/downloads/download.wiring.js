'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const scale = require('../../../../shared/data-classification/scale');

/**
 * Classe de UM anexo para o resolvedor do guard (M9-D920 §3.2): a gravada em people.files.classification ou RESTRICTED quando o arquivo é documento RESTRICTED do Correspondente.
 * Sem isto o guard daria a todo anexo a classe padrão (HIGH) e um anexo LOW ou MEDIUM nunca seria tratado como tal. Arquivo inexistente: null (vale a classe padrão).
 */
async function fileClassOf(_tenant, id, transaction) {
  const rows = await sequelize.query(
    `SELECT f.classification, EXISTS (SELECT 1 FROM correspondent.case_documents d WHERE d.file_id = f.id AND d.classification = 'RESTRICTED') AS restricted
       FROM people.files f WHERE f.id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT, transaction }
  );
  if (!rows[0]) return null;
  const stored = scale.normalize(rows[0].classification) || 'HIGH';
  return rows[0].restricted ? scale.highest([stored, 'RESTRICTED']) : stored;
}

/** Liga o resolvedor por registro de `files.file` ao registro de classificação (M9-D910). require tardio: o registro de classificação carrega depois do módulo de arquivos. */
function install() {
  require('../../data-quality/classification.service').registerRecordResolver('files.file', fileClassOf); // eslint-disable-line global-require
}

module.exports = { install, fileClassOf };
