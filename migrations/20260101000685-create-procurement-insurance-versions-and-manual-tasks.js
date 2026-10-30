'use strict';

/**
 * Marco 9, M9-D238 — seguradoras: apólice versionada, fluxo manual e origem do dado.
 *  - procurement.insurance_policy_versions: cada versão da apólice (inicial, endosso ou renovação) com o documento (file_id) e o hash SHA-256 obrigatórios, o início da vigência,
 *    o fim (nas renovações), o horário de recebimento e a origem (API ou MANUAL). IMUTÁVEL: gatilho recusa UPDATE e DELETE; a versão seguinte nasce como outra linha e a anterior
 *    é preservada. UNIQUE (policy_id, version).
 *  - procurement.insurance_manual_tasks: a tarefa que a seguradora sem API cria para uma pessoa (anexar a cotação recebida por e-mail, registrar o número da proposta, anexar a apólice).
 *  - insurance_policies.quote_request_json (o pedido de cotação minimizado, usado pela cotação de renovação), insurance_policies.issue_source e insurance_provider_submissions.source
 *    (API ou MANUAL: a única diferença registrada entre os dois caminhos).
 * Tabelas novas com RLS ENABLE + FORCE por empresa; o runtime só acrescenta versões.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const rls = async (tabela) => {
      await q(`ALTER TABLE "procurement"."${tabela}" ENABLE ROW LEVEL SECURITY;`);
      await q(`CREATE POLICY tenant_isolation ON "procurement"."${tabela}"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
        WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
      await q(`ALTER TABLE "procurement"."${tabela}" FORCE ROW LEVEL SECURITY;`);
    };

    await q(`
      CREATE TABLE IF NOT EXISTS "procurement"."insurance_policy_versions" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        policy_id uuid NOT NULL REFERENCES "procurement"."insurance_policies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        version integer NOT NULL CHECK (version >= 1),
        kind varchar(12) NOT NULL CHECK (kind IN ('INITIAL', 'ENDORSEMENT', 'RENEWAL')),
        file_id uuid NOT NULL REFERENCES "people"."files"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        effective_from date NOT NULL,
        expiry_date date,
        received_at timestamptz NOT NULL DEFAULT now(),
        source varchar(8) NOT NULL CHECK (source IN ('API', 'MANUAL')),
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS insurance_policy_versions_policy_version_uidx ON "procurement"."insurance_policy_versions" (policy_id, version);');
    await q(`
      CREATE OR REPLACE FUNCTION "procurement".insurance_policy_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        RAISE EXCEPTION 'A versão da apólice é imutável: registre uma nova versão' USING ERRCODE = 'check_violation';
      END
      $f$;
    `);
    await q('DROP TRIGGER IF EXISTS insurance_policy_versions_immutable_trg ON "procurement"."insurance_policy_versions";');
    await q('CREATE TRIGGER insurance_policy_versions_immutable_trg BEFORE UPDATE OR DELETE ON "procurement"."insurance_policy_versions" FOR EACH ROW EXECUTE FUNCTION "procurement".insurance_policy_versions_immutable();');
    await rls('insurance_policy_versions');

    await q(`
      CREATE TABLE IF NOT EXISTS "procurement"."insurance_manual_tasks" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        policy_id uuid NOT NULL REFERENCES "procurement"."insurance_policies"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        dispatch_id uuid REFERENCES "integration"."dispatches"(id) ON DELETE SET NULL ON UPDATE CASCADE,
        kind varchar(16) NOT NULL CHECK (kind IN ('QUOTE_DOCUMENT', 'PROPOSAL_NUMBER', 'POLICY_DOCUMENT')),
        purpose varchar(8) NOT NULL DEFAULT 'NEW' CHECK (purpose IN ('NEW', 'RENEWAL')),
        status varchar(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
        assigned_to_user_id uuid,
        due_at timestamptz,
        request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        result_json jsonb,
        file_id uuid,
        completed_by uuid,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS insurance_manual_tasks_dispatch_kind_uidx ON "procurement"."insurance_manual_tasks" (dispatch_id, kind) WHERE dispatch_id IS NOT NULL;');
    await q('CREATE INDEX IF NOT EXISTS insurance_manual_tasks_open_idx ON "procurement"."insurance_manual_tasks" (company_id, status, due_at);');
    await q('CREATE INDEX IF NOT EXISTS insurance_manual_tasks_policy_idx ON "procurement"."insurance_manual_tasks" (company_id, policy_id);');
    await rls('insurance_manual_tasks');

    await q('ALTER TABLE "procurement"."insurance_policies" ADD COLUMN IF NOT EXISTS quote_request_json jsonb;');
    await q("ALTER TABLE \"procurement\".\"insurance_policies\" ADD COLUMN IF NOT EXISTS issue_source varchar(8) CHECK (issue_source IS NULL OR issue_source IN ('API', 'MANUAL'));");
    await q("ALTER TABLE \"procurement\".\"insurance_provider_submissions\" ADD COLUMN IF NOT EXISTS source varchar(8) NOT NULL DEFAULT 'API' CHECK (source IN ('API', 'MANUAL'));");

    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "procurement" TO nayara_runtime;
        GRANT SELECT, INSERT ON "procurement"."insurance_policy_versions" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "procurement"."insurance_manual_tasks" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "procurement"."insurance_provider_submissions" DROP COLUMN IF EXISTS source;');
    await q('ALTER TABLE "procurement"."insurance_policies" DROP COLUMN IF EXISTS issue_source;');
    await q('ALTER TABLE "procurement"."insurance_policies" DROP COLUMN IF EXISTS quote_request_json;');
    await q('DROP TABLE IF EXISTS "procurement"."insurance_manual_tasks";');
    await q('DROP TRIGGER IF EXISTS insurance_policy_versions_immutable_trg ON "procurement"."insurance_policy_versions";');
    await q('DROP TABLE IF EXISTS "procurement"."insurance_policy_versions";');
    await q('DROP FUNCTION IF EXISTS "procurement".insurance_policy_versions_immutable();');
  },
};
