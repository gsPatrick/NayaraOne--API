'use strict';

const { MODES } = require('../channels');
const { CONTRACT_CHECKS } = require('./channelContract.checks');
const { SandboxChannelAdapter } = require('../sandbox/SandboxChannelAdapter');
const { normalizeChannel } = require('../channel.errors');

let counter = 0;

/**
 * Roda a suíte única de contrato contra UM canal. `make(scope)` devolve um adapter novo (padrão: o SANDBOX, escopo próprio por verificação, sem
 * esperar nos cenários lentos); em LAB, passe a fábrica do adapter real. Devolve { channel, mode, ok, results: [{ id, title, ok, skipped?, error? }] }.
 * Não lança por falha de verificação: o relatório diz o que reprovou (o gate de liberação e o teste leem `ok`).
 */
async function runChannelContract(channelName, { make } = {}) {
  const channel = normalizeChannel(channelName);
  const factory = make || ((scope, extra) => new SandboxChannelAdapter(channel, { scope, slowMs: 0, retryAfterS: 30, ...extra }));
  const results = [];
  let mode = MODES.SANDBOX;
  for (const check of CONTRACT_CHECKS) {
    // Cada adapter montado tem escopo próprio: dois `make()` na mesma verificação não compartilham registros.
    const build = (extra) => { counter += 1; return factory(extra && extra.scope ? extra.scope : `contrato-${channel}-${counter}`, extra); };
    try {
      const probe = build();
      mode = probe.mode;
      if (check.sandboxOnly && !probe.isSandbox) { results.push({ id: check.id, title: check.title, ok: true, skipped: true }); continue; }
      await check.run({ make: build, channel });
      results.push({ id: check.id, title: check.title, ok: true });
    } catch (err) {
      results.push({ id: check.id, title: check.title, ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
    }
  }
  return { channel, mode, ok: results.every((r) => r.ok), results };
}

module.exports = { runChannelContract };
