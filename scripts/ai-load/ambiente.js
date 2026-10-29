'use strict';

/** M9-D046 — apoio da carga: transação REAL (commit) com o contexto do tenant, para simular conexões concorrentes, e as pessoas de cada empresa. */
const F = require('../../test/marco9/_helpers/advFixtures');

function comoTenant(tenant, fn) {
  return F.sequelize.transaction(async (transaction) => {
    await F.sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await F.sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await F.sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

/** Usuários reais do seed (a trilha de auditoria tem FK para core.users), sem o dono da empresa; `n` por empresa, sem repetir entre empresas. */
async function pessoasDistintas(tenants, n) {
  const rows = await F.q('SELECT id FROM core.users ORDER BY email LIMIT 40');
  const livres = rows.map((r) => r.id);
  return tenants.map((t, i) => livres.filter((id) => id !== t.userId).slice(i * n, (i + 1) * n));
}

module.exports = { comoTenant, pessoasDistintas, F };
