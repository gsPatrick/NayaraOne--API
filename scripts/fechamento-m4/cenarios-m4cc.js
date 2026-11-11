'use strict';
/**
 * Correções m4fix/conciliacao-comissao (DI-M4CC): regra AUTO_STRONG parametrizada e fonte confiável (Guia §9, §11, FIN-009), UNIQUE completo do
 * fingerprint e conta da própria empresa (Guia §10, FIN-002), comissão REG-FIN-001 em decimal exato (Guia §11, §18) e NAY lendo o read model (§13).
 * Roda por último (depois de "guia"): publica uma versão nova da regra de comissão.
 */
const { sequelize } = require('../../src/models');
const { inTenant } = require('./ambiente');

async function consulta(R, { id, linhas, descricao, sql, tenant, replacements, avaliar, explicar }) {
  let resultado;
  let erro = null;
  try { resultado = await inTenant(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0]); } catch (err) { erro = err.message; }
  const invarianteOk = erro ? false : !!avaliar(resultado);
  R.consultas.push({ id, linhas, descricao, sql: sql.replace(/\s+/g, ' ').trim(), contexto: `RLS do tenant (company ${tenant.companyId})`, resultado: erro ? { erro } : resultado, invariante: explicar, invarianteOk, quando: new Date().toISOString() });
  if (!invarianteOk) console.error(`[captura] INVARIANTE FALHOU ${id}: ${erro || JSON.stringify(resultado).slice(0, 300)}`);
}

