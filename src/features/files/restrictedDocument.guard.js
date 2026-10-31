'use strict';

const AppError = require('../../utils/AppError');
const scale = require('../../shared/data-classification/scale');

const CORRESPONDENT_PERMISSION = 'correspondent:documents:read';
const VIEW_RESTRICTED_PERMISSION = 'governance:dlp:view-restricted';

/**
 * Documento RESTRICTED só abre com a permissão dedicada (Marco 8, auditoria pós-DoD, Frente RLS, Ciclo 4): o download e o metadado de arquivo são genéricos (Jurídico, Obras,
 * Pessoas, Correspondente) e só checavam autenticação e RLS de empresa, então qualquer pessoa da empresa que soubesse o `fileId` baixava o conteúdo. A guarda fica no ponto único
 * de leitura de bytes e metadado de qualquer arquivo, nunca só no filtro da listagem.
 *  - `restricted` (vínculo com documento RESTRICTED do Correspondente): `correspondent:documents:read`, como sempre.
 *  - M9-D920 (generalizada pela classificação do arquivo): arquivo cuja `classification` é RESTRICTED, sem esse vínculo, só abre com `governance:dlp:view-restricted`.
 * Separada do controller para o DLP (M9-D920) aplicar a mesma regra no endereço assinado e no download em lote.
 */
function rejectRestrictedUnlessAllowed(restricted, permissions, file = null) {
  const granted = permissions || [];
  const byClass = !restricted && file && scale.normalize(file.getDataValue('classification')) === 'RESTRICTED';
  if ((restricted && !granted.includes(CORRESPONDENT_PERMISSION)) || (byClass && !granted.includes(VIEW_RESTRICTED_PERMISSION))) {
    throw AppError.forbidden(
      'Este arquivo é um documento restrito. Você não tem permissão para acessá-lo.',
      'FILE_RESTRICTED_DOCUMENT'
    );
  }
}

module.exports = { rejectRestrictedUnlessAllowed };
