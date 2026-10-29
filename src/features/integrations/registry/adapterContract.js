'use strict';

const { IntegrationAdapter, REQUIRED_METHODS } = require('./IntegrationAdapter');
const { DOMAIN_CAPABILITIES, DOMAINS } = require('../providers/catalog.domains');
const { SEED_PROVIDERS } = require('../providers/catalog.providers');
const { contractInvalid } = require('./adapters.errors');

const CODE_RE = /^[a-z0-9_-]{1,48}$/;
const mesmoConjunto = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Confere o contrato de uma classe de adapter e devolve a descrição { code, domain, capabilities, versions }.
 * Qualquer falta lança 500 INTEGRATION_ADAPTER_CONTRACT_INVALID (o servidor não sobe: o registro roda no boot).
 */
function validateAdapterClass(AdapterClass) {
  const problemas = [];
  if (typeof AdapterClass !== 'function' || !(AdapterClass.prototype instanceof IntegrationAdapter)) {
    throw contractInvalid(['a classe precisa estender IntegrationAdapter']);
  }
  const { domain } = AdapterClass;
  if (!DOMAINS.includes(domain)) problemas.push(`domínio ausente ou fora do catálogo (static domain): ${String(domain)}`);
  REQUIRED_METHODS.forEach((m) => {
    if (typeof AdapterClass.prototype[m] !== 'function' || AdapterClass.prototype[m] === IntegrationAdapter.prototype[m]) problemas.push(`método obrigatório não implementado: ${m}()`);
  });
  if (problemas.length) throw contractInvalid(problemas);

  const inst = new AdapterClass(null);
  const code = inst.providerCode();
  const capabilities = inst.capabilities();
  const versions = inst.supportedVersions();
  if (typeof code !== 'string' || !CODE_RE.test(code)) problemas.push('providerCode() precisa devolver o código do catálogo (a-z, 0-9, _ e -)');
  if (!Array.isArray(versions) || versions.length === 0 || versions.some((v) => typeof v !== 'string' || !v)) problemas.push('supportedVersions() precisa devolver uma lista de textos não vazia');
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((c) => typeof c !== 'string')) {
    problemas.push('capabilities() precisa devolver uma lista de textos não vazia');
  } else {
    const permitidas = DOMAIN_CAPABILITIES[domain];
    capabilities.filter((c) => !permitidas.includes(c)).forEach((c) => problemas.push(`capability fora do domínio ${domain}: ${c}`));
    capabilities.filter((c) => typeof AdapterClass.prototype[c] !== 'function').forEach((c) => problemas.push(`capability declarada sem operação implementada: ${c}()`));
  }
  const semente = SEED_PROVIDERS.find((p) => p.code === code);
  if (semente && problemas.length === 0) {
    if (semente.domain !== domain) problemas.push(`o catálogo registra ${code} no domínio ${semente.domain}`);
    if (!mesmoConjunto(capabilities, semente.capabilities)) problemas.push(`as capabilities diferem das gravadas no catálogo para ${code}`);
  }
  if (problemas.length) throw contractInvalid(problemas, typeof code === 'string' ? code : null);
  return { code, domain, capabilities: [...capabilities], versions: [...versions] };
}

module.exports = { validateAdapterClass };
