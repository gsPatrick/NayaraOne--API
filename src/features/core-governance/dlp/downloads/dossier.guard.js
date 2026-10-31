'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const scale = require('../../../../shared/data-classification/scale');
const { hasRecentMfa } = require('../../../users/mfa.service');
const guardService = require('../guard.service');
const { blockedError } = require('../guard.reasons');
const { parseDownloadInput } = require('./download.input');

/** Classe herdada do dossiê: a MAIOR entre os anexos que o manifesto cita (o manifesto guarda o hash do arquivo; o arquivo, a classe). RESTRICTED do Correspondente conta como RESTRICTED. */
async function inheritedClass(manifest, transaction) {
  const hashes = [...new Set((manifest || []).map((item) => item && item.hash).filter((hash) => typeof hash === 'string' && hash))];
  if (!hashes.length) return null;
  const rows = await sequelize.query(
    `SELECT f.classification, EXISTS (SELECT 1 FROM correspondent.case_documents d WHERE d.file_id = f.id AND d.classification = 'RESTRICTED') AS restricted
       FROM people.files f WHERE f.checksum_sha256 IN (:hashes) AND f.deleted_at IS NULL`,
    { replacements: { hashes }, type: QueryTypes.SELECT, transaction }
  );
  return scale.highest(rows.map((row) => (row.restricted ? 'RESTRICTED' : row.classification)));
}

/**
 * Exportação do dossiê de provas pelo guard da DLP (M9-D920 critério herdado da M9-D809 / AUD-016): o dossiê herda a classe dos anexos que cita (nunca menos que a padrão da empresa) e a
 * exportação passa pelo guard como EXPORT, com volume = itens do manifesto. Sem finalidade, justificativa e MFA conforme a classe, recusa (o pedido fica registrado) e o manifesto não sai.
 */
async function guardEvidenceExport({ tenant, auth, ip, evidencePackage, query, transaction }) {
  const manifest = evidencePackage.manifestJson || [];
  const input = parseDownloadInput(query);
  const decision = await guardService.decide(tenant, {
    action: 'EXPORT', kind: 'EXPORT', resourceType: 'legal.evidence_package', resourceIds: [evidencePackage.id], minClassification: await inheritedClass(manifest, transaction),
    estimatedRows: manifest.length, purpose: input.purpose, justification: input.justification, mfaOk: await hasRecentMfa(auth.userId, transaction), permissions: auth.permissions,
    actorUserId: auth.userId, ip,
  });
  if (decision.decision === 'DENY') throw blockedError(decision, decision.justificationMin);
  return decision;
}

module.exports = { guardEvidenceExport, inheritedClass };
