'use strict';

const { DEFAULT_CRITICALITY } = require('./catalog.domains');

/**
 * Fornecedores de seguro que já existiam no código e entram no catálogo (M9-D238): os três adapters reais (Porto Seguro, Yelum e Junto Seguros, este sempre recusando até
 * a parceria de corretora) e o fluxo manual, que cumpre o MESMO port quando a seguradora não tem API (a tarefa vai a uma pessoa, o modelo e os eventos são os mesmos).
 */
const BASE = Object.freeze(['quote', 'propose', 'getPolicy', 'getStatus', 'submitClaim']);
/** `webhook`: a seguradora avisa o status da apólice por webhook assinado (Porto Seguro e Yelum); o fluxo manual e a Junto Seguros não têm. */
const insurer = (code, displayName, { webhook = false, sandboxAvailable = false } = {}) => ({
  code, displayName, domain: 'INSURANCE', capabilities: webhook ? [...BASE, 'verifyWebhook'] : [...BASE], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.INSURANCE, sandboxAvailable,
});

const INSURANCE_PROVIDERS = Object.freeze([
  insurer('insurance-porto-seguro', 'Seguradoras — Porto Seguro (Fiança Locatícia)', { webhook: true }),
  insurer('insurance-yelum', 'Seguradoras — Yelum (Cotador Fiança)', { webhook: true }),
  insurer('insurance-junto-seguros', 'Seguradoras — Junto Seguros (sem integração disponível)'),
  insurer('insurance-manual', 'Seguradoras — fluxo manual (cotação e apólice por e-mail ou portal)', { sandboxAvailable: true }),
]);

module.exports = { INSURANCE_PROVIDERS };
