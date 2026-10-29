'use strict';

/**
 * M9-D699 (3.2) — o fluxo operacional (OLTP) simulado: criar lançamento, liquidar, mover oportunidade e apontar relatório de obra. Cada
 * operação roda numa transação da aplicação com o contexto de empresa/usuário (RLS real do role de runtime, SET LOCAL app.*), pelo mesmo
 * caminho que a camada de serviço usa para chegar às tabelas, com os gatilhos de auditoria ligados. As escolhas de linha são determinísticas
 * pela semente (chave primária), então o custo da operação não depende de varredura. Não usa serviço de domínio porque os serviços exigem
 * aprovação, MFA e competência aberta, que não são carga (DI-D699-1).
 */
const crypto = require('node:crypto');

const uuidOf = (seed, kind, companyId, n) => crypto.createHash('md5').update(`${seed}:${kind}:${companyId}:${n}`).digest('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

async function inTenant(sequelize, tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
      replacements: { g: tenant.groupId, c: tenant.companyId, u: tenant.userId }, transaction,
    });
    return fn(transaction);
  });
}

/** `ctx`: { sequelize, seed, sizes, rnd } — rnd() em [0,1) determinístico por usuário simulado. */
function createOps({ sequelize, seed, sizes, rnd }) {
  const pick = (n) => 1 + Math.floor(rnd() * n);
  return {
    criar_lancamento: (tenant) => inTenant(sequelize, tenant, (transaction) => sequelize.query(
      `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, due_at, competence_month)
       VALUES (gen_random_uuid(), :g, :c, 'DEBIT', 'PAYABLE', :amount, 'PENDING', now() + interval '10 days', to_char(now(), 'YYYY-MM'))`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, amount: (pick(500000) / 100).toFixed(2) }, transaction }
    )),
    liquidar_lancamento: (tenant) => inTenant(sequelize, tenant, (transaction) => {
      let g = pick(sizes.entries);
      g = g - (g % 10) + 6 + (g % 3); // faixa dos lançamentos pendentes da massa (g % 10 de 6 a 8)
      return sequelize.query(
        "UPDATE finance.financial_entries SET status = 'SETTLED', settled_at = now(), updated_at = now() WHERE id = :id AND company_id = :c AND status = 'PENDING'",
        { replacements: { id: uuidOf(seed, 'entry', tenant.companyId, Math.max(g, 6)), c: tenant.companyId }, transaction }
      );
    }),
    mover_oportunidade: (tenant) => inTenant(sequelize, tenant, (transaction) => sequelize.query(
      "UPDATE crm.opportunities SET stage = (ARRAY['CONTACTED', 'VISIT', 'PROPOSAL'])[1 + floor(random() * 3)::int], updated_at = now() WHERE id = :id AND company_id = :c",
      { replacements: { id: uuidOf(seed, 'opp', tenant.companyId, pick(sizes.opportunities)), c: tenant.companyId }, transaction }
    )),
    apontar_relatorio: (tenant) => inTenant(sequelize, tenant, (transaction) => sequelize.query(
      'INSERT INTO construction.daily_reports (id, group_id, company_id, project_id, report_date) VALUES (gen_random_uuid(), :g, :c, :p, CURRENT_DATE) ON CONFLICT DO NOTHING',
      { replacements: { g: tenant.groupId, c: tenant.companyId, p: uuidOf(seed, 'project', tenant.companyId, pick(sizes.projects)) }, transaction }
    )),
  };
}

const OP_NAMES = Object.freeze(['criar_lancamento', 'liquidar_lancamento', 'mover_oportunidade', 'apontar_relatorio']);

module.exports = { createOps, OP_NAMES, uuidOf, inTenant };
