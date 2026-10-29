'use strict';

// Cenário da carteira de Locação da M9-D640 (exemplos do livro). Data-base 28/10/2026 (SP). 91 imóveis locáveis, 85 com contrato ACTIVE (20 de 1.500,00, 60 de 2.500,00 e 5 de
// 6.500,00 = 212.500,00 de aluguel mensal) e 6 sem (um deles com contrato SUSPENDED): vacância 6,59%. Inadimplência da locação: vencido 8.200,00 numa cobrança de 200.000,00 = 4,10%,
// com 700,00 vencidos há 120 dias fora da taxa e 4.200,00 de cobrança que não é de contrato de locação (só no Financeiro). Cada cenário também grava o que NÃO deve entrar.
const bi = require('./biObrasJuridicoEnv');

const iso = (day, hour = 15, minute = 0) => `2026-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`; // 15:00Z = 12:00 em São Paulo
const dayAt = (offset, hour = 15) => new Date(Date.UTC(2026, 9, 28 + offset, hour)).toISOString();

const property = (env, t, c = {}) => bi.seed(env, t, 'real_estate.properties', {
  title: 'Imóvel M9', property_type: c.type || 'RESIDENTIAL', internal_code: `M9-${bi.uuid().slice(0, 8)}`, availability_status: c.status || 'AVAILABLE', publication_status: c.publication || 'PUBLISHED',
  address_id: c.address || null, created_at: c.created || iso('09-01'), updated_at: iso('09-01'), ...(c.deleted ? { deleted_at: iso('10-01') } : {}),
});
const offer = (env, t, propertyId, type = 'RENT') => bi.seed(env, t, 'real_estate.property_offers', { property_id: propertyId, offer_type: type, asking_price: '2500.00', status: 'ACTIVE' });
const contract = (env, t, c = {}) => bi.seed(env, t, 'legal.contracts', {
  contract_type: c.type || 'LEASE', status: c.status || 'ACTIVE', property_id: c.property || null, total_value: c.value === undefined ? null : c.value, starts_at: iso('09-01'), ends_at: iso('12-31'), ...(c.deleted ? { deleted_at: iso('10-01') } : {}),
});
const owner = (env, t, propertyId, person, percent) => bi.seed(env, t, 'real_estate.property_owners', { property_id: propertyId, person_id: person, ownership_percent: percent, role_code: 'OWNER', valid_from: '2026-01-01' });
async function address(env, neighborhood) {
  const id = bi.uuid();
  await env.admin.query("INSERT INTO real_estate.property_addresses (id, zip_code, street, number, neighborhood, city, state) VALUES (:id, '01000-000', 'Rua M9', '1', :neighborhood, 'São Paulo', 'SP')", { replacements: { id, neighborhood } });
  env.created.push({ table: 'real_estate.property_addresses', id });
  return id;
}
const entry = (env, t, c) => bi.seed(env, t, 'finance.financial_entries', {
  entry_type: c.nature === 'PAYABLE' ? 'DEBIT' : 'CREDIT', nature: c.nature || 'RECEIVABLE', amount: c.amount, status: c.status || 'PENDING', due_at: c.due === undefined ? null : c.due, settled_at: c.settled || null,
  contract_id: c.contract || null, is_third_party_funds: Boolean(c.third), reversal_of_entry_id: c.reversalOf || null,
});

/** Carteira do livro: 85 contratos ativos em 85 imóveis, 6 imóveis sem contrato ativo e o que fica de fora. Devolve os ids úteis. */
async function carteira(env, t) {
  const centro = await address(env, 'Centro');
  const jardins = await address(env, 'Jardins');
  const o1 = bi.uuid();
  const [o2, o3] = [bi.uuid(), bi.uuid()];
  const rents = [...Array(20).fill('1500.00'), ...Array(60).fill('2500.00'), ...Array(5).fill('6500.00')];
  const props = [];
  const contracts = [];
  for (let i = 0; i < 85; i += 1) {
    const p = await property(env, t, { type: i < 55 ? 'RESIDENTIAL' : 'COMMERCIAL', address: i < 60 ? centro : jardins, status: 'RENTED' });
    props.push(p);
    contracts.push(await contract(env, t, { property: p, value: rents[i] }));
    if (i < 40) await owner(env, t, p, o1, '100.00');
    if (i >= 40 && i < 45) { await owner(env, t, p, o2, '40.00'); await owner(env, t, p, o3, '60.00'); } // principal: o3 (60%)
  }
  const vacant = [];
  for (let i = 0; i < 6; i += 1) {
    const p = await property(env, t, { address: jardins });
    await offer(env, t, p);
    vacant.push(p);
  }
  await contract(env, t, { property: vacant[0], status: 'SUSPENDED', value: '3000.00' }); // suspenso: conta como sem contrato ativo e aparece à parte
  // fora do locável
  await property(env, t, { publication: 'INACTIVE' }).then((p) => offer(env, t, p));
  await property(env, t, { status: 'SOLD' }).then((p) => offer(env, t, p));
  await property(env, t, { deleted: true }).then((p) => offer(env, t, p));
  await property(env, t); // sem oferta de locação nem contrato: não é locável
  const underWorks = await property(env, t);
  await offer(env, t, underWorks);
  await bi.seed(env, t, 'construction.projects', { name: 'Obra M9', property_id: underWorks, status: 'ACTIVE' });
  await offer(env, t, await property(env, t), 'SALE'); // só venda
  // contratos que não entram em "ativos"
  await contract(env, t, { type: 'SALE', property: vacant[1], value: '900000.00' });
  await contract(env, t, { status: 'TERMINATED', property: vacant[2], value: '1200.00' });
  await contract(env, t, { property: vacant[3], value: '1300.00', deleted: true });
  return { props, contracts, vacant, o1, o3 };
}

/** Inadimplência da locação do livro (vencido 8.200,00; cobrado 200.000,00) mais o que não entra. `c` = contratos de locação criados por carteira. */
async function inadimplencia(env, t, c) {
  await entry(env, t, { amount: '5200.00', due: dayAt(-10), contract: c.contracts[0] });
  await entry(env, t, { amount: '3000.00', due: dayAt(-40), contract: c.contracts[1] });
  await entry(env, t, { amount: '191800.00', due: dayAt(-20), status: 'SETTLED', settled: dayAt(-19), contract: c.contracts[2] });
  await entry(env, t, { amount: '700.00', due: dayAt(-120), contract: c.contracts[0] }); // vencido há 120 dias: fora da taxa, dentro do valor absoluto
  // cobrança que não é de contrato de locação: só no Financeiro
  await entry(env, t, { amount: '3000.00', due: dayAt(-5) });
  const sale = await contract(env, t, { type: 'SALE', value: '100000.00' });
  await entry(env, t, { amount: '1200.00', due: dayAt(-6), contract: sale });
  // fora de tudo
  await entry(env, t, { amount: '999.00', due: dayAt(-10), third: true, contract: c.contracts[0] });
  await entry(env, t, { amount: '888.00', due: dayAt(-10), status: 'REVERSED', contract: c.contracts[0] });
  await entry(env, t, { amount: '777.00', due: dayAt(-10), status: 'CANCELLED', contract: c.contracts[0] });
  await entry(env, t, { amount: '666.00', due: dayAt(-10), reversalOf: bi.uuid(), contract: c.contracts[0] });
  await entry(env, t, { nature: 'PAYABLE', amount: '555.00', due: dayAt(-10), contract: c.contracts[0] });
}

module.exports = { iso, dayAt, property, offer, contract, owner, address, entry, carteira, inadimplencia };
