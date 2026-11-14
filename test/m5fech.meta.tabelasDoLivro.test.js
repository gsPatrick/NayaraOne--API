'use strict';

/**
 * Marco 5, caderno §4 ("Entidades/tabelas obrigatórias"): inventário das 21 tabelas do livro no
 * banco migrado do zero. Para cada nome do livro que existe: tabela física (relkind r), com
 * company_id e RLS ENABLE + FORCE. Também confere que os nomes antigos (renomeados para o nome do
 * livro, M5-D102/M5-D221) não existem mais como tabela e que finance.utility_obligations ficou só
 * como visão de legal.lease_obligations.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('./testHelpers');

after(async () => {
  await sequelize.close();
});

const COM_NOME_DO_LIVRO = [
  'contracts', 'contract_versions', 'contract_parties', 'contract_templates', 'template_versions', 'clause_library', 'clause_versions',
  'contract_requirements', 'signatures', 'addenda',
  'guarantees', 'key_deliveries', 'inspections', 'inspection_items', 'inspection_media', 'lease_obligations', 'notices', 'legal_cases', 'case_parties', 'legal_deadlines', 'evidence_packages',
];

async function info(qualificado) {
  const [[row]] = await sequelize.query(
    `SELECT c.relkind::text AS tipo, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped) AS company
       FROM pg_class c WHERE c.oid = to_regclass(:q)`,
    { replacements: { q: qualificado } }
  );
  return row || null;
}

for (const nome of COM_NOME_DO_LIVRO) {
  test(`§4 tabela do livro legal.${nome}: existe com o nome do livro, é tabela, tem company_id e RLS ENABLE+FORCE`, async () => {
    const r = await info(`legal.${nome}`);
    assert.ok(r, `legal.${nome} não existe`);
    assert.equal(r.tipo, 'r');
    assert.equal(r.company, true);
    assert.equal(r.rls, true);
    assert.equal(r.force, true);
  });
}

test('§4 nomes antigos: contract_amendments, legal_case_parties e contract_clauses não existem; finance.utility_obligations é só visão', async () => {
  for (const antigo of ['legal.contract_amendments', 'legal.legal_case_parties', 'legal.contract_clauses']) {
    assert.equal(await info(antigo), null, `${antigo} ainda existe`);
  }
  const visao = await info('finance.utility_obligations');
  assert.ok(visao, 'finance.utility_obligations deveria existir como visão');
  assert.equal(visao.tipo, 'v');
});
