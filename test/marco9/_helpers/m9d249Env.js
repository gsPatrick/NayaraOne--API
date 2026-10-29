'use strict';

// Apoio dos testes das APIs administrativas de leitura das integrações (M9-D249). Roda em banco descartável (os testes COMMITAM).
// Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste, que escuta nessa porta).
require('../../../app');
const { sequelize, carregarTenants, ctxDe, comTenant, conexao } = require('../../integrations/dispatch/dispatchHelpers');
const { signAccessToken } = require('../../../src/utils/jwt');

const tokenDe = (tenant, permissions) => signAccessToken({
  sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions,
});

/** Chamador HTTP real contra o app de teste. Devolve { status, corpo }. */
function chamador() {
  const base = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  return async (token, method, caminho, body) => {
    const res = await fetch(`${base}${caminho}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const texto = await res.text();
    let corpo = null;
    try { corpo = JSON.parse(texto); } catch { corpo = texto; }
    return { status: res.status, corpo };
  };
}

const sql = (tenant, consulta, replacements = {}) => comTenant(tenant, async (t) => (await sequelize.query(consulta, { replacements, transaction: t }))[0]);

/** Conexão do domínio com a referência de segredo informada (gravada direto, a validação do cadastro é testada em outro lugar). */
async function conexaoComSegredo(tenant, domain, secretRef, extra = '') {
  const c = await conexao(tenant, domain);
  await sql(tenant, `UPDATE integration.connections SET secret_ref = :r ${extra} WHERE id = :id`, { r: secretRef, id: c.id });
  return c;
}

/** Linha de janela agregada de provider_health (5, 60 ou 1440 minutos), com métricas dadas. */
async function janela(tenant, conn, { minutos, inicio, total, sucesso, p95 = 100, p99 = 200, extras = {} }) {
  const m = { rate_limit_count: 0, auth_failures: 0, retries_total: 0, dlq_count: 0, backlog_count: 0, ...extras };
  await sql(tenant, `INSERT INTO integration.provider_health
      (group_id, company_id, connection_id, provider_code, window_start, window_minutes, calls_total, calls_success, calls_failed, success_rate,
       latency_p95_ms, latency_p99_ms, rate_limit_count, auth_failures, retries_total, dlq_count, backlog_count)
    VALUES (:g, :c, :id, :p, :ini, :min, :tot, :ok, :bad, :rate, :p95, :p99, :rl, :af, :rt, :dlq, :bl)`,
  { g: tenant.groupId, c: tenant.companyId, id: conn.id, p: conn.providerCode, ini: inicio, min: minutos, tot: total, ok: sucesso, bad: total - sucesso,
    rate: total ? Math.round((sucesso / total) * 10000) / 100 : null, p95, p99, rl: m.rate_limit_count, af: m.auth_failures, rt: m.retries_total, dlq: m.dlq_count, bl: m.backlog_count });
}

module.exports = { sequelize, carregarTenants, ctxDe, comTenant, conexao, conexaoComSegredo, tokenDe, chamador, sql, janela };
