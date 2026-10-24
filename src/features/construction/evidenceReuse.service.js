'use strict';

const { Op } = require('sequelize');
const { File } = require('../../models');

/**
 * evidenceReuse.service — helper compartilhado extraído de nonconformities.service.js#detectEvidenceReuse
 * (M6-59) para não duplicar a lógica de comparação de hash quando o mesmo tipo de checagem passou
 * a ser exigida também no Diário de Obra (RDO) — GAP REAL CORRIGIDO na auditoria externa Nayara,
 * 2026-10-08: "Fotos possuem hash/origem" valia só para Nonconformity, nunca foi conectado ao RDO.
 *
 * `resolveSameContentFileIds` isola a parte que é genérica (achar todo File da empresa que
 * compartilha o `checksumSha256` — o hash de integridade já calculado no upload, nunca
 * recalculado aqui) de todo File — cada chamador então decide, com seu PRÓPRIO modelo/colunas
 * (Nonconformity.before/afterEvidenceFileIds, DailyReport.evidenceFileIds, etc.), quais outros
 * registros já usaram esses mesmos arquivos.
 */
async function resolveSameContentFileIds(fileIds, companyId, transaction) {
  if (!Array.isArray(fileIds) || !fileIds.length) return [];

  const attachedFiles = await File.findAll({ where: { id: { [Op.in]: fileIds }, companyId }, transaction });
  const checksums = [...new Set(attachedFiles.map((f) => f.checksumSha256).filter(Boolean))];
  if (!checksums.length) return [];

  // Todo File (de qualquer registro/obra da empresa) que compartilha um desses checksums —
  // inclui tanto reuso do MESMO arquivo (mesmo id) quanto reupload do mesmo conteúdo (id
  // diferente, bytes idênticos).
  const sameContentFiles = await File.findAll({ where: { checksumSha256: { [Op.in]: checksums }, companyId }, transaction });
  return sameContentFiles.map((f) => f.id);
}

module.exports = { resolveSameContentFileIds };
