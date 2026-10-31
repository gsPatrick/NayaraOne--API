'use strict';

// Prova da metade "retention apply pula o escopo jurídico em hold" do AUD-018 (M9-D809, transferida à M9-D912). Banco descartável; limpa o que cria.
const env = require('./m9d912Env');

const NOW = new Date('2026-03-10T15:00:00Z');

/**
 * Contrato encerrado em 2020 sob legal hold e outro livre, política de contratos em ARCHIVE com prazo de 1 mês: a simulação mostra o contrato em hold como blocked_by_hold, o apply
 * o pula (SKIPPED_HOLD) e só o livre é arquivado. Devolve os fatos para o teste conferir.
 */
async function contractUnderHold(tenant) {
  env.useRealGuard();
  await env.resetHolds(tenant); await env.resetRetention(tenant);
  try {
    await env.editPolicy(tenant, 'CONTRATOS', { disposition: 'ARCHIVE', retention_months: 1 });
    const held = await env.insertContract(tenant, null, { endsAt: '2020-01-31T12:00:00Z', status: 'TERMINATED' });
    const free = await env.insertContract(tenant, null, { endsAt: '2020-01-31T12:00:00Z', status: 'TERMINATED' });
    await env.createHold(tenant, { scope: [{ type: 'CONTRACT', id: held }] });
    const dry = await env.dryRun(tenant, { policyCodes: ['CONTRATOS'], now: NOW });
    const target = env.policyReport(dry, 'CONTRATOS').targets.find((t) => t.target === 'CONTRACTS');
    const queued = (await env.items(dry.id)).map((item) => item.record_id);
    await env.apply(tenant, dry.id, { now: NOW });
    const archived = (await env.adminQuery("SELECT record_id FROM governance.retention_archives WHERE company_id = $1 AND target_code = 'CONTRACTS'", [tenant.companyId])).rows.map((r) => r.record_id);
    return { blockedByHold: target.blockedByHold, heldQueued: queued.includes(held), freeQueued: queued.includes(free), heldArchived: archived.includes(held), freeArchived: archived.includes(free) };
  } finally {
    await env.resetHolds(tenant); await env.resetRetention(tenant);
  }
}

module.exports = { contractUnderHold };
