'use strict';

const scale = require('../../../../shared/data-classification/scale');

/** Classe de um anexo para o DLP: a gravada no arquivo (escala do livro) ou RESTRICTED quando o arquivo é documento RESTRICTED do Correspondente (o vínculo vale mais que a coluna). */
function effectiveClass(file, restricted) {
  const stored = scale.normalize(file.getDataValue('classification')) || 'HIGH';
  return restricted ? scale.highest([stored, 'RESTRICTED']) : stored;
}

/** HIGH e RESTRICTED passam pelo guard completo (justificativa, MFA conforme a matriz, pedido registrado); LOW e MEDIUM baixam direto com auditoria simples. */
const isGuarded = (classification) => classification === 'HIGH' || classification === 'RESTRICTED';

module.exports = { effectiveClass, isGuarded };
