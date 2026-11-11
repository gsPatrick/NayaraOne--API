'use strict';

/**
 * Pessoa do GRUPO, vista por VÍNCULO com a empresa (DI-M9I-1 a DI-M9I-6, Maturacao/demandas/decisoes-de-implementacao.md).
 *
 * Livro: TAB-0100 `persons` é o "Cadastro único PF/PJ usado por todos os módulos", com UNIQUE(group_id, tax_id_normalized);
 * TAB-0101 põe a empresa no papel ("Escopo quando aplicável"); CRMX-015 "Cliente pode ter relação com mais de uma empresa,
 * mas oportunidades/ofertas mantêm escopo correto"; §26 lê a pessoa por `company_scope_allows(company_id, app.company_id)`
 * (função de escopo), e reserva a comparação direta para "entidade [que] pertencer a uma única empresa".
 *
 * O que esta migration faz:
 * 1. `people.person_company_links`: a relação da pessoa com cada empresa do grupo (origem OWNER = empresa que cadastrou a base,
 *    LINKED = empresa que se vinculou depois; status ACTIVE/ENDED). UNIQUE(person_id, company_id) é o alvo das chaves
 *    compostas dos dados filhos (migration 20260101010941). Nada se apaga: desfazer é ENDED, com quem, quando e motivo.
 * 2. Todo cadastro novo ganha o vínculo OWNER no mesmo comando (gatilho AFTER INSERT, sem SECURITY DEFINER) e todas as pessoas
 *    que já existem ganham o vínculo OWNER com a empresa que as criou: nada muda para quem já usa.
 * 3. `persons_company_select` passa a ser: grupo do contexto E (empresa responsável [company_scope_allows] OU vínculo ACTIVE da
 *    empresa do contexto OU prova de conhecimento do vínculo em curso: CPF/CNPJ exato + nome que confere, informados pela sessão
 *    em app.vinculo_documento/app.vinculo_nome). Sem vínculo e sem prova, a pessoa de outra empresa não existe para a sessão.
 *    Escrita na base (INSERT/UPDATE/DELETE) continua só da empresa responsável.
 * 4. RLS do vínculo, deny-by-default: cada empresa lê só os PRÓPRIOS vínculos; o runtime insere OWNER só para pessoa da empresa
 *    do contexto e LINKED só para pessoa de outra empresa que esteja visível (ou seja, com a prova); atualiza só LINKED da própria
 *    empresa (encerrar ou reativar; reativar exige a prova de novo); nunca apaga.
 * 5. Auditoria no banco: todo INSERT/UPDATE de vínculo LINKED grava audit.audit_log (gatilho, mesma transação), com o usuário de
 *    app.user_id e o motivo de app.vinculo_motivo. O caminho da API e o SQL direto deixam o mesmo rastro.
 * 6. A empresa responsável não exclui nem mescla a base enquanto outra empresa do grupo tiver vínculo ACTIVE (gatilho com a
 *    função SECURITY DEFINER people.pessoa_vinculada_em_outra_empresa, search_path fixo, que só devolve verdadeiro/falso).
 */
const G = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const C = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const T = 'people.person_company_links';
const RUNTIME = ['nayara_runtime', 'nayara_ci', 'nayara_ci_app'];

// Prova de conhecimento do vínculo em curso: só abre UMA pessoa (CPF/CNPJ é único no grupo) e só para quem já sabe o nome.
const PROVA = `(tax_id_normalized IS NOT NULL AND ${C} IS NOT NULL
      AND tax_id_normalized = NULLIF(current_setting('app.vinculo_documento', true), '')
      AND people.chave_nome(legal_name) = people.chave_nome(NULLIF(current_setting('app.vinculo_nome', true), ''))
      AND deleted_at IS NULL AND status <> 'MERGED')`;
