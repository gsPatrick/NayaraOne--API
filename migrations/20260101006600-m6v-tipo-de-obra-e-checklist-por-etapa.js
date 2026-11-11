'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Verificação independente do Marco 6 (M6-12 e M6-86), Caderno Construção + Obras + Pós-obra §9:
 * "Checklist por etapa/tipo de obra; falha abre nonconformity."
 *
 *  - construction.project_types: tipos de obra cadastrados pelo administrador da empresa (o livro não lista os tipos,
 *    então nada é semeado: regra do Patrick, o que o livro não resolve vira configuração; DI-M6V-2).
 *  - construction.checklist_templates: modelo de checklist por tipo de obra (project_type_id; nulo = todos os tipos) e
 *    por etapa (stage_code; nulo = item da obra, sem etapa). Cada item traz a categoria e a severidade da não
 *    conformidade que a reprovação abre.
 *  - construction.projects.project_type_id: o tipo de obra.
 *  - construction.quality_checklist_items.checklist_template_id / failure_severity: o item gerado do modelo guarda a
 *    origem e a severidade configurada; um índice único impede gerar o mesmo item duas vezes para a mesma etapa.
 *
 * As referências novas são chaves estrangeiras COMPOSTAS (id, company_id): o banco recusa um tipo de obra de outra
 * empresa mesmo que a aplicação falhe (FK comum ignora RLS). RLS ENABLE + FORCE e política tenant_isolation, como as
 * demais tabelas de construction (helper compartilhado de 20260101000666). Reversível.
 */
const TYPES = 'construction.project_types';
const TEMPLATES = 'construction.checklist_templates';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS ${TYPES} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        name varchar(120) NOT NULL,
        description text NULL,
        active boolean NOT NULL DEFAULT true,
        lock_version integer NOT NULL DEFAULT 0,
        created_by uuid NULL,
        updated_by uuid NULL,
        deleted_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT project_types_id_company_unique UNIQUE (id, company_id)
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_types_company_code_unique ON ${TYPES} (company_id, upper(code)) WHERE deleted_at IS NULL`);
      await applyLegalTenantRls(q, TYPES);

      await q(`CREATE TABLE IF NOT EXISTS ${TEMPLATES} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        project_type_id uuid NULL,
        stage_code varchar(40) NULL,
        item varchar(255) NOT NULL,
        category varchar(32) NOT NULL DEFAULT 'OUTROS',
        failure_severity varchar(16) NOT NULL DEFAULT 'MEDIUM',
        sequence integer NOT NULL DEFAULT 1,
        active boolean NOT NULL DEFAULT true,
        lock_version integer NOT NULL DEFAULT 0,
        created_by uuid NULL,
        updated_by uuid NULL,
        deleted_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT checklist_templates_type_same_company FOREIGN KEY (project_type_id, company_id)
          REFERENCES ${TYPES} (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT checklist_templates_severity_check CHECK (failure_severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
      )`);
      await q(`CREATE INDEX IF NOT EXISTS checklist_templates_lookup ON ${TEMPLATES} (company_id, project_type_id, stage_code) WHERE deleted_at IS NULL`);
      await applyLegalTenantRls(q, TEMPLATES);

      await q('ALTER TABLE construction.projects ADD COLUMN IF NOT EXISTS project_type_id uuid NULL');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_project_type_same_company') THEN
          ALTER TABLE construction.projects ADD CONSTRAINT projects_project_type_same_company
            FOREIGN KEY (project_type_id, company_id) REFERENCES ${TYPES} (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT;
        END IF;
      END $$`);

      await q(`ALTER TABLE construction.quality_checklist_items
        ADD COLUMN IF NOT EXISTS checklist_template_id uuid NULL REFERENCES ${TEMPLATES}(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS failure_severity varchar(16) NULL`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS quality_items_template_once_per_stage
        ON construction.quality_checklist_items (project_id, COALESCE(project_stage_id, '00000000-0000-0000-0000-000000000000'::uuid), checklist_template_id)
        WHERE checklist_template_id IS NOT NULL AND deleted_at IS NULL`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS construction.quality_items_template_once_per_stage');
      await q('ALTER TABLE construction.quality_checklist_items DROP COLUMN IF EXISTS checklist_template_id, DROP COLUMN IF EXISTS failure_severity');
      await q('ALTER TABLE construction.projects DROP CONSTRAINT IF EXISTS projects_project_type_same_company');
      await q('ALTER TABLE construction.projects DROP COLUMN IF EXISTS project_type_id');
      await q(`DROP TABLE IF EXISTS ${TEMPLATES}`);
      await q(`DROP TABLE IF EXISTS ${TYPES}`);
    });
  },
};
