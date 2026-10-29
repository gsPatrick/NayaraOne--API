'use strict';

const { File } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { assertCanReadFile } = require('../../../files/fileAccess.service');
const { getFileContent, MAX_BYTES } = require('../../../files/files.service');
const { crossCompanyBlocked, permissionDenied } = require('../../orchestrator/toolSecurity.errors');
const E = require('./documental.errors');

/**
 * Abre o arquivo para a NAY Documental (M9-D040), nesta ordem e parando na primeira recusa: o arquivo existe na empresa (outra empresa ou
 * id inexistente é 404 AI_CROSS_COMPANY_BLOCKED); foi verificado pelo antivírus (`scan_status = CLEAN`, senão 422 AI_DOCUMENT_NOT_VERIFIED
 * e nada é lido); a pessoa pode ler o arquivo pelo módulo dono (403 AI_PERMISSION_DENIED); documento restrito só com `ai:restricted`.
 * Depois lê o conteúdo com a conferência de integridade do módulo de arquivos. Só leitura: nada é gravado.
 */
async function openVerifiedFile(fileId, scope, transaction) {
  const found = await File.findByPk(fileId, { transaction });
  if (!found || found.companyId !== scope.companyId) throw crossCompanyBlocked();
  if (found.scanStatus !== 'CLEAN') throw E.notVerified();
  const auth = { userId: scope.userId, companyId: scope.companyId, groupId: scope.groupId, permissions: scope.userPermissions || [] };
  let access;
  try {
    access = await assertCanReadFile(fileId, auth, transaction);
  } catch (err) {
    if (err instanceof AppError && err.code === 'FILE_ACCESS_FORBIDDEN') throw permissionDenied();
    if (err instanceof AppError && err.code === 'FILE_NOT_FOUND') throw crossCompanyBlocked();
    throw err;
  }
  const isRestricted = access.restricted || access.file.classification === 'RESTRICTED';
  if (isRestricted && !auth.permissions.includes('ai:restricted')) throw E.restricted();
  const withContent = await getFileContent(fileId, transaction, scope.userId, access.file);
  const buffer = withContent.getDataValue('content');
  return { file: withContent, buffer, classification: access.file.classification || 'INTERNAL', maxBytes: MAX_BYTES };
}

module.exports = { openVerifiedFile };
