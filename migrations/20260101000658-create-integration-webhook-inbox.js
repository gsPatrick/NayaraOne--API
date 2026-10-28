'use strict';

/**
 * Marco 9, M9-D203 — integration.webhook_inbox: eventos externos idempotentes de qualquer provider.
 * UNIQUE (provider_code, external_event_id) é a garantia de dedup (livro, guia §5). RLS ENABLE + FORCE.
 * O runtime não apaga linhas: a retenção é feita pela função integration.purge_webhook_inbox (M9-D244 a chama
 * de integration.purge_expired()).
 *
 * Também copia correspondent.webhook_inbox (idempotente, mesmo id) e deixa a tabela antiga somente leitura para
 * INSERT e UPDATE (o DELETE segue liberado porque a exclusão em cascata do caso de financiamento o usa).
 */
const STATUSES = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER'];

const BACKFILL_SQL = `
INSERT INTO "integration"."webhook_inbox"
  (id, group_id, company_id, connection_id, provider_code, channel, external_event_id, signature_valid, payload_hash,
   payload, headers_json, status, attempts, next_attempt_at, received_at, processed_at)
SELECT w.id, w.group_id, w.company_id,
       (SELECT c.id FROM "integration"."connections" c
         WHERE c.company_id = w.company_id AND c.provider_code = lower(w.provider_code)
         ORDER BY (c.status = 'ACTIVE') DESC, c.created_at, c.id LIMIT 1),
       lower(w.provider_code), NULL, w.external_event_id, true,
       encode(sha256(convert_to(w.payload::text, 'UTF8')), 'hex'),
       w.payload, jsonb_build_object('caseRef', w.financing_case_id), 'PROCESSED', 1, w.received_at, w.received_at, w.received_at
FROM "correspondent"."webhook_inbox" w
WHERE lower(w.provider_code) ~ '^[a-z0-9_-]{1,48}$'
ON CONFLICT DO NOTHING;
`;

module.exports = {
  BACKFILL_SQL,
  up: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    const lista = STATUSES.map((s) => `'${s}'`).join(', ');

    await q(`
      CREATE TABLE "integration"."webhook_inbox" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        channel varchar(48),
        external_event_id varchar(160) NOT NULL CHECK (length(external_event_id) > 0),
        event_type varchar(80),
        api_version varchar(16),
        signature_valid boolean NOT NULL CHECK (signature_valid IS TRUE),
        payload_hash char(64) NOT NULL,
        payload_raw bytea,
        payload jsonb,
        headers_json jsonb,
        status varchar(12) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (${lista})),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        dead_letter_reason text,
        correlation_id uuid,
        CONSTRAINT webhook_inbox_provider_event_unique UNIQUE (provider_code, external_event_id)
      );
    `);
    await q('CREATE INDEX webhook_inbox_worker_idx ON "integration"."webhook_inbox" (status, next_attempt_at);');
    await q('CREATE INDEX webhook_inbox_company_received_idx ON "integration"."webhook_inbox" (company_id, received_at);');

    await q('ALTER TABLE "integration"."webhook_inbox" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."webhook_inbox"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "integration"."webhook_inbox" FORCE ROW LEVEL SECURITY;');

    // Retenção (da empresa da sessão): anula o corpo bruto e o corpo já lido (mantém o hash) e depois apaga a linha.
    await q(`
      CREATE FUNCTION "integration".purge_webhook_inbox(p_raw_days integer, p_days integer, p_dlq_raw_days integer)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, "integration" AS $f$
      DECLARE
        v_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
        v_raw integer; v_dlq integer; v_del integer;
      BEGIN
        IF v_company IS NULL THEN
          RAISE EXCEPTION 'purge_webhook_inbox exige a empresa da sessão (app.company_id)' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF p_raw_days IS NULL OR p_raw_days < 1 OR p_days IS NULL OR p_days < 1 OR p_dlq_raw_days IS NULL OR p_dlq_raw_days < 1 THEN
          RAISE EXCEPTION 'prazo de retenção inválido' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        UPDATE "integration"."webhook_inbox" SET payload_raw = NULL, payload = NULL
         WHERE company_id = v_company AND status = 'PROCESSED' AND (payload_raw IS NOT NULL OR payload IS NOT NULL)
           AND received_at < now() - make_interval(days => p_raw_days);
        GET DIAGNOSTICS v_raw = ROW_COUNT;
        UPDATE "integration"."webhook_inbox" SET payload_raw = NULL, payload = NULL
         WHERE company_id = v_company AND status = 'DEAD_LETTER' AND (payload_raw IS NOT NULL OR payload IS NOT NULL)
           AND received_at < now() - make_interval(days => p_dlq_raw_days);
        GET DIAGNOSTICS v_dlq = ROW_COUNT;
        DELETE FROM "integration"."webhook_inbox" i
         WHERE i.company_id = v_company AND i.status IN ('PROCESSED', 'DEAD_LETTER')
           AND i.received_at < now() - make_interval(days => p_days)
           AND NOT EXISTS (SELECT 1 FROM "integration"."integration_errors" e
                            WHERE e.company_id = v_company AND e.source = 'WEBHOOK' AND e.source_ref_id = i.id
                              AND e.status IN ('OPEN', 'RETRYING'));
        GET DIAGNOSTICS v_del = ROW_COUNT;
        RETURN jsonb_build_object('rawCleared', v_raw, 'dlqRawCleared', v_dlq, 'deleted', v_del);
      END $f$;
    `);
    await q('REVOKE ALL ON FUNCTION "integration".purge_webhook_inbox(integer, integer, integer) FROM PUBLIC;');

    await q(BACKFILL_SQL);

    await q(`
      CREATE FUNCTION "correspondent".webhook_inbox_read_only() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF current_setting('app.integration_legacy_write', true) = 'on' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'correspondent.webhook_inbox é legado somente leitura: use integration.webhook_inbox'
          USING ERRCODE = 'restrict_violation';
      END $f$;
    `);
    await q(`CREATE TRIGGER webhook_inbox_read_only BEFORE INSERT OR UPDATE ON "correspondent"."webhook_inbox"
      FOR EACH ROW EXECUTE FUNCTION "correspondent".webhook_inbox_read_only();`);

    await q(`
      DO $g$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE ON "integration"."webhook_inbox" TO nayara_runtime;
          GRANT EXECUTE ON FUNCTION "integration".purge_webhook_inbox(integer, integer, integer) TO nayara_runtime;
        END IF;
      END $g$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS webhook_inbox_read_only ON "correspondent"."webhook_inbox";');
    await q('DROP FUNCTION IF EXISTS "correspondent".webhook_inbox_read_only();');
    await q('DROP FUNCTION IF EXISTS "integration".purge_webhook_inbox(integer, integer, integer);');
    await q('DROP TABLE IF EXISTS "integration"."webhook_inbox";');
  },
};
