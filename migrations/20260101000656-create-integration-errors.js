'use strict';

const { randomUUID } = require('crypto');

/**
 * Marco 9, M9-D207 — integration.integration_errors (falhas operacionais de qualquer integração) e o contador
 * agregado integration.platform_unknown_webhooks (webhook de canal desconhecido: sem empresa, sem payload).
 *
 * Também copia correspondent.integration_errors para a tabela genérica de forma idempotente (mesmo id) e deixa a tabela
 * antiga somente leitura (gatilho recusa escrita, salvo a marca de sessão app.integration_legacy_write da D200).
 * Permissão nova: integration:retry (resolver e reprocessar erro). O role de runtime NÃO recebe DELETE: o expurgo é
 * feito pela função integration.purge_expired() da M9-D244.
 */
const SOURCES = ['WEBHOOK', 'DISPATCH', 'SYNC', 'HEALTH', 'SECRET', 'CONTRACT'];
const CLASSES = ['TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNKNOWN', 'SECURITY'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

const COPY_LEGACY_SQL = `
INSERT INTO "integration"."integration_errors"
  (id, group_id, company_id, provider_code, source, source_ref_id, operation, error_class, error_code, severity,
   message, attempts, status, resolved_by, resolved_at, resolution_note, created_at)
SELECT l.id, l.group_id, l.company_id, l.provider_code, 'DISPATCH', l.financing_case_id, l.operation, 'UNKNOWN',
       l.error_code, 'MEDIUM', l.message, 1, l.status, l.resolved_by, l.resolved_at, left(l.resolution_note, 500), l.created_at
FROM "correspondent"."integration_errors" l
ON CONFLICT (id) DO NOTHING;
`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);

    await q(`
      CREATE TABLE "integration"."integration_errors" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid REFERENCES "integration"."connections"(id) ON DELETE SET NULL ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        source varchar(16) NOT NULL CHECK (source IN (${lista(SOURCES)})),
        source_ref_id uuid,
        operation varchar(40),
        error_class varchar(12) NOT NULL CHECK (error_class IN (${lista(CLASSES)})),
        error_code varchar(64) NOT NULL,
        severity varchar(8) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        message varchar(500) NOT NULL,
        sanitized_payload jsonb,
        payload_hash char(64),
        http_status integer,
        attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
        status varchar(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RETRYING', 'RESOLVED', 'IGNORED')),
        resolved_by uuid,
        resolved_at timestamptz,
        resolution_note varchar(500),
        correlation_id varchar(64),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE INDEX integration_errors_company_status_idx ON "integration"."integration_errors" (company_id, status, created_at DESC);');
    await q('CREATE INDEX integration_errors_provider_idx ON "integration"."integration_errors" (provider_code, created_at);');
    await q('CREATE INDEX integration_errors_dedup_idx ON "integration"."integration_errors" (company_id, error_code, source_ref_id) WHERE status = \'OPEN\';');

    // Máquina de estados: OPEN→RETRYING→OPEN|RESOLVED e OPEN→RESOLVED|IGNORED; RESOLVED e IGNORED são finais.
    await q(`
      CREATE FUNCTION "integration".integration_errors_state_machine() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.status = OLD.status THEN
          RETURN NEW;
        END IF;
        IF (OLD.status = 'OPEN' AND NEW.status IN ('RETRYING', 'RESOLVED', 'IGNORED'))
           OR (OLD.status = 'RETRYING' AND NEW.status IN ('OPEN', 'RESOLVED')) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'erro de integração: transição % → % não permitida', OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END $f$;
    `);
    await q(`CREATE TRIGGER integration_errors_state_machine BEFORE UPDATE ON "integration"."integration_errors"
      FOR EACH ROW EXECUTE FUNCTION "integration".integration_errors_state_machine();`);

    await q('ALTER TABLE "integration"."integration_errors" ENABLE ROW LEVEL SECURITY;');
    await q('ALTER TABLE "integration"."integration_errors" FORCE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."integration_errors"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);

    // Contador agregado por hora e fornecedor: sem empresa, sem corpo, sem cabeçalho.
    await q(`
      CREATE TABLE "integration"."platform_unknown_webhooks" (
        provider_code varchar(48) NOT NULL,
        bucket timestamptz NOT NULL,
        hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider_code, bucket)
      );
    `);
    await q('ALTER TABLE "integration"."platform_unknown_webhooks" ENABLE ROW LEVEL SECURITY;');
    await q('ALTER TABLE "integration"."platform_unknown_webhooks" FORCE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY platform_only ON "integration"."platform_unknown_webhooks"
      USING (current_setting('app.integration_platform_admin', true) = 'on')
      WITH CHECK (current_setting('app.integration_platform_admin', true) = 'on');`);

    // Cópia do legado (a tabela de origem tem FORCE RLS: liberada só durante a cópia).
    await q('ALTER TABLE "correspondent"."integration_errors" NO FORCE ROW LEVEL SECURITY;');
    try {
      await q(COPY_LEGACY_SQL);
    } finally {
      await q('ALTER TABLE "correspondent"."integration_errors" FORCE ROW LEVEL SECURITY;');
    }
    await q(`
      CREATE FUNCTION "correspondent".integration_errors_read_only() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF current_setting('app.integration_legacy_write', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        RAISE EXCEPTION 'correspondent.integration_errors é legado somente leitura: use integration.integration_errors'
          USING ERRCODE = 'restrict_violation';
      END $f$;
    `);
    await q(`CREATE TRIGGER integration_errors_read_only BEFORE INSERT OR UPDATE OR DELETE ON "correspondent"."integration_errors"
      FOR EACH ROW EXECUTE FUNCTION "correspondent".integration_errors_read_only();`);

    // Permissão integration:retry (resolver e reprocessar) concedida ao ADMIN.
    await q(
      `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
       SELECT :id, 'integration:retry', 'Resolver, ignorar e reprocessar erros de integração da empresa.', 'MEDIUM', now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = 'integration:retry')`,
      { replacements: { id: randomUUID() } }
    );
    await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await q(
        `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
         SELECT gen_random_uuid(), r.id, p.id, now(), now()
         FROM core.roles r CROSS JOIN core.permissions p
         WHERE r.name = 'ADMIN' AND p.code = 'integration:retry'
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`
      );
    } finally {
      await q('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }

    const [[{ exists }]] = await q("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (exists) {
      await q('GRANT SELECT, INSERT, UPDATE ON "integration"."integration_errors" TO nayara_runtime;');
      await q('GRANT SELECT, INSERT, UPDATE ON "integration"."platform_unknown_webhooks" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS integration_errors_read_only ON "correspondent"."integration_errors";');
    await q('DROP FUNCTION IF EXISTS "correspondent".integration_errors_read_only();');
    await q('DROP TABLE IF EXISTS "integration"."platform_unknown_webhooks";');
    await q('DROP TABLE IF EXISTS "integration"."integration_errors";');
    await q('DROP FUNCTION IF EXISTS "integration".integration_errors_state_machine();');
  },
};
