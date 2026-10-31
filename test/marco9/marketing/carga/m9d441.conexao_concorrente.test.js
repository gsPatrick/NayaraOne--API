'use strict';

// M9-D441 carga: pedidos simultâneos que acham o canal sem conexão criam a conexão do laboratório uma só vez e TODOS recebem a mesma (antes, o segundo batia no nome já em uso,
// INTEGRATION_CONNECTION_DUPLICATE_LABEL, e o agendamento ou o job se perdia). COMMIT real: só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const { resolveChannelConnection } = require('../../../../src/features/marketing/publications/schedule/schedule.connection');
const carga = require('../../_helpers/mktCarga');

const PEDIDOS = 6;
let tenant;
const apagarConexoes = () => carga.withAdmin(async (admin) => {
  await admin.query("DELETE FROM integration.connections WHERE company_id = $1 AND provider_code = 'portal-sandbox'", [tenant.companyId]);
});
before(async () => {
  if (!carga.DISPOSABLE) return;
  ({ tenantB: tenant } = await prepararTenants());
  await apagarConexoes();
});
after(async () => {
  if (carga.DISPOSABLE && tenant) await apagarConexoes().catch(() => null);
  await sequelize.close();
});

test('conexao_do_canal_criada_uma_vez_sob_pedidos_simultaneos', { skip: carga.SKIP }, async (tctx) => {
  const resultados = await Promise.allSettled(Array.from({ length: PEDIDOS }, () => withTenantTransaction(tenant, (t) => resolveChannelConnection({ tenant, actor: tenant.userId, channel: 'PORTAL', transaction: t }))));
  const falhas = resultados.filter((r) => r.status === 'rejected').map((r) => r.reason && (r.reason.code || r.reason.message));
  assert.deepEqual(falhas, [], 'nenhum pedido perdido (MKT_LOAD_INVARIANT_BROKEN)');
  const ids = new Set(resultados.map((r) => r.value.id));
  assert.equal(ids.size, 1, 'todos recebem a mesma conexão');
  const [linhas] = await carga.withAdmin((admin) => admin.query("SELECT count(*)::int AS n FROM integration.connections WHERE company_id = $1 AND provider_code = 'portal-sandbox'", [tenant.companyId]).then((r) => [r.rows]));
  assert.equal(linhas[0].n, 1, 'uma só conexão criada');
  tctx.diagnostic(`${PEDIDOS} pedidos simultâneos: 1 conexão criada, ${ids.size} id distinto, 0 falhas`);
});
