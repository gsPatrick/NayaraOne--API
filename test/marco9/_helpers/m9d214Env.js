'use strict';

// Apoio dos testes do Dispatch Service (M9-D214, M9-D216, M9-D218): conexões ATIVAS, limpeza de pendências de outros testes,
// adapter programável (respostas e erros em fila) e leitura direta das linhas. Roda em banco descartável (os testes COMMITAM).
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, forcar, ler, uniqueSuffix, dispatch } = require('../../integrations/dispatch/dispatchHelpers');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const settingsService = require('../../../src/features/settings/settings.service');

/** Cria a conexão do domínio e a deixa ACTIVE, desativando a que já estivesse ativa do mesmo fornecedor. */
async function conexaoAtiva(tenant, domain) {
  const c = await conexao(tenant, domain);
  await comTenant(tenant, async (t) => {
    await sequelize.query(
      `UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE' AND id <> :id`,
      { replacements: { c: tenant.companyId, p: c.providerCode, id: c.id }, transaction: t },
    );
    await transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t);
  });
  return c;
}

/** Cancela o que outros testes deixaram vencido, para a rodada do worker só pegar os envios do teste. */
async function limparPendentes(tenant) {
  await comTenant(tenant, (t) => sequelize.query(
    `UPDATE integration.dispatches SET status = 'CANCELLED' WHERE company_id = :c AND status IN ('PENDING', 'RETRY_WAIT', 'SENDING')`,
    { replacements: { c: tenant.companyId }, transaction: t },
  ));
}

/** Enfileira (commit) e devolve o recibo. */
const enfileirar = (tenant, args) => comTenant(tenant, (t) => dispatch.enqueue({ companyId: tenant.companyId, userId: tenant.userId, ...args, transaction: t }));

const pagamento = (over = {}) => ({ amount: 1250.5, currency: 'BRL', beneficiary: { name: 'Fulano de Tal', document: '123.456.789-09', account: '0001/12345-6' }, description: 'Pagamento QA-M9', ...over });

const tentativas = (tenant, id) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM integration.dispatch_attempts WHERE dispatch_id = :id ORDER BY attempt_no, started_at', { replacements: { id }, transaction: t },
))[0]);

const eventos = (tenant, tipo, id) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM integration.outbox_events WHERE event_type = :tipo AND idempotency_key = :k', { replacements: { tipo, k: `${tipo}:${id}` }, transaction: t },
))[0]);

const config = (tenant, chave, valor) => comTenant(tenant, (t) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t));

/** Zera um parâmetro da empresa (volta ao padrão). */
const limparConfig = (tenant, chaves) => comTenant(tenant, (t) => sequelize.query(
  'DELETE FROM core.tenant_settings WHERE company_id = :c AND key IN (:k)', { replacements: { c: tenant.companyId, k: chaves }, transaction: t },
).catch(() => null));

/**
 * Troca o adapter registrado de um fornecedor por uma classe programável. `Classe.script(op)` devolve a fila de passos da operação;
 * cada passo é { resposta } ou { erro } (consumido na ordem; o último se repete se `repetir`). `Classe.chamadas` guarda o que chegou.
 */
function instalar(Classe) {
  const info = new Classe(null);
  adapterRegistry.unregister(info.providerCode());
  adapterRegistry.register(Classe);
}
const restaurar = () => { ['bank-sandbox', 'messaging-sandbox', 'portal-sandbox'].forEach((c) => adapterRegistry.unregister(c)); return registerBuiltInAdapters(); };

const erros = (tenant, connectionId, errorCode) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM integration.integration_errors WHERE connection_id = :c AND error_code = :k ORDER BY created_at', { replacements: { c: connectionId, k: errorCode }, transaction: t },
))[0]);

/** Roda uma rodada do worker e depois deixa o envio vencido de novo (para encadear tentativas sem esperar o relógio). */
async function rodarEVencer(tenant, id, now = new Date()) {
  const resumo = await dispatch.runDispatchCycle(ctxDe(tenant), { now });
  await forcar(tenant, id, "next_attempt_at = now() - interval '1 second'");
  return resumo;
}

module.exports = {
  erros, rodarEVencer, sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, pagamento, tentativas, eventos, config, limparConfig,
  instalar, restaurar, forcar, ler, uniqueSuffix, dispatch, adapterRegistry,
};
