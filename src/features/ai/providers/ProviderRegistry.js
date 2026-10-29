'use strict';

const { AdapterRegistry: adapterRegistry } = require('../../integrations');
const { AIProviderAdapter } = require('./AIProviderAdapter');
const { modelProblems } = require('./providers.models');
const { readProviderParams } = require('./providers.params');
const { rankCandidates } = require('./candidates');
const { activeAiConnections } = require('./providerConnections');
const { makeEvalBridge } = require('./evalBridge');
const { registerEvalProvider } = require('../evaluations/evalProviders');
const E = require('./providers.errors');

/**
 * ProviderRegistry (M9-D011) — a visão do AdapterRegistry das integrações (M9-D209) filtrada pelo domínio AI. Não existe tabela
 * `ai.providers` nem cofre próprio: o provedor é uma linha de `integration.providers` (domain AI) com `integration.connections`
 * (D200/D201/D243) e a credencial vem do SecretStore (D202).
 *  - register(AdapterClass): valida o contrato (boot) e, se o adapter é real, o oferece à avaliação de regressão;
 *  - resolve(code): o registro do adapter (404 AI_PROVIDER_NOT_FOUND);
 *  - instance(code, tenant, tx): o adapter pronto para chamar. O sandbox não tem conexão e é recusado em produção
 *    (409 AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION); o real exige conexão ACTIVE da empresa (409 AI_PROVIDER_NOT_ENABLED) e, em LAB, empresa
 *    marcada como laboratório (`ia.empresa.lab`, 409 AI_PROVIDER_REAL_NOT_ALLOWED_IN_LAB, M9-D046);
 *  - candidates(...): lista ordenada por capability, política, criticidade, custo e latência. A decisão final é do ModelRouter.
 */
class ProviderRegistry {
  constructor() { this.classes = new Map(); }

  register(AdapterClass) {
    if (typeof AdapterClass !== 'function' || !(AdapterClass.prototype instanceof AIProviderAdapter)) {
      throw new Error('ProviderRegistry.register: o adapter precisa estender AIProviderAdapter');
    }
    const info = adapterRegistry.register(AdapterClass);
    this.classes.set(info.code, AdapterClass);
    const problemas = new AdapterClass(null).models().flatMap((m) => modelProblems(m).map((c) => `${m.model}: ${c}`));
    if (problemas.length) throw new Error(`Catálogo de modelos inválido em ${info.code}: ${problemas.join(', ')}`);
    if (AdapterClass.requiresConnection) registerEvalProvider(info.code, makeEvalBridge(info.code, this));
    return info;
  }

  /** Tira o adapter do registro (testes e troca de fornecedor em tempo de execução). */
  unregister(code) {
    this.classes.delete(String(code));
    return adapterRegistry.unregister(code);
  }

  list() {
    return adapterRegistry.list().filter((a) => a.domain === 'AI');
  }

  has(code) { return this.list().some((a) => a.providerCode === String(code)); }

  resolve(code) {
    const found = this.list().find((a) => a.providerCode === String(code));
    if (!found) throw E.providerNotFound();
    return found;
  }

  /** Adapter pronto para a empresa. Sandbox: sem conexão, recusado em produção. Real: conexão ACTIVE no ambiente do servidor. */
  async instance(code, tenant, transaction) {
    this.resolve(code);
    const semConexao = this.semConexao(code);
    if (semConexao) {
      if ((await readProviderParams(tenant, transaction)).production) throw E.sandboxNotAllowedInProduction();
      return semConexao;
    }
    const achado = (await this.activeAdapters(tenant, transaction)).find((x) => x.providerCode === String(code));
    if (!achado) throw E.providerNotEnabled();
    const params = await readProviderParams(tenant, transaction);
    if (!params.production && !params.companyLab) throw E.realNotAllowedInLab();
    return achado.adapter;
  }

  /** O provedor padrão da empresa (`ia.provedor.padrao`), já pronto. */
  async defaultInstance(tenant, transaction) {
    const { defaultProvider } = await readProviderParams(tenant, transaction);
    return this.instance(defaultProvider, tenant, transaction);
  }

  /** Adapters sem fornecedor externo (sandbox): instância sem conexão. */
  semConexao(code) {
    const Class = this.classOf(code);
    return Class && !Class.requiresConnection ? new Class(null) : null;
  }

  classOf(code) { return this.classes.get(String(code)) || null; }

  async activeAdapters(tenant, transaction) {
    const reais = await activeAiConnections(tenant, transaction);
    return reais.map((x) => ({ providerCode: x.connection.providerCode, adapter: x.adapter, policy: x.policy }));
  }

  /** Linhas {providerCode, policy, model, capabilities} de tudo que a empresa pode usar agora. */
  async entries(tenant, transaction) {
    const fontes = [];
    this.list().forEach((a) => {
      const sem = this.semConexao(a.providerCode);
      if (sem) fontes.push({ providerCode: a.providerCode, adapter: sem, policy: { labOnly: this.classOf(a.providerCode).labOnly === true } });
    });
    const params = await readProviderParams(tenant, transaction);
    // Em LAB, o provedor real só entra na lista de empresa marcada como laboratório (M9-D046).
    if (params.production || params.companyLab) (await this.activeAdapters(tenant, transaction)).forEach((x) => fontes.push(x));
    return fontes.flatMap((f) => f.adapter.models().map((model) => ({ providerCode: f.providerCode, policy: f.policy, model, capabilities: f.adapter.capabilities() })));
  }

  /**
   * candidates({ capability | requiredCapabilities, criticidade, politica, requestSize, latencyBudgetMs }, tenant, transaction).
   * `politica`: { classification, retentions?, regions? }. `requestSize`: { tokensIn, tokensOut } para estimar o custo.
   */
  async candidates(query = {}, tenant, transaction) {
    const params = await readProviderParams(tenant, transaction);
    const capabilities = query.requiredCapabilities || (query.capability ? [query.capability] : []);
    return rankCandidates(await this.entries(tenant, transaction), { ...query, capabilities }, params);
  }

}

const providerRegistry = new ProviderRegistry();

module.exports = { ProviderRegistry, providerRegistry };
