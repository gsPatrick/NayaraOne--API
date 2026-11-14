'use strict';

const { Op } = require('sequelize');
const { File } = require('../../models');
const AppError = require('../../utils/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DEFEITO CORRIGIDO (matriz de fechamento do Marco 6, 10/11/2026). O Caderno (Construção + Obras +
 * Pós-obra, §2 e §6) exige evidência antes/depois na não conformidade, evidências no Change Order,
 * antes/depois no chamado de garantia e "Fotos possuem hash/origem". Até aqui os serviços de Obras
 * só conferiam se a lista de IDs vinha preenchida: um UUID qualquer, sem arquivo nenhum por trás
 * (portanto sem hash nem origem), fechava uma NC, sustentava um aditivo e fechava um chamado.
 *
 * Regra: todo ID de evidência informado precisa ser um arquivo enviado pelo módulo de arquivos
 * (core.files) da MESMA empresa e não excluído. A consulta roda na transação do tenant (RLS), então
 * arquivo de outra empresa também conta como inexistente. Recusa com 400
 * CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND e a lista dos IDs que não existem; nada é gravado.
 */
// `requireClean` (verificação independente do Marco 6: documento do prestador e evidência da medição): o arquivo também
// precisa ter passado pelo antivírus no envio (scan_status CLEAN); sem isso, 422 CONSTRUCTION_EVIDENCE_FILE_NOT_SCANNED.
async function assertEvidenceFilesExist(fileIds, companyId, transaction, field, { requireClean = false } = {}) {
  if (fileIds !== undefined && fileIds !== null && !Array.isArray(fileIds)) {
    throw AppError.badRequest(`"${field}" deve ser uma lista de IDs de arquivo.`, 'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND', { field });
  }
  if (!Array.isArray(fileIds) || fileIds.length === 0) return;
  const unique = [...new Set(fileIds.map((id) => String(id).trim()))];
  const malformed = unique.filter((id) => !UUID_RE.test(id));
  const wellFormed = unique.filter((id) => UUID_RE.test(id));
  const found = wellFormed.length
    ? await File.findAll({ where: { id: { [Op.in]: wellFormed }, companyId }, attributes: ['id', 'scanStatus'], transaction })
    : [];
  const foundIds = new Set(found.map((f) => f.id));
  const missing = [...malformed, ...wellFormed.filter((id) => !foundIds.has(id))];
  if (missing.length) {
    throw AppError.badRequest(
      `Evidência inválida em "${field}": ${missing.length === 1 ? 'o arquivo informado não existe' : `${missing.length} arquivos informados não existem`} ` +
        'nesta empresa. Envie a foto/documento pelo módulo de arquivos e use o ID devolvido no envio.',
      'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND',
      { field, missingFileIds: missing }
    );
  }
  const unscanned = requireClean ? found.filter((f) => f.scanStatus !== 'CLEAN').map((f) => f.id) : [];
  if (unscanned.length) {
    throw AppError.unprocessable(
      `Arquivo sem exame do antivírus em "${field}": envie o documento de novo pelo módulo de arquivos.`,
      'CONSTRUCTION_EVIDENCE_FILE_NOT_SCANNED',
      { field, fileIds: unscanned }
    );
  }
}

module.exports = { assertEvidenceFilesExist };
