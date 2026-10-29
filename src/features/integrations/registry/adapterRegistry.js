'use strict';

const { IntegrationProvider } = require('../../../models');
const { validateAdapterClass } = require('./adapterContract');
const { buildAdapterCtx } = require('./adapterCtx');
const { contractInvalid, notImplemented, versionUnsupported } = require('./adapters.errors');
const { ctxOk } = require('./registry.helpers');

/** codigo do fornecedor -> { AdapterClass, info }. Em memória: cada processo registra no boot. */
const registered = new Map();

/**
 * register — valida o contrato da classe e a guarda pelo código do fornecedor. Contrato inválido ou código repetido lança
 * 500 INTEGRATION_ADAPTER_CONTRACT_INVALID: no boot isso derruba o servidor (assim um adapter quebrado nunca vai ao ar).
 */
function register(AdapterClass) {
  const info = validateAdapterClass(AdapterClass);
  const anterior = registered.get(info.code);
  if (anterior && anterior.AdapterClass !== AdapterClass) throw contractInvalid([`já existe outro adapter para o fornecedor ${info.code}`], info.code);
  registered.set(info.code, { AdapterClass, info });
  return info;
}

/** Hosts que o adapter declara para a saída (M9-D244 3.2): método opcional `allowedHosts()`; sem ele, nenhum. */
function declaredHosts(AdapterClass) {
  try { return new AdapterClass(null).allowedHosts(); } catch { return []; }
}

const has = (providerCode) => registered.has(String(providerCode));
const list = () => [...registered.values()].map(({ info }) => ({ providerCode: info.code, domain: info.domain, capabilities: info.capabilities, versions: info.versions }));
const unregister = (providerCode) => registered.delete(String(providerCode));

/**
 * resolve — devolve a INSTÂNCIA do adapter da conexão, já com `ctx`. Fornecedor do catálogo sem adapter: 501. Linha do
 * catálogo que diverge do adapter (domínio ou capabilities): 500 contrato inválido. `connection.apiVersion` fora das
 * versões suportadas: 422. `tenant` = { groupId, companyId, userId }.
 */
async function resolve(connection, tenant, transaction) {
  ctxOk(tenant);
  const entry = registered.get(String(connection.providerCode));
  if (!entry) throw notImplemented();
  const { AdapterClass, info } = entry;
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { transaction });
  if (provider) {
    const caps = Array.isArray(provider.capabilities) ? provider.capabilities : [];
    const problemas = [];
    if (provider.domain !== info.domain) problemas.push(`o catálogo registra ${info.code} no domínio ${provider.domain}`);
    if (caps.length !== info.capabilities.length || !caps.every((c) => info.capabilities.includes(c))) problemas.push('as capabilities do catálogo diferem das do adapter');
    if (problemas.length) throw contractInvalid(problemas, info.code);
  }
  if (connection.apiVersion && !info.versions.includes(connection.apiVersion)) throw versionUnsupported(connection.apiVersion, info.versions);
  return new AdapterClass(await buildAdapterCtx(connection, tenant, transaction, { adapterHosts: declaredHosts(AdapterClass) }));
}

module.exports = { register, resolve, has, list, unregister };
