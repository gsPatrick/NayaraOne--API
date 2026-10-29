'use strict';

// Processo filho dos testes de circuito (M9-D217): outra instância da API contra o mesmo banco. Uso: node circuitChild.js <falhar|ler> <groupId> <companyId> <connectionId> [n]
const { sequelize, IntegrationConnection } = require('../../../src/models');
const breaker = require('../../../src/features/integrations/health/circuitBreaker');

async function main() {
  const [modo, groupId, companyId, connectionId, n] = process.argv.slice(2);
  const ctx = { groupId, companyId };
  const tx = async (fn) => sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction: t });
    return fn(t);
  });
  if (modo === 'falhar') {
    for (let i = 0; i < Number(n); i += 1) {
      await tx(async (t) => breaker.recordCallResult(await IntegrationConnection.findByPk(connectionId, { transaction: t }), ctx, t, { ok: false, errorClass: 'TRANSIENT' }));
    }
  } else {
    const [rows] = await tx((t) => sequelize.query('SELECT circuit_state, consecutive_failures FROM integration.provider_health WHERE connection_id = :id AND window_minutes = 0', { replacements: { id: connectionId }, transaction: t }));
    process.stdout.write(`ESTADO:${JSON.stringify(rows[0])}\n`);
  }
  await sequelize.close();
}
main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
