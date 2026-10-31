'use strict';

// Marco 9, M9-D244 (reabertura da rodada 2: N7) — S3 em rede própria (MinIO em .lan, .internal ou IP) só com o parâmetro da empresa
// integration.egress.private_hosts; mesma política de destino para tudo o mais. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, withRollbackTenantTransaction } = require('../../testHelpers');
const registry = require('../../../src/features/integrations/registry/registry.service');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { IntegrationConnection } = require('../../../src/models');
const { setupEnv, teardownEnv, novaConexao } = require('../../helpers/integrationsRegistryEnv');

let tenant;
let ctx;
before(async () => { ({ tenant, ctx } = await setupEnv()); registerBuiltInAdapters(); });
after(async () => { await teardownEnv(tenant); await sequelize.close(); });

const KEY = 'integration.egress.private_hosts';
const recusa = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });
const salvar = (t, v) => upsertSetting(KEY, v, tenant, tenant.userId, t, { platform: true });
const s3 = (endpoint, extra = {}) => novaConexao({ providerCode: 'storage-s3', configJson: { endpoint, bucket: 'nayara-docs', pathStyle: true, ...extra } });

test('n7_parametro_valida_formato_e_nunca_aceita_loopback_metadados_curinga_nem_porta', async () => {
  for (const ruim of ['sem-formato', 'storage-s3:', 'storage-s3:127.0.0.1', 'storage-s3:169.254.169.254', 'storage-s3:localhost', 'storage-s3:*.lan', 'storage-s3:https://minio.lan',
    'storage-s3:minio.lan:9000', 'storage-s3:minio.lan/x', 'storage-s3:0.0.0.0', 'storage-s3:224.0.0.1', 'storage-s3:::1', 'storage-s3:2130706433', 'storage-s3:127.1']) {
    await assert.rejects(withRollbackTenantTransaction(tenant, (t) => salvar(t, ruim)), (e) => e.code === 'SETTING_INVALID_VALUE', ruim);
  }
  await withRollbackTenantTransaction(tenant, (t) => salvar(t, 'storage-s3:minio.empresa.lan,10.0.0.5,192.168.1.20,armazenamento.internal'));
});

test('n7_sem_o_parametro_s3_em_rede_propria_continua_recusado_e_com_ele_so_o_host_listado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const endpoint of ['minio.empresa.lan', '10.0.0.5', 'armazenamento.internal']) await recusa(registry.createConnection(s3(endpoint), ctx, t), 'INTEGRATION_CONFIG_INVALID');
    await salvar(t, 'storage-s3:minio.empresa.lan,10.0.0.5');
    assert.ok((await registry.createConnection(s3('minio.empresa.lan'), ctx, t)).id);
    assert.ok((await registry.createConnection(s3('10.0.0.5'), ctx, t)).id);
    await recusa(registry.createConnection(s3('10.0.0.6'), ctx, t), 'INTEGRATION_CONFIG_INVALID'); // outro IP da mesma rede
    await recusa(registry.createConnection(s3('armazenamento.internal'), ctx, t), 'INTEGRATION_CONFIG_INVALID'); // nome interno não listado
    await recusa(registry.createConnection(s3('minio.empresa.lan', { pathStyle: false }), ctx, t), 'INTEGRATION_CONFIG_INVALID'); // rede própria exige pathStyle
    await recusa(registry.createConnection(novaConexao({ providerCode: 'signature-clicksign', configJson: { baseUrl: 'https://minio.empresa.lan/api' } }), ctx, t), 'INTEGRATION_CONFIG_INVALID'); // vale só para o fornecedor nomeado
  });
});

test('n7_execucao_confere_de_novo_e_a_conexao_prende_o_endereco_na_rede_propria', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await salvar(t, 'storage-s3:minio.empresa.lan,10.0.0.5');
    const c = await registry.createConnection(s3('minio.empresa.lan'), ctx, t);
    const adaptar = async () => adapterRegistry.resolve(await IntegrationConnection.findByPk(c.id, { transaction: t }), ctx, t);
    const a = await adaptar();
    assert.deepEqual(a.target(a.ctx, 'k'), { host: 'minio.empresa.lan', path: '/nayara-docs/k', region: 'us-east-1' });
    // O host listado passa pela política de destino com o endereço da rede própria fixado; outro host da mesma rede não.
    a.ctx.http.resolver = async () => [{ address: '10.1.2.3', family: 4 }];
    const d = await a.ctx.http.guard('https://minio.empresa.lan/nayara-docs/k', 'PUT');
    assert.deepEqual(d.pin, { address: '10.1.2.3', family: 4 });
    await recusa(a.ctx.http.guard('https://outro.empresa.lan/x', 'PUT'), 'INTEGRATION_EGRESS_BLOCKED');
    // Mesmo listado, o nome que resolve para loopback ou metadados da nuvem é recusado.
    for (const address of ['127.0.0.1', '169.254.169.254', '0.0.0.0']) {
      a.ctx.http.resolver = async () => [{ address, family: 4 }];
      await recusa(a.ctx.http.guard('https://minio.empresa.lan/x', 'PUT'), 'INTEGRATION_EGRESS_BLOCKED');
    }
    // IP literal listado fica preso a si mesmo; o parâmetro apagado derruba a execução (a conexão antiga não vale mais).
    const ip = await registry.createConnection(s3('10.0.0.5'), ctx, t);
    const b = await adapterRegistry.resolve(await IntegrationConnection.findByPk(ip.id, { transaction: t }), ctx, t);
    assert.deepEqual((await b.ctx.http.guard('https://10.0.0.5/nayara-docs/k', 'GET')).pin, { address: '10.0.0.5', family: 4 });
    await salvar(t, 'signature-zapsign:outro.empresa.lan');
    const sem = await adapterRegistry.resolve(await IntegrationConnection.findByPk(ip.id, { transaction: t }), ctx, t);
    assert.throws(() => sem.target(sem.ctx, 'k'), (e) => e.code === 'INTEGRATION_CONFIG_INVALID');
    await recusa(sem.ctx.http.guard('https://10.0.0.5/nayara-docs/k', 'GET'), 'INTEGRATION_EGRESS_BLOCKED');
  });
});
