'use strict';

const logger = require('../../../../utils/logger');

/**
 * Cadastro dos kill switches de quem é dono deles (M9-D872 §3.3): cada módulo dono (Marketing em M9-D425) registra uma função `(tenant, transaction) => resultado` que cria, para a
 * empresa, as chaves que ainda não existem (com o probe), para o teste periódico cobrir TODAS as empresas e não só as que já acionaram o switch. O ciclo diário chama todas antes de
 * listar os switches. Falha de um provedor é registrada e nunca impede o teste dos demais.
 */
const provisioners = [];

function registerSwitchProvisioner(fn) {
  if (typeof fn === 'function' && !provisioners.includes(fn)) provisioners.push(fn);
}

async function provisionSwitches(tenant, transaction) {
  const out = [];
  for (const fn of [...provisioners]) {
    try { out.push(await fn(tenant, transaction)); } catch (err) { logger.error({ err: err && err.message }, 'governance.kill_switch.provision_failed'); }
  }
  return out;
}

module.exports = { registerSwitchProvisioner, provisionSwitches };
