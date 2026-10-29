'use strict';

/**
 * Versão do roteador de modelos (entra no `global_hash` da regressão, M9-D033). Sobe quando a regra de escolha de provider e
 * modelo muda (M9-D012); o deploy com a versão nova exige reavaliar antes de homologar ou ativar outra versão de agente.
 */
const ROUTER_VERSION = 1;

module.exports = { ROUTER_VERSION };
