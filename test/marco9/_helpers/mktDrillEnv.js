'use strict';

// Apoio dos testes M9-D442 (failure drill de provedor): empresa e pessoas do ensaio, troca do sandbox de um canal por uma subclasse e limpeza. Não é teste.
const drill = require('../../../src/features/marketing/publications/drill');
const { pickTenant, withDrillTransaction } = require('../../../src/features/marketing/publications/drill/drill.env');
const adapters = require('../../../src/features/marketing/publications/adapters');
const channelRegistry = require('../../../src/features/marketing/publications/adapters/registry/channelRegistry');
const { SandboxChannelAdapter } = require('../../../src/features/marketing/publications/adapters/sandbox/SandboxChannelAdapter');

/** { tenant, reviewer } da primeira empresa do banco semeado. */
async function setup() {
  const picked = await pickTenant();
  if (!picked) throw new Error('o seed precisa ter uma empresa e duas pessoas (scripts/seed-ci-two-tenants.js)');
  return picked;
}

const envOf = (picked, channel) => ({ tenant: picked.tenant, reviewer: picked.reviewer, channel });

/** Troca o sandbox de um canal por uma subclasse e devolve a função que restaura o original. */
function overrideSandbox(channel, make) {
  const original = channelRegistry.get(channel, 'SANDBOX');
  channelRegistry.register({ channel, mode: 'SANDBOX', create: (opts) => make(new SandboxChannelAdapter(channel, opts || {}), opts || {}) });
  return () => channelRegistry.register(original);
}

/** Sandbox que NÃO respeita a idempotência: cada envio usa uma chave nova, então um reenvio vira segundo post (o defeito que o drill precisa pegar). */
function duplicatingSandbox(channel) {
  return overrideSandbox(channel, (base, opts) => {
    class Duplicating extends SandboxChannelAdapter {
      execute(operation, payload, options = {}) { return super.execute(operation, payload, { ...options, idempotencyKey: `${options.idempotencyKey}#${Math.random()}` }); }
    }
    return new Duplicating(channel, opts);
  });
}

module.exports = { drill, setup, envOf, withDrillTransaction, adapters, overrideSandbox, duplicatingSandbox };
