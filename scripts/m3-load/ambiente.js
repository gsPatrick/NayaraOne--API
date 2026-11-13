'use strict';

/**
 * Apoio da carga do Marco 3 (scripts/loadTestMarco3.js): as duas empresas do banco descartável (A = seed de desenvolvimento, B = empresa
 * fictícia B do seed-ci-two-tenants, de OUTRO grupo), transação REAL (commit) com o contexto do tenant para simular conexões concorrentes,
 * um executor com limite de concorrência e um gerador de CPF com dígitos verificadores válidos.
 */
const { sequelize, getSeedTenant } = require('../../test/testHelpers');

function comoTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

/** Consulta SQL dentro do contexto do tenant (RLS da role de runtime); devolve as linhas. */
async function sqlComo(tenant, sql, replacements = {}) {
  return comoTenant(tenant, async (transaction) => (await sequelize.query(sql, { replacements, transaction }))[0]);
}

async function empresas() {
  const tenantA = await getSeedTenant();
  const [[grupoB]] = await sequelize.query("SELECT id FROM core.groups WHERE name = 'CI — Grupo Fictício B'");
  if (!grupoB) throw new Error('Empresa B do seed de CI não encontrada: rode node scripts/seed-ci-two-tenants.js antes da carga.');
  const empresaB = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupoB.id }, transaction });
    const [[c]] = await sequelize.query("SELECT id FROM core.companies WHERE name = 'CI — Empresa Fictícia B'", { transaction });
    return c;
  });
  if (!empresaB) throw new Error('Empresa fictícia B sem company: rode node scripts/seed-ci-two-tenants.js antes da carga.');
  return { tenantA, tenantB: { groupId: grupoB.id, companyId: empresaB.id, userId: tenantA.userId } };
}

/** Roda `tarefas` (funções sem argumento) com no máximo `limite` ao mesmo tempo; devolve { ok, valor | erro } na ordem original. */
async function emParalelo(tarefas, limite) {
  const resultados = new Array(tarefas.length);
  let proxima = 0;
  async function trabalhador() {
    while (proxima < tarefas.length) {
      const i = proxima;
      proxima += 1;
      const t0 = Date.now();
      try { resultados[i] = { ok: true, valor: await tarefas[i](), ms: Date.now() - t0 }; } catch (erro) { resultados[i] = { ok: false, erro, ms: Date.now() - t0 }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, tarefas.length)) }, trabalhador));
  return resultados;
}

/** CPF com os dois dígitos verificadores corretos, a partir de uma semente numérica (9 primeiros dígitos). */
function cpfValido(semente) {
  const base = String(Math.abs(Number(semente)) % 1e9).padStart(9, '1').split('').map(Number);
  if (base.every((d) => d === base[0])) base[8] = (base[8] + 1) % 10;
  const dv = (digitos) => {
    const soma = digitos.reduce((s, d, i) => s + d * (digitos.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}

module.exports = { sequelize, comoTenant, sqlComo, empresas, emParalelo, cpfValido };