module.exports = async function m4cc(R) {
  const s = R.ctx.sfx;
  const v = (base) => (base + (Number(s) % 89) / 100).toFixed(2);
  const V = { man: v(707), dup: v(808) };
  const hoje = R.ctx.hoje;

  await R.http({ id: 'K01', linhas: ['M4-G§9'], titulo: 'Regra AUTO_STRONG vigente da empresa (parâmetros, DEC-006/DI-M4CC-3)', quem: 'A:leitura', metodo: 'GET', rota: '/finance/reconciliation/policy', esperado: { status: 200 }, confere: { regra: 'autoScoreMin 0,90; suggestionScoreMin 0,45; dateWindowDays 3; ambiguityGap 0,05; autoStrong falso', fn: (d) => d.autoScoreMin === 0.9 && d.suggestionScoreMin === 0.45 && d.dateWindowDays === 3 && d.ambiguityGap === 0.05 && d.autoStrong === false } });
  await R.http({ id: 'K02', linhas: ['M4-FIN-009', 'M4-§11.1'], titulo: 'Lançamento com chave igual ao id externo que a linha digitada vai trazer', quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: V.man, description: `Recebimento linha manual ${s}`, resultCenterId: c.rc2, bankAccountId: c.baRec, dueAt: `${hoje}T12:00:00-03:00`, idempotencyKey: `EXT-MAN-${s}` }), esperado: { status: 201 } });
  await R.http({ id: 'K03', linhas: ['M4-FIN-009', 'M4-§11.1'], titulo: 'Linha de extrato digitada à mão com origem forjada no corpo: gravada como MANUAL, não confiável', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions', corpo: (c) => ({ bankAccountId: c.baRec, amount: V.man, transactionDate: hoje, externalTransactionId: `EXT-MAN-${s}`, description: 'Digitada', source: 'WEBHOOK', sourceTrusted: true }), esperado: { status: 201 }, confere: { regra: 'source = MANUAL e sourceTrusted = false', fn: (d) => d.source === 'MANUAL' && d.sourceTrusted === false }, guardar: (b, c) => { c.txMan = b.data.id; } });
  await R.http({ id: 'K04', linhas: ['M4-FIN-009', 'M4-§11.1', 'M4-G§9'], titulo: 'EXATO de linha digitada: não concilia sozinho (fonte não confiável)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/finance/bank-transactions/${c.txMan}/auto-reconcile`, corpo: {}, esperado: { status: 200 }, confere: { regra: 'finalClass EXACT, autoReconciled false, autoBlockedReason UNTRUSTED_SOURCE', fn: (d) => d.finalClass === 'EXACT' && d.autoReconciled === false && d.autoBlockedReason === 'UNTRUSTED_SOURCE' } });
  const linha = (c) => ({ bankAccountId: c.baRec, amount: `-${V.dup}`, transactionDate: hoje, description: 'TARIFA SEM ID EXTERNO' });
  await R.http({ id: 'K05', linhas: ['M4-G§10'], titulo: 'Linha de extrato sem id externo (1ª vez)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions', corpo: linha, esperado: { status: 201 } });
  await R.http({ id: 'K06', linhas: ['M4-G§10'], titulo: 'A MESMA linha sem id externo de novo: recusada (UNIQUE(bank_account_id, fingerprint) completo)', quem: 'A:gestor', metodo: 'POST', rota: '/finance/bank-transactions', corpo: linha, esperado: { status: 409, codigo: 'FINANCE_BANK_TRANSACTION_DUPLICATE' } });
  await R.http({ id: 'K07', linhas: ['M4-G§10', 'M4-§21.15', 'M4-G§20.13'], titulo: 'Empresa B tenta gravar linha de extrato na conta bancária da empresa A: 404, nada gravado (achado crítico do pentest corrigido)', quem: 'B:gestor', metodo: 'POST', rota: '/finance/bank-transactions', corpo: (c) => ({ bankAccountId: c.baRec, amount: '-1.23', transactionDate: hoje, description: 'Tentativa de B' }), esperado: { status: 404, codigo: 'FINANCE_BANK_ACCOUNT_NOT_FOUND' } });
  await R.http({ id: 'K08', linhas: ['M4-G§11', 'M4-G§18.1', 'M4-G§20.8'], titulo: 'Checker publica a regra de comissão REG-FIN-001 (50%, arredondamento meio centavo para cima)', quem: 'A:checker', metodo: 'POST', rota: '/finance/commission-rule', corpo: { componentPercentages: { BROKER: 50 }, rounding: 'HALF_UP', description: 'Regra da captura M4CC' }, esperado: { status: 201 }, confere: { regra: 'ruleCode REG-FIN-001, rounding HALF_UP', fn: (d) => d.ruleCode === 'REG-FIN-001' && d.rounding === 'HALF_UP' } });
  for (const [k, valor, esperado] of [['K09', '0.29', '0.15'], ['K10', '0.01', '0.01'], ['K11', '1.13', '0.57']]) {
    await R.http({ id: `${k}a`, linhas: ['M4-G§18.1'], titulo: `Fato gerador de R$ ${valor.replace('.', ',')} a receber`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/entries', corpo: (c) => ({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: valor, description: `Fato gerador ${k} ${s}`, resultCenterId: c.rc2 }), esperado: { status: 201 }, guardar: (b, c) => { c[`fg${k}`] = b.data.id; } });
    await R.http({ id: `${k}b`, linhas: ['M4-G§11', 'M4-G§18.1', 'M4-G§20.8'], titulo: `Comissão de 50% sobre R$ ${valor.replace('.', ',')} = R$ ${esperado.replace('.', ',')} (decimal exato, um arredondamento)`, quem: 'A:gestor', metodo: 'POST', rota: '/finance/commissions', corpo: (c) => ({ beneficiaryUserId: c.makerUserId, sourceEntryId: c[`fg${k}`], component: 'BROKER', idempotencyKey: `m4cc-${k}-${s}` }), esperado: { status: 201 }, confere: { regra: `totalAmount = ${esperado}`, fn: (d) => String((d.commission || d).totalAmount) === esperado } });
  }
  await R.http({ id: 'K12', linhas: ['M4-G§11', 'M4-G§20.8'], titulo: 'Regra de comissão vigente: código REG-FIN-001 e arredondamento da versão', quem: 'A:leitura', metodo: 'GET', rota: '/finance/commission-rule', esperado: { status: 200 }, confere: { regra: 'ruleCode REG-FIN-001, rounding HALF_UP', fn: (d) => d.ruleCode === 'REG-FIN-001' && d.rounding === 'HALF_UP' } });
  await R.http({ id: 'K13', linhas: ['M4-G§13'], titulo: 'NAY Financeira lê o read model (analytics.rm_finance_health / rm_finance_sector_margin), não o ledger a cada pergunta', quem: 'A:leitura', metodo: 'GET', rota: '/finance/nay/insights', esperado: { status: 200 }, confere: { regra: 'fontes.readModel = analytics.rm_finance_health', fn: (d) => d.fontes && d.fontes.readModel === 'analytics.rm_finance_health' && Array.isArray(d.fontes.readModels) } });

  const A = R.tenant('A:gestor');
  await consulta(R, { id: 'Q40', linhas: ['M4-G§10'], descricao: 'Índice único do fingerprint do extrato sem condição (Guia §10)', tenant: A, sql: "select indexdef from pg_indexes where schemaname = 'finance' and indexname = 'bank_transactions_account_fingerprint_uk'", avaliar: (r) => r[0] && !/WHERE/.test(r[0].indexdef) && /\(bank_account_id, fingerprint\)/.test(r[0].indexdef), explicar: 'UNIQUE (bank_account_id, fingerprint), sem WHERE' });
  await consulta(R, { id: 'Q41', linhas: ['M4-G§10'], descricao: 'Linhas da conta com a descrição da tarifa repetida: só uma', tenant: A, replacements: { a: R.ctx.baRec }, sql: "select count(*)::int as n from finance.bank_transactions where bank_account_id = :a and description = 'TARIFA SEM ID EXTERNO'", avaliar: (r) => r[0].n === 1, explicar: 'exatamente 1 linha' });
  await consulta(R, { id: 'Q42', linhas: ['M4-G§11', 'M4-G§20.8'], descricao: 'Regra de comissão no Motor de Regras: código REG-FIN-001 (DEC-005), nenhuma comissão em REG-FIN-002', tenant: A, sql: "select r.code, count(v.id)::int as versoes from core.rules r join core.rule_versions v on v.rule_id = r.id where v.action_json ? 'components' group by r.code", avaliar: (r) => r.length === 1 && r[0].code === 'REG-FIN-001', explicar: 'só REG-FIN-001 tem versões de comissão' });
  await consulta(R, { id: 'Q43', linhas: ['M4-FIN-009', 'M4-§11.1'], descricao: 'Origem e confiança das linhas de extrato desta captura (CHECK: só arquivo/webhook/provedor podem ser confiáveis)', tenant: A, sql: 'select source, source_trusted, count(*)::int as n from finance.bank_transactions group by 1, 2 order by 1, 2', avaliar: (r) => !r.some((x) => x.source_trusted && ['MANUAL', 'LEGACY'].includes(x.source)), explicar: 'nenhuma linha MANUAL ou LEGACY confiável' });
};
