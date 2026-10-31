'use strict';

// Marco 9, M9-D242 (reabertura R3-L2) — endpoint S3 em IPv6 literal de rede própria: recusado já na gravação da conexão (422), não só na execução (ERR_INVALID_URL).
// Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, withRollbackTenantTransaction } = require('../../testHelpers');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { s3ConfigProblems, s3Target } = require('../../../src/features/integrations/providers/storage/storage.s3.target');
const { setupEnv, teardownEnv, novaConexao } = require('../../helpers/integrationsRegistryEnv');

let tenant;
let ctx;
before(async () => { ({ tenant, ctx } = await setupEnv()); });
after(async () => { await teardownEnv(tenant); await sequelize.close(); });

const s3 = (endpoint, extra = {}) => novaConexao({ providerCode: 'storage-s3', configJson: { endpoint, bucket: 'nayara-docs', pathStyle: true, ...extra } });
const IPV6 = ['fd00::5', 'fd12:3456:789a::1', '2001:db8::10', 'fe80::1', 'fd00:0:0:0:0:0:0:5'];

test('s3_endpoint_ipv6_literal_e_recusado_na_gravacao_mesmo_liberado_como_rede_propria', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('integration.egress.private_hosts', 'storage-s3:minio.empresa.lan,10.0.0.5,fd00::5,fd12:3456:789a::1', tenant, tenant.userId, t, { platform: true });
    for (const endpoint of IPV6) {
      await assert.rejects(registry.createConnection(s3(endpoint), ctx, t), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', endpoint);
    }
    // o IPv4 e o nome da rede própria liberados seguem aceitos
    assert.ok((await registry.createConnection(s3('10.0.0.5'), ctx, t)).id);
    assert.ok((await registry.createConnection(s3('minio.empresa.lan'), ctx, t)).id);
  });
});

test('s3_endpoint_ipv6_nunca_vira_url_invalida_na_execucao', () => {
  for (const endpoint of IPV6) {
    const config = { endpoint, bucket: 'nayara-docs', pathStyle: true };
    const problemas = s3ConfigProblems(config, { privateHosts: IPV6 });
    assert.ok(problemas.some((p) => p.startsWith('endpoint:')), endpoint);
    assert.throws(() => s3Target(config, 'k', { privateHosts: IPV6 }), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', endpoint);
  }
  for (const endpoint of IPV6) assert.ok(s3ConfigProblems({ endpoint: `[${endpoint}]`, bucket: 'nayara-docs', pathStyle: true }, { privateHosts: [`[${endpoint}]`] }).length, `[${endpoint}]`);
});
