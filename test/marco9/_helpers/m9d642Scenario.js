'use strict';

// Cenários da Locação da M9-D642. Data-base 28/10/2026 12:00 (SP); prazo do repasse de 10 dias (padrão). As datas de borda (23:30 de SP, virada do mês) estão nos comentários.
const bi = require('./biObrasJuridicoEnv');

const iso = (day, hour = 15, minute = 0) => `2026-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`; // 15:00Z = 12:00 em São Paulo
const contract = (env, t, c = {}) => bi.seed(env, t, 'legal.contracts', { contract_type: 'LEASE', status: 'ACTIVE', starts_at: iso('09-01'), ends_at: iso('12-31'), ...c });
const party = (env, t, contractId, person, role) => bi.seed(env, t, 'legal.contract_parties', { contract_id: contractId, person_id: person, party_role: role });
const maintenance = (env, t, property, status, created, updated = created) => bi.seed(env, t, 'construction.maintenance_cases', { property_id: property, description: 'Chamado', status, created_at: created, updated_at: updated });
const feedback = (env, t, person, type, created) => bi.seed(env, t, 'crm.feedback_cases', { person_id: person, type, description: 'Registro', sla_due_at: '2026-12-01T15:00:00Z', status: 'OPEN', created_at: created, updated_at: created });
/** `legacy`: registro anterior às regras de 2026 (a migration 420 só exige mês de referência válido dos repasses novos), o único que pode não ter data prevista. */
const repass = (env, t, amount, month, status = 'PENDING', paidAt = null, legacy = false) => bi.seed(env, t, 'finance.owner_repasses', {
  ...(legacy ? { created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' } : {}), property_id: bi.uuid(), owner_person_id: bi.uuid(), gross_amount: amount, net_amount: amount, reference_month: month, status, paid_at: paidAt,
  ...(['APPROVED', 'PAID'].includes(status) ? { approved_by_user_id: bi.uuid(), confirmed_by_user_id: bi.uuid(), approved_at: paidAt || iso('10-01'), created_by: bi.uuid(), financial_entry_id: bi.uuid(), payment_settlement_method: 'BANK_CONFIRMED' } : {}),
});

/**
 * Chamados: 3 em aberto (OPEN 10/10, IN_PROGRESS 20/10, OPEN hoje); abertos no período 6; fechados no período 4 em 48 h, 12,5 h, 12 h e 2 h (média 18,6 h). Bordas de fuso: aberto às
 * 00:30 de 01/10 em SP (03:30Z) conta em outubro e o aberto às 23:30 de 30/09 (02:30Z) conta em setembro, embora já seja 01/10 em UTC. Fora: imóvel sem locação e imóvel de venda.
 */
async function chamados(env, t) {
  const rented = bi.uuid();
  await contract(env, t, { property_id: rented });
  await maintenance(env, t, rented, 'OPEN', iso('10-10'));
  await maintenance(env, t, rented, 'IN_PROGRESS', iso('10-20'));
  await maintenance(env, t, rented, 'OPEN', iso('10-28', 13));
  await maintenance(env, t, rented, 'CLOSED', iso('10-05', 12), iso('10-07', 12)); // 48 h
  await maintenance(env, t, rented, 'RESOLVED', iso('10-10', 12), iso('10-11', 0, 30)); // 12,5 h
  await maintenance(env, t, rented, 'CLOSED', iso('10-01', 3, 30), iso('10-01', 15, 30)); // 00:30 de 01/10 em SP: 12 h
  await maintenance(env, t, rented, 'CLOSED', iso('10-01', 2, 30), iso('10-01', 4, 30)); // aberto às 23:30 de 30/09 em SP (setembro), fechado em outubro: 2 h
  await maintenance(env, t, rented, 'RESOLVED', iso('09-20'), iso('09-25')); // fechado em setembro
  await maintenance(env, t, bi.uuid(), 'OPEN', iso('10-15')); // imóvel sem locação
  const sold = bi.uuid();
  await contract(env, t, { contract_type: 'SALE', property_id: sold });
  await maintenance(env, t, sold, 'OPEN', iso('10-16')); // imóvel de contrato de venda
}

/**
 * Satisfação de outubro com a nota de cada tipo (elogio 5, reclamação 1, conflito 3): 7 respostas somando 27 (3,86). Inquilinos T1, T2 e B (4 respostas, 16 pontos); proprietários O1 e B
 * (3 respostas, 13 pontos); B é parte nos dois papéis e conta uma vez no total; o fiador G só conta no total. Fora: comprador de venda, setembro e o registro das 23:30 de 30/09 em SP.
 */
async function satisfacao(env, t) {
  const [t1, t2, o1, both, guarantor, buyer] = [bi.uuid(), bi.uuid(), bi.uuid(), bi.uuid(), bi.uuid(), bi.uuid()];
  const c1 = await contract(env, t);
  await party(env, t, c1, t1, 'TENANT'); await party(env, t, c1, o1, 'LANDLORD'); await party(env, t, c1, guarantor, 'GUARANTOR');
  const c2 = await contract(env, t, { contract_type: 'LEASE_RESIDENTIAL' });
  await party(env, t, c2, t2, 'TENANT'); await party(env, t, c2, both, 'TENANT');
  await party(env, t, await contract(env, t), both, 'LANDLORD');
  await party(env, t, await contract(env, t, { contract_type: 'SALE' }), buyer, 'BUYER');
  await feedback(env, t, t1, 'COMPLIMENT', iso('10-05'));
  await feedback(env, t, t1, 'COMPLAINT', iso('10-06'));
  await feedback(env, t, t2, 'COMPLIMENT', iso('10-01', 3, 30)); // 00:30 de 01/10 em SP: outubro
  await feedback(env, t, o1, 'COMPLIMENT', iso('10-07'));
  await feedback(env, t, o1, 'CONFLICT', iso('10-08'));
  await feedback(env, t, both, 'COMPLIMENT', iso('10-09'));
  await feedback(env, t, guarantor, 'CONFLICT', iso('10-10'));
  await feedback(env, t, buyer, 'COMPLAINT', iso('10-11')); // comprador de venda: fora
  await feedback(env, t, t1, 'COMPLIMENT', iso('09-05')); // setembro: fora
  await feedback(env, t, t1, 'COMPLAINT', iso('10-01', 2, 30)); // 23:30 de 30/09 em SP: setembro, fora
}

/** Quatro respostas de elogio e conflito (nota do conflito = 4): 5, 4, 4, 5 dão 4,50 com 4 respostas (exemplo da demanda). */
async function satisfacaoQuatroRespostas(env, t) {
  const [tenant, owner] = [bi.uuid(), bi.uuid()];
  const lease = await contract(env, t);
  await party(env, t, lease, tenant, 'TENANT'); await party(env, t, lease, owner, 'LANDLORD');
  await feedback(env, t, tenant, 'COMPLIMENT', iso('10-05'));
  await feedback(env, t, tenant, 'CONFLICT', iso('10-06'));
  await feedback(env, t, owner, 'CONFLICT', iso('10-07'));
  await feedback(env, t, owner, 'COMPLIMENT', iso('10-08'));
}

/**
 * Repasses (prazo de 10 dias depois do fim do mês de referência): devidos no período (data prevista de 01/10 a 28/10) 6 (a, b, c, d, i1, i2), pagos até a data prevista 2 (33,33%),
 * atrasados 3 (c, d e f de agosto), pagos em outubro 4 (R$ 2.050,00), pendente no prazo 1 (e). Bordas de fuso: pago às 23:30 de 10/10 em SP (02:30Z) é no prazo e às 00:30 de 11/10 é atraso.
 */
async function repasses(env, t) {
  await repass(env, t, '1000.00', '2026-09', 'PAID', iso('10-08')); // a: no prazo (vence 10/10)
  await repass(env, t, '800.00', '2026-09', 'PAID', iso('10-15')); // b: pago atrasado
  await repass(env, t, '500.00', '2026-09'); // c: atrasado
  await repass(env, t, '400.00', '2026-09', 'APPROVED'); // d: atrasado
  await repass(env, t, '2000.00', '2026-10'); // e: vence 10/11, no prazo
  await repass(env, t, '300.00', '2026-08'); // f: atrasado, vencido em setembro (fora do período)
  await repass(env, t, '700.00', '2026-08', 'PAID', iso('09-05')); // g: pago em setembro
  await repass(env, t, '600.00', '2026-09', 'CANCELLED'); // h: cancelado
  await repass(env, t, '100.00', '2026-09', 'PAID', iso('10-11', 2, 30)); // i1: 23:30 de 10/10 em SP, no prazo
  await repass(env, t, '150.00', '2026-09', 'PAID', iso('10-11', 3, 30)); // i2: 00:30 de 11/10 em SP, atrasado
}

module.exports = { chamados, satisfacao, satisfacaoQuatroRespostas, repasses, contract, party, maintenance, feedback, repass, iso };
