'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Livro §11 "Assinatura congela a versão" e "Correção após assinatura cria addendum/revision, não altera laudo original".
 * A vistoria está assinada quando locador e locatário assinaram. Depois disso o laudo (PDF + hash) pode ser emitido uma vez
 * — já com as assinaturas — e fica imutável: emitir de novo é recusado (corrigir = revisão, createInspectionRevision).
 * O banco reforça a mesma regra (gatilho inspections_laudo_assinado_imutavel, migration 20260101015600).
 */
const SIGNING_ROLES = ['LANDLORD', 'TENANT'];

function fullySignedAt(signatures) {
  const byRole = new Map();
  for (const sig of signatures || []) if (SIGNING_ROLES.includes(sig.partyRole)) byRole.set(sig.partyRole, new Date(sig.signedAt));
  if (byRole.size < SIGNING_ROLES.length) return null;
  return new Date(Math.max(...[...byRole.values()].map((d) => d.getTime())));
}

function assertReportNotFrozen(inspection, signatures) {
  const signedAt = fullySignedAt(signatures);
  if (!signedAt || !inspection.reportHash || !inspection.reportGeneratedAt) return;
  if (new Date(inspection.reportGeneratedAt).getTime() >= signedAt.getTime()) {
    throw AppError.conflict(
      'O laudo desta vistoria já foi emitido depois da assinatura de locador e locatário e não pode ser gerado de novo. Para corrigir, crie uma revisão da vistoria.',
      'LEGAL_INSPECTION_REPORT_FROZEN',
      { reportHash: inspection.reportHash, reportGeneratedAt: inspection.reportGeneratedAt }
    );
  }
}

module.exports = { assertReportNotFrozen, fullySignedAt };
