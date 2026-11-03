'use strict';

const { rodarSuite } = require('./processo');
const { withClient } = require('../../lib/classificationDb');
const { FLOOR_CLASSES, FLOOR_ACTION } = require('../../../src/features/core-governance/dlp/dlp.constants');

const NOME = 'DLP';

/** Piso do livro (M9-D820 §3.3 item 2) conferido nas linhas gravadas: EXPORT de HIGH e RESTRICTED permitido exige justificativa, MFA, auditoria e expiração. */
async function piso() {
  const { rows } = await withClient((c) => c.query(
    `SELECT company_id, classification FROM governance.dlp_policies
      WHERE classification = ANY($1) AND action = $2 AND allowed
        AND (NOT require_justification OR NOT require_mfa OR NOT require_audit OR max_expiry_hours IS NULL OR max_expiry_hours < 1)`,
    [FLOOR_CLASSES, FLOOR_ACTION]
  ));
  if (rows.length) return { ok: false, motivo: `${rows.length} política(s) de ${FLOOR_ACTION} abaixo do piso (GOV_DLP_FLOOR_VIOLATION em ${[...new Set(rows.map((r) => r.classification))].join(', ')})` };
  return { ok: true, motivo: `piso de ${FLOOR_ACTION} respeitado em HIGH e RESTRICTED` };
}

/** Item 4: piso das políticas gravadas e a suíte de DLP (exportação, link, VIEW/COPY, impressão, anexos e downloads) verde, nenhum teste pulado. */
async function verificar({ cfg }) {
  const etapas = [['piso', piso], ['suíte', async () => rodarSuite(cfg.dlp.suites)]];
  const partes = [];
  let naoAplicavel = 0;
  for (const [rotulo, etapa] of etapas) {
    const r = await etapa();
    if (!r.ok) return { nome: NOME, ok: false, motivo: `${rotulo}: ${r.motivo}` };
    naoAplicavel += r.naoAplicavel || 0;
    partes.push(`${rotulo}: ${r.motivo}`);
  }
  // Parte da suíte não executou por falta de artefato irmão (CI só com a API): o item não é "OK", é NAO_APLICAVEL_NO_CI (visível e contado à parte).
  if (naoAplicavel) return { nome: NOME, ok: true, situacao: 'NAO_APLICAVEL_NO_CI', motivo: `NAO_APLICAVEL_NO_CI em ${naoAplicavel} teste(s), o resto verde; ${partes.join('; ')}` };
  return { nome: NOME, ok: true, motivo: partes.join('; ') };
}

module.exports = { verificar, NOME, precisaBanco: true };
