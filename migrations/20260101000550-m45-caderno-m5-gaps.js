'use strict';

/**
 * M45 (19/10/2026) — lacunas do cruzamento linha a linha do Caderno do Marco 5:
 *  - §8 "Manual exige evidence_file_id e identificação do responsável pela coleta" e "Assinatura
 *    vincula signatário + contract_version_id + content_hash": signatures ganha método
 *    (ELECTRONIC|MANUAL), arquivo de evidência, quem coletou e o hash da versão assinada.
 *  - §11 "Correção após assinatura cria addendum/revision, não altera laudo original":
 *    inspections ganha o vínculo da revisão com a vistoria original e o motivo.
 *  - §14 "Processo tem número, órgão, classe, status, partes, valor, risco e responsável":
 *    legal_cases ganha órgão, classe, valor estimado e risco.
 *  - §15 "Prazo crítico vencido abre ocorrência HIGH/CRITICAL": legal_deadlines ganha a
 *    criticidade e o id da ocorrência (tarefa) aberta pelo job.
 * Tudo aditivo e nulo/padrão — nenhuma linha existente muda de significado.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE legal.signatures
               ADD COLUMN IF NOT EXISTS signature_method varchar(16) NOT NULL DEFAULT 'ELECTRONIC',
               ADD COLUMN IF NOT EXISTS evidence_file_id uuid NULL,
               ADD COLUMN IF NOT EXISTS collected_by_user_id uuid NULL,
               ADD COLUMN IF NOT EXISTS content_hash varchar(128) NULL`);
    await q(`DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signatures_manual_evidence_chk') THEN
                 ALTER TABLE legal.signatures ADD CONSTRAINT signatures_manual_evidence_chk
                   CHECK (signature_method IN ('ELECTRONIC','MANUAL')
                          AND (signature_method <> 'MANUAL' OR (evidence_file_id IS NOT NULL AND collected_by_user_id IS NOT NULL)));
               END IF; END $$`);
    await q(`ALTER TABLE legal.inspections
               ADD COLUMN IF NOT EXISTS revision_of_inspection_id uuid NULL REFERENCES legal.inspections(id) ON DELETE RESTRICT,
               ADD COLUMN IF NOT EXISTS revision_reason text NULL`);
    await q(`ALTER TABLE legal.legal_cases
               ADD COLUMN IF NOT EXISTS court varchar(160) NULL,
               ADD COLUMN IF NOT EXISTS case_class varchar(120) NULL,
               ADD COLUMN IF NOT EXISTS estimated_amount numeric(18,2) NULL,
               ADD COLUMN IF NOT EXISTS risk_level varchar(16) NULL`);
    await q(`DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_cases_risk_level_chk') THEN
                 ALTER TABLE legal.legal_cases ADD CONSTRAINT legal_cases_risk_level_chk
                   CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL'));
               END IF; END $$`);
    await q(`ALTER TABLE legal.legal_deadlines
               ADD COLUMN IF NOT EXISTS criticality varchar(16) NOT NULL DEFAULT 'MEDIUM',
               ADD COLUMN IF NOT EXISTS occurrence_task_id uuid NULL`);
    await q(`DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_deadlines_criticality_chk') THEN
                 ALTER TABLE legal.legal_deadlines ADD CONSTRAINT legal_deadlines_criticality_chk
                   CHECK (criticality IN ('LOW','MEDIUM','HIGH','CRITICAL'));
               END IF; END $$`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE legal.signatures DROP CONSTRAINT IF EXISTS signatures_manual_evidence_chk, DROP COLUMN IF EXISTS signature_method, DROP COLUMN IF EXISTS evidence_file_id, DROP COLUMN IF EXISTS collected_by_user_id, DROP COLUMN IF EXISTS content_hash');
    await q('ALTER TABLE legal.inspections DROP COLUMN IF EXISTS revision_of_inspection_id, DROP COLUMN IF EXISTS revision_reason');
    await q('ALTER TABLE legal.legal_cases DROP CONSTRAINT IF EXISTS legal_cases_risk_level_chk, DROP COLUMN IF EXISTS court, DROP COLUMN IF EXISTS case_class, DROP COLUMN IF EXISTS estimated_amount, DROP COLUMN IF EXISTS risk_level');
    await q('ALTER TABLE legal.legal_deadlines DROP CONSTRAINT IF EXISTS legal_deadlines_criticality_chk, DROP COLUMN IF EXISTS criticality, DROP COLUMN IF EXISTS occurrence_task_id');
  },
};
