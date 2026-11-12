'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { normalize: classOf } = require('../../../shared/data-classification/scale');

/**
 * Livro JUR-010 "Arquivo, áudio, foto e documento mantêm hash/origem/acessos" e §16 "Acesso/exportação são auditados".
 * Toda leitura individual de uma prova do Jurídico (arquivo cujo dono é um registro jurídico — contrato, vistoria, processo,
 * prazo, notificação, garantia, entrega de chaves) fica registrada na auditoria, em QUALQUER classe de arquivo (LOW, MEDIUM,
 * HIGH ou RESTRICTED), com o hash guardado, a origem (onde o arquivo está ligado) e o tipo de acesso. A regra de DLP de cada
 * classe continua valendo por cima disto (pode exigir justificativa ou MFA); este registro é a cadeia de custódia.
 */
const LEGAL_OWNER_PERMISSION = 'legal:read';
const KIND_LABELS = { CONTENT: 'conteúdo', METADATA: 'dados do arquivo', DOWNLOAD_GRANT: 'endereço de download emitido' };

function isLegalEvidence(ownership) {
  return Boolean(ownership && ownership.permissions && ownership.permissions.has(LEGAL_OWNER_PERMISSION));
}

/** `kind`: CONTENT (bytes entregues) ou METADATA (dados do arquivo). */
async function recordEvidenceFileAccess({ file, ownership, auth, kind, ip }, transaction) {
  if (!isLegalEvidence(ownership)) return null;
  const origem = (ownership.origins || []).filter((o) => o.startsWith('legal.') || o.startsWith('people.file_links:'));
  return registrarAuditoria(
    {
      groupId: file.groupId,
      companyId: file.companyId,
      actorUserId: auth.userId,
      action: 'legal.evidence.file_access',
      entityType: 'File',
      entityId: file.id,
      // O acesso não muda o arquivo: antes = o arquivo como estava (hash e classe); depois = o mesmo arquivo com o acesso registrado.
      beforeJson: { arquivo: file.id, sha256: file.checksumSha256 || null, classificacao: classOf(file.classification) || null, acessoRegistrado: false },
      afterJson: {
        acessoRegistrado: true,
        acesso: kind,
        classificacao: classOf(file.classification) || null,
        sha256: file.checksumSha256 || null,
        nomeOriginal: file.fileName,
        mimeType: file.mimeType,
        origem,
        enviadoPor: file.uploadedByUserId || file.createdBy || null,
        ip: ip || null,
      },
      reason: `Prova ${file.fileName} acessada (${KIND_LABELS[kind] || kind}), classe ${classOf(file.classification) || 'não informada'}.`,
    },
    transaction
  );
}

module.exports = { recordEvidenceFileAccess, isLegalEvidence };
