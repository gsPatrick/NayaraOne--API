'use strict';

/**
 * Kill switches do Marketing declarados para o relatório de CI (M9-D425/M9-D871/M9-D872): o global (`marketing.sending.kill`) e um por canal (`marketing.channel.<canal>.kill`),
 * todos com risco CRITICAL, kill switch registrado e o probe `marketing.kill.envio_parado` (src/features/marketing/killswitch.probe.js). O valor vivo mora no banco de cada empresa
 * (criado na primeira vez que o switch é acionado pelo POST /marketing/kill-switch ou pelo registro); declarar aqui só dá ao CI a visão do que está versionado.
 */
const { REGISTRY_KEYS, GLOBAL_KEY, PROBE_NAME } = require('../../../marketing/killswitch.constants');

module.exports = {
  domain: 'marketing',
  flags: REGISTRY_KEYS.map((key) => ({
    key,
    owner: 'Marketing',
    risk: 'CRITICAL',
    killSwitch: true,
    probe: PROBE_NAME,
    description: key === GLOBAL_KEY ? 'Kill switch global do Marketing: para toda ação de saída automática.' : `Kill switch do canal ${key.split('.')[2].toUpperCase()} do Marketing.`,
  })),
};