const VINCULO_ATIVO = `EXISTS (SELECT 1 FROM ${T} l WHERE l.person_id = persons.id AND l.company_id = ${C} AND l.status = 'ACTIVE')`;
const SELECT_NOVO = `group_id = ${G} AND (company_scope_allows(company_id, ${C}) OR ${VINCULO_ATIVO} OR ${PROVA})`;
const SELECT_ANTIGO = `group_id = ${G} AND company_scope_allows(company_id, ${C})`;

const ACENTOS_DE = 'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ';
const ACENTOS_PARA = 'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });

      // Alvo da chave (person_id, group_id) do vínculo: o vínculo é sempre do MESMO grupo da pessoa.
      await q('CREATE UNIQUE INDEX IF NOT EXISTS persons_id_group_id_key ON people.persons (id, group_id)');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS companies_id_group_id_key ON core.companies (id, group_id)');

      await q(`CREATE TABLE ${T} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL,
        company_id uuid NOT NULL,
        person_id uuid NOT NULL,
        origin varchar(10) NOT NULL CHECK (origin IN ('OWNER', 'LINKED')),
        status varchar(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
        linked_by uuid NULL,
        linked_at timestamptz NOT NULL DEFAULT now(),
        ended_by uuid NULL,
        ended_at timestamptz NULL,
        end_reason varchar(500) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT person_company_links_person_company_key UNIQUE (person_id, company_id),
        CONSTRAINT person_company_links_person_group_fkey FOREIGN KEY (person_id, group_id)
          REFERENCES people.persons (id, group_id) ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT person_company_links_company_group_fkey FOREIGN KEY (company_id, group_id)
          REFERENCES core.companies (id, group_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT person_company_links_ended_chk CHECK ((status = 'ENDED') = (ended_at IS NOT NULL)),
        CONSTRAINT person_company_links_owner_active_chk CHECK (origin = 'LINKED' OR status = 'ACTIVE')
      )`);
      await q(`CREATE INDEX person_company_links_company_active_idx ON ${T} (company_id, person_id) WHERE status = 'ACTIVE'`);

      // Chave do nome para a prova: primeiro e último nome, sem acento, caixa nem pontuação (mesmo critério do "nome semelhante"
      // da deduplicação, personDedup.service.nameFirstLastTokens). search_path fixo: o corpo não depende de quem chama.
      await q(`CREATE OR REPLACE FUNCTION people.chave_nome(p_nome text) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $f$
          SELECT CASE WHEN s.t IS NULL THEN NULL ELSE (string_to_array(s.t, ' '))[1] || '|' ||
                 (string_to_array(s.t, ' '))[array_length(string_to_array(s.t, ' '), 1)] END
            FROM (SELECT NULLIF(btrim(regexp_replace(lower(translate(p_nome, '${ACENTOS_DE}', '${ACENTOS_PARA}')), '[^a-z0-9]+', ' ', 'g')), '') AS t) s
        $f$`);

      // RLS do vínculo (deny-by-default: sem política de DELETE).
      await q(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
      await q(`CREATE POLICY person_company_links_select ON ${T} FOR SELECT USING (group_id = ${G} AND company_id = ${C})`);
      await q(`CREATE POLICY person_company_links_insert ON ${T} FOR INSERT WITH CHECK (
        group_id = ${G} AND company_id = ${C} AND status = 'ACTIVE' AND ended_at IS NULL AND (
          (origin = 'OWNER' AND EXISTS (SELECT 1 FROM people.persons p WHERE p.id = person_company_links.person_id AND p.company_id = ${C}))
          OR (origin = 'LINKED' AND EXISTS (SELECT 1 FROM people.persons p WHERE p.id = person_company_links.person_id AND p.company_id <> ${C}))
        ))`);
      // Reativar (status volta a ACTIVE) exige ver a pessoa SEM o próprio vínculo, que ainda está ENDED nesta checagem: só com a prova.
      await q(`CREATE POLICY person_company_links_update ON ${T} FOR UPDATE
        USING (group_id = ${G} AND company_id = ${C} AND origin = 'LINKED')
        WITH CHECK (group_id = ${G} AND company_id = ${C} AND origin = 'LINKED' AND (
          status = 'ENDED' OR EXISTS (SELECT 1 FROM people.persons p WHERE p.id = person_company_links.person_id)))`);
      // Só o dono das tabelas (quem roda a migration) conta vínculos de outras empresas, e só dentro da função de checagem abaixo.
      await q(`CREATE POLICY person_company_links_checagem_do_dono ON ${T} FOR SELECT TO CURRENT_USER USING (true)`);

      // Vínculo OWNER no mesmo comando do cadastro (qualquer caminho: API, importação, script, teste).
      await q(`CREATE OR REPLACE FUNCTION people.vinculo_da_empresa_responsavel() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
        BEGIN
          INSERT INTO people.person_company_links (group_id, company_id, person_id, origin, status, linked_by, linked_at)
          VALUES (NEW.group_id, NEW.company_id, NEW.id, 'OWNER', 'ACTIVE', NEW.created_by, COALESCE(NEW.created_at, now()))
          ON CONFLICT (person_id, company_id) DO NOTHING;
          RETURN NULL;
        END $f$`);
      await q(`CREATE TRIGGER persons_vinculo_da_empresa_responsavel AFTER INSERT ON people.persons
        FOR EACH ROW EXECUTE FUNCTION people.vinculo_da_empresa_responsavel()`);

      // Auditoria do vínculo LINKED no próprio banco (mesma transação de quem vincula, encerra ou reativa).
      await q(`CREATE OR REPLACE FUNCTION people.auditar_vinculo() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
        DECLARE
          v_acao text; v_user uuid; v_corr uuid; v_motivo text;
        BEGIN
          IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NULL; END IF;
          v_acao := CASE WHEN TG_OP = 'INSERT' AND NEW.status = 'ACTIVE' THEN 'people.person.link'
                         WHEN TG_OP = 'INSERT' THEN 'people.person.link_preserved'
                         WHEN NEW.status = 'ENDED' THEN 'people.person.unlink'
                         ELSE 'people.person.relink' END;
          v_user := CASE WHEN current_setting('app.user_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN current_setting('app.user_id', true)::uuid END;
          v_corr := CASE WHEN current_setting('app.correlation_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN current_setting('app.correlation_id', true)::uuid END;
          v_motivo := COALESCE(NULLIF(current_setting('app.vinculo_motivo', true), ''), CASE v_acao
            WHEN 'people.person.link' THEN 'Pessoa já cadastrada no grupo vinculada a esta empresa (CPF/CNPJ e nome conferidos).'
            WHEN 'people.person.unlink' THEN 'Vínculo da pessoa com esta empresa desfeito.'
            WHEN 'people.person.relink' THEN 'Vínculo da pessoa com esta empresa refeito (CPF/CNPJ e nome conferidos).'
            ELSE 'Vínculo registrado encerrado para preservar dado existente.' END);
          INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json,
                                       reason, occurred_at, correlation_id, created_by, updated_by, created_at, updated_at)
          VALUES (gen_random_uuid(), NEW.group_id, NEW.company_id, v_user, v_acao, 'Person', NEW.person_id,
                  CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('linkId', OLD.id, 'origin', OLD.origin, 'status', OLD.status) END,
                  jsonb_build_object('linkId', NEW.id, 'origin', NEW.origin, 'status', NEW.status),
                  v_motivo, clock_timestamp(), v_corr, v_user, v_user, now(), now());
          RETURN NULL;
        END $f$`);
      await q(`CREATE TRIGGER person_company_links_auditoria AFTER INSERT OR UPDATE ON ${T}
        FOR EACH ROW WHEN (NEW.origin = 'LINKED') EXECUTE FUNCTION people.auditar_vinculo()`);

      // Checagem de integridade (só verdadeiro/falso, nunca qual empresa): a base com vínculo ativo de outra empresa não some.
      await q(`CREATE OR REPLACE FUNCTION people.pessoa_vinculada_em_outra_empresa(p_person_id uuid, p_company_id uuid) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
          SELECT EXISTS (SELECT 1 FROM people.person_company_links l
                          WHERE l.person_id = p_person_id AND l.company_id <> p_company_id AND l.status = 'ACTIVE')
        $f$`);
      await q('REVOKE ALL ON FUNCTION people.pessoa_vinculada_em_outra_empresa(uuid, uuid) FROM PUBLIC');
      await q(`CREATE OR REPLACE FUNCTION people.base_vinculada_nao_some() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
        BEGIN
          IF (TG_OP = 'DELETE' OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) OR (NEW.status = 'MERGED' AND OLD.status <> 'MERGED'))
             AND people.pessoa_vinculada_em_outra_empresa(OLD.id, OLD.company_id) THEN
            RAISE EXCEPTION 'PERSON_LINKED_ELSEWHERE' USING ERRCODE = 'P0001',
              DETAIL = 'A pessoa tem vínculo ativo com outra empresa do grupo; o cadastro base não pode ser excluído nem mesclado.';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END $f$`);
      await q(`CREATE TRIGGER persons_base_vinculada_nao_some BEFORE UPDATE OF deleted_at, status OR DELETE ON people.persons
        FOR EACH ROW EXECUTE FUNCTION people.base_vinculada_nao_some()`);

      await q('GRANT EXECUTE ON FUNCTION people.chave_nome(text) TO PUBLIC');
      await q(`DO $$ DECLARE r text; BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN (${RUNTIME.map((x) => `'${x}'`).join(', ')}) LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ${T} TO %I', r);
          EXECUTE format('GRANT EXECUTE ON FUNCTION people.pessoa_vinculada_em_outra_empresa(uuid, uuid) TO %I', r);
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_analytics_reader') THEN
          GRANT SELECT ON ${T} TO nayara_analytics_reader;
        END IF;
      END $$`);

      // Todas as pessoas que já existem: vínculo OWNER com a empresa que as criou (inclusive excluídas e mescladas, que ainda têm
      // dado filho). Sem FORCE só durante a carga: o dono das tabelas não tem BYPASSRLS na homologação.
      await q('ALTER TABLE people.persons NO FORCE ROW LEVEL SECURITY');
      await q(`INSERT INTO ${T} (group_id, company_id, person_id, origin, status, linked_by, linked_at, created_at, updated_at)
        SELECT p.group_id, p.company_id, p.id, 'OWNER', 'ACTIVE', p.created_by, p.created_at, now(), now() FROM people.persons p
        ON CONFLICT (person_id, company_id) DO NOTHING`);
      await q('ALTER TABLE people.persons FORCE ROW LEVEL SECURITY');
      await q(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);

      await q('DROP POLICY IF EXISTS persons_company_select ON people.persons');
      await q(`CREATE POLICY persons_company_select ON people.persons FOR SELECT USING (${SELECT_NOVO})`);
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP POLICY IF EXISTS persons_company_select ON people.persons');
      await q(`CREATE POLICY persons_company_select ON people.persons FOR SELECT USING (${SELECT_ANTIGO})`);
      await q('DROP TRIGGER IF EXISTS persons_base_vinculada_nao_some ON people.persons');
      await q('DROP TRIGGER IF EXISTS persons_vinculo_da_empresa_responsavel ON people.persons');
      await q(`DROP TABLE IF EXISTS ${T}`);
      await q('DROP FUNCTION IF EXISTS people.base_vinculada_nao_some()');
      await q('DROP FUNCTION IF EXISTS people.pessoa_vinculada_em_outra_empresa(uuid, uuid)');
      await q('DROP FUNCTION IF EXISTS people.auditar_vinculo()');
      await q('DROP FUNCTION IF EXISTS people.vinculo_da_empresa_responsavel()');
      await q('DROP FUNCTION IF EXISTS people.chave_nome(text)');
      await q('DROP INDEX IF EXISTS core.companies_id_group_id_key');
      await q('DROP INDEX IF EXISTS people.persons_id_group_id_key');
    });
  },
};
