'use strict';

/**
 * Marco 9, M9-D247 — files.quarantine: área de quarentena dos uploads externos. Cada arquivo que chega de fora (mídia de mensagem, anexo, foto baixada de URL, documento de portal)
 * entra aqui com status QUARANTINED, hash SHA-256, origem (connection e id externo) e o horário; o conteúdo fica no armazenamento sob company/<id>/quarantine/, sem leitura por usuário.
 * O resultado (CLEAN, INFECTED, REJECTED_TYPE, REJECTED_SIZE, REJECTED_BOMB, EXPIRED) e o arquivo promovido ficam na própria linha. A idempotência é por empresa + hash + origem.
 * RLS ENABLE + FORCE por empresa; o runtime lê, grava e atualiza (a linha, que guarda o hash do descartado, nunca é apagada).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "files";');
    await q(`
      CREATE TABLE IF NOT EXISTS "files"."quarantine" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid REFERENCES "integration"."connections"(id) ON DELETE SET NULL ON UPDATE CASCADE,
        external_id varchar(160),
        origin_key varchar(400) NOT NULL,
        file_name varchar(255),
        declared_mime varchar(160),
        detected_mime varchar(160),
        size_bytes bigint NOT NULL,
        sha256 varchar(64) NOT NULL,
        clean_sha256 varchar(64),
        storage_key varchar(400),
        status varchar(16) NOT NULL DEFAULT 'QUARANTINED' CHECK (status IN ('QUARANTINED', 'CLEAN', 'INFECTED', 'REJECTED_TYPE', 'REJECTED_SIZE', 'REJECTED_BOMB', 'EXPIRED')),
        reason varchar(120),
        signature varchar(160),
        metadata_stripped boolean NOT NULL DEFAULT false,
        pii_detected boolean NOT NULL DEFAULT false,
        promoted_file_id uuid,
        received_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS quarantine_hash_origin_uidx ON "files"."quarantine" (company_id, sha256, origin_key);');
    await q('CREATE INDEX IF NOT EXISTS quarantine_pending_idx ON "files"."quarantine" (company_id, expires_at) WHERE status = \'QUARANTINED\';');
    await q('ALTER TABLE "files"."quarantine" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "files"."quarantine"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "files"."quarantine" FORCE ROW LEVEL SECURITY;');
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "files" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "files"."quarantine" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "files"."quarantine";');
  },
};
