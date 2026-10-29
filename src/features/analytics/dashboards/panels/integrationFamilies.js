'use strict';

/**
 * M9-D682 — as 14 famílias de integração do livro (M9-D201, seção "Catálogo inicial de integrações"), na ordem do catálogo, com o nome que o livro dá a cada uma. O BI não importa o
 * módulo de Integrações (BI-001: só leitura e só o schema analytics), então a lista fica aqui; o teste `m9d682 as 14 famílias do quadro são as do catálogo de integrações` confere
 * código a código e rótulo a rótulo com `integrations/providers/catalog.domains`, e uma família nova no catálogo reprova o teste.
 */
const FAMILIES = Object.freeze([
  ['MESSAGING', 'WhatsApp e atendimento'], ['EMAIL', 'E-mail'], ['SITE', 'Site'], ['PORTAL', 'Portais imobiliários'], ['SIGNATURE', 'Assinatura digital'],
  ['BANK', 'Bancos, extratos e pagamentos'], ['INSURANCE', 'Seguradoras e garantias'], ['FINANCING', 'Financiamento e promotoras'], ['FISCAL', 'NFS-e e fiscal'],
  ['SOCIAL', 'Redes sociais e publicação'], ['STORAGE', 'Armazenamento de objetos'], ['IDENTITY', 'Identidade e autenticação'], ['AI', 'Modelos de IA'], ['ANALYTICS', 'Analytics e monitoramento'],
].map(([id, label]) => Object.freeze({ id, label })));

module.exports = { INTEGRATION_FAMILIES: FAMILIES };
