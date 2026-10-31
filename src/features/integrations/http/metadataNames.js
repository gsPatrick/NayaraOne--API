'use strict';

/**
 * Nomes de host de metadados e de serviços internos de nuvem e de orquestrador (M9-D244, reabertura R3-M3): nunca viram exceção de rede própria, qualquer
 * que seja o parâmetro integration.egress.private_hosts. Função pura sobre o texto do nome.
 */
const EXATOS = Object.freeze(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal', 'kubernetes', 'kubernetes.default', 'metadata.azure.com']);
const SUFIXOS = Object.freeze(['.svc', '.svc.cluster.local', '.cluster.local', '.default.svc', '.ec2.internal', '.compute.internal']);

const isMetadataName = (host) => {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  return EXATOS.includes(h) || SUFIXOS.some((s) => h.endsWith(s));
};

module.exports = { isMetadataName };
