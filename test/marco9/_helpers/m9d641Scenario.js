'use strict';

// Cenário de prazos da Locação da M9-D641. Data-base 28/10/2026 (SP). Contratos de locação ACTIVE com garantias, exigências, vistorias e chaves; contratos de outro tipo,
// suspensos ou encerrados ficam fora. As datas de borda (hoje, hoje+29, hoje+30, hoje+59, hoje+60, 23:30 de SP) estão nos comentários.
const bi = require('./biObrasJuridicoEnv');

const iso = (day, hour = 15, minute = 0) => `2026-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`; // 15:00Z = 12:00 em São Paulo
const contract = (env, t, c = {}) => bi.seed(env, t, 'legal.contracts', { contract_type: 'LEASE', status: 'ACTIVE', starts_at: iso('09-01'), ends_at: iso('12-31'), ...c });
const guarantee = (env, t, contractId, type, endsAt, status = 'ACTIVE') => bi.seed(env, t, 'legal.guarantees', { contract_id: contractId, guarantee_type: type, status, starts_at: '2026-01-01', ends_at: endsAt });

/** Garantias de contratos ACTIVE: vencendo em 30 d (hoje a hoje+29): 3; em 60 d (hoje a hoje+59): 5; vencida: 1. Sem data só o caução (tipo sem vencimento). */
async function garantias(env, t) {
  const active = await contract(env, t);
  await guarantee(env, t, active, 'GUARANTOR', '2026-10-28'); // hoje: conta
  await guarantee(env, t, active, 'INSURANCE', '2026-11-10');
  await guarantee(env, t, active, 'INSURANCE', '2026-11-26'); // hoje+29: último dia dos 30 d
  await guarantee(env, t, active, 'INSURANCE', '2026-11-27'); // hoje+30: só nos 60 d
  await guarantee(env, t, active, 'GUARANTOR', '2026-12-26'); // hoje+59: último dia dos 60 d
  await guarantee(env, t, active, 'GUARANTOR', '2026-12-27'); // hoje+60: fora
  await guarantee(env, t, active, 'GUARANTOR', '2026-10-27'); // ontem: vencida
  await guarantee(env, t, active, 'DEPOSIT', null); // tipo sem vencimento: não é problema de qualidade
  await guarantee(env, t, active, 'GUARANTOR', '2026-11-05', 'ENDED'); // garantia encerrada
  await guarantee(env, t, await contract(env, t, { status: 'SUSPENDED' }), 'GUARANTOR', '2026-11-01'); // contrato suspenso
  await guarantee(env, t, await contract(env, t, { contract_type: 'SALE' }), 'GUARANTOR', '2026-11-01'); // contrato que não é de locação
}

const requirement = (env, t, contractId, status = 'PENDING') => bi.seed(env, t, 'legal.contract_requirements', {
  contract_id: contractId, requirement_code: `REQ-${bi.uuid().slice(0, 6)}`, description: 'Exigência', requirement_type: 'DOCUMENT', status, created_at: iso('10-01'), updated_at: iso('10-01'),
});
const utility = (env, t, contractId, evidence = null) => bi.seed(env, t, 'finance.utility_obligations', {
  contract_id: contractId, utility_type: 'WATER', responsible_party: 'TENANT', transfer_required: true, evidence_file_id: evidence, status: 'ACTIVE',
});

/** Obrigações: 6 abertas, 4 vencidas (contrato iniciado há 12 e há 3 dias) e 2 a vencer (início em 10/11); a mais antiga vencida há 12 dias. */
async function obrigacoes(env, t) {
  const c1 = await contract(env, t, { starts_at: iso('10-16') });
  const c2 = await contract(env, t, { starts_at: iso('10-25') });
  const c3 = await contract(env, t, { status: 'SIGNED', starts_at: iso('11-10') });
  await requirement(env, t, c1); await requirement(env, t, c1); await utility(env, t, c1);
  await requirement(env, t, c2); await requirement(env, t, c2, 'SATISFIED'); await utility(env, t, c2, bi.uuid());
  await requirement(env, t, c3); await utility(env, t, c3);
  await requirement(env, t, await contract(env, t, { status: 'TERMINATED', starts_at: iso('01-01') })); // contrato encerrado: fora
}

const inspection = (env, t, contractId, status, scheduledAt) => bi.seed(env, t, 'legal.inspections', { property_id: bi.uuid(), contract_id: contractId, inspection_type: 'CHECK_IN', status, scheduled_at: scheduledAt });
const key = (env, t, contractId, status) => bi.seed(env, t, 'legal.key_deliveries', { contract_id: contractId, delivered_to_person_id: bi.uuid(), status });

/** Vistorias pendentes 5 (atrasadas 2: 20/10 e 26/10 23:30 SP); chaves fora 4 (atrasadas 2: contratos que acabaram em 20/10 e em 27/10 23:30 SP). */
async function vistoriasChaves(env, t) {
  const l1 = await contract(env, t, { ends_at: iso('12-31') });
  await inspection(env, t, l1, 'SCHEDULED', iso('10-20'));
  await inspection(env, t, l1, 'SCHEDULED', iso('10-28')); // hoje
  await inspection(env, t, l1, 'SCHEDULED', iso('11-05'));
  await inspection(env, t, l1, 'SCHEDULED', iso('10-27', 2, 30)); // 26/10 23:30 em SP: atrasada
  await inspection(env, t, l1, 'SCHEDULED', iso('10-29', 2, 30)); // 28/10 23:30 em SP: ainda é hoje
  await inspection(env, t, l1, 'COMPLETED', iso('10-10'));
  await inspection(env, t, l1, 'CANCELLED', iso('10-10'));
  await key(env, t, l1, 'RELEASED');
  await key(env, t, l1, 'PENDING'); // ainda não entregue: não é chave fora
  await key(env, t, await contract(env, t, { ends_at: iso('10-20') }), 'RELEASED'); // atrasada
  await key(env, t, await contract(env, t, { ends_at: iso('10-28', 2, 30) }), 'RELEASED'); // 27/10 23:30 em SP: atrasada
  await key(env, t, await contract(env, t, { ends_at: iso('10-29', 2, 30) }), 'RELEASED'); // 28/10 23:30 em SP: ainda dentro do prazo
}

module.exports = { garantias, obrigacoes, vistoriasChaves, contract, guarantee, requirement, utility, inspection, key, iso };
