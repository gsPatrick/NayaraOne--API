'use strict';

const { randomUUID } = require('crypto');

/**
 * Deduplicação de Pessoas no grupo e exceção auditada do match médio (M3-03 / CAD-04 / CRMX-010; DI-M3PE-3 e DI-M3PE-4).
 *
 * Livro §4: "Match forte bloqueia criação e oferece cadastro existente"; "Match médio: telefone/e-mail iguais"; Guia §3 deduplica por
 * ctx.groupId. Depois do isolamento por empresa (DI-ISO-PESSOAS-1, DI-M9I-1) a sessão não enxerga as pessoas e os contatos das outras
 * empresas do grupo. Duas funções do banco respondem só VERDADEIRO ou FALSO, nunca qual pessoa nem qual empresa, sempre para o grupo e a
 * empresa do contexto (app.group_id / app.company_id, nunca um parâmetro de quem chama):
 *   - people.documento_no_grupo(cpf_cnpj): há cadastro com este CPF/CNPJ em OUTRA empresa do grupo;
 *   - people.contato_no_grupo(tipo, chave, ddi): há contato com esta chave (e-mail em minúsculas e sem espaço; telefone com DDI) no
 *     cadastro de uma pessoa de OUTRA empresa do grupo. A chave do lado do banco é a mesma de src/features/people/personContactKey.js.
 * As duas são SECURITY DEFINER com search_path fixo. Como as tabelas têm FORCE RLS e o dono não tem BYPASSRLS na homologação, o dono
 * ganha a leitura das duas tabelas SÓ para si (TO CURRENT_USER, mesmo padrão de person_company_links_checagem_do_dono da 0940); o
 * runtime continua com as políticas por empresa.
 *
 * Também cria a permissão `people:dedup:override` (risco HIGH, concedida ao ADMIN): criar mesmo com o match médio é exceção, com motivo
 * e auditoria (people.person.duplicate_override).
 */
const RUNTIME = ['nayara_runtime', 'nayara_ci', 'nayara_ci_app'];
const CODE = 'people:dedup:override';
const G = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const C = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const DIGITOS = "regexp_replace(c.value_normalized, '[^0-9]', '', 'g')";
const CHAVE = `(CASE WHEN upper(c.contact_type) = 'EMAIL' THEN lower(regexp_replace(c.value_normalized, '\\s', '', 'g'))
  WHEN btrim(c.value_normalized) LIKE '+%' OR length(${DIGITOS}) > 11 THEN ${DIGITOS} ELSE p_ddi || ${DIGITOS} END)`;
// Pessoa que esta empresa já enxerga por vínculo ativo não é "de outra empresa": ela aparece na busca da própria empresa.
const SEM_VINCULO = `NOT EXISTS (SELECT 1 FROM people.person_company_links l WHERE l.person_id = p.id AND l.company_id = ${C} AND l.status = 'ACTIVE')`;
const TIPO = "(CASE WHEN upper(c.contact_type) = 'EMAIL' THEN 'EMAIL' ELSE 'PHONE' END)";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('CREATE POLICY persons_checagem_do_dono ON people.persons FOR SELECT TO CURRENT_USER USING (true)');
      await q('CREATE POLICY person_contacts_checagem_do_dono ON people.person_contacts FOR SELECT TO CURRENT_USER USING (true)');

      await q(`CREATE OR REPLACE FUNCTION people.documento_no_grupo(p_tax text) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
          SELECT ${G} IS NOT NULL AND ${C} IS NOT NULL AND EXISTS (
            SELECT 1 FROM people.persons p
             WHERE p.group_id = ${G} AND p.company_id <> ${C} AND p.tax_id_normalized = p_tax AND p.deleted_at IS NULL AND p.status <> 'MERGED' AND ${SEM_VINCULO})
        $f$`);
      await q(`CREATE OR REPLACE FUNCTION people.contato_no_grupo(p_tipo text, p_chave text, p_ddi text) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
          SELECT ${G} IS NOT NULL AND ${C} IS NOT NULL AND p_chave IS NOT NULL AND EXISTS (
            SELECT 1 FROM people.person_contacts c JOIN people.persons p ON p.id = c.person_id
             WHERE c.group_id = ${G} AND c.company_id <> ${C} AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status <> 'MERGED'
               AND ${SEM_VINCULO} AND ${TIPO} = p_tipo AND ${CHAVE} = p_chave)
        $f$`);
      for (const fn of ['people.documento_no_grupo(text)', 'people.contato_no_grupo(text, text, text)']) {
        await q(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
        await q(`DO $$ DECLARE r text; BEGIN
          FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN (${RUNTIME.map((x) => `'${x}'`).join(', ')}) LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION ${fn} TO %I', r);
          END LOOP;
        END $$`);
      }
    });

    const now = new Date();
    await queryInterface.bulkInsert(
      { tableName: 'permissions', schema: 'core' },
      [{ id: randomUUID(), code: CODE, description: 'Criar um cadastro de pessoa mesmo com o mesmo telefone ou e-mail de outro (exceção da deduplicação, com motivo e auditoria).', risk_level: 'HIGH', created_at: now, updated_at: now }],
      { ignoreDuplicates: true }
    );
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await sequelize.query(`
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN' AND p.code = :code
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
      `, { replacements: { code: CODE } });
    } finally {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = :code)', { replacements: { code: CODE } });
    await sequelize.query('DELETE FROM core.permissions WHERE code = :code', { replacements: { code: CODE } });
    await sequelize.query('DROP FUNCTION IF EXISTS people.contato_no_grupo(text, text, text)');
    await sequelize.query('DROP FUNCTION IF EXISTS people.documento_no_grupo(text)');
    await sequelize.query('DROP POLICY IF EXISTS person_contacts_checagem_do_dono ON people.person_contacts');
    await sequelize.query('DROP POLICY IF EXISTS persons_checagem_do_dono ON people.persons');
  },
};
