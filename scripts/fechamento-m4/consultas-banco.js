'use strict';
/**
 * Consultas SOMENTE LEITURA ao banco descartável, sempre no contexto RLS do tenant (SET LOCAL), com
 * invariantes avaliados: saldos = soma dos movimentos, append-only, RLS, eventos com nome literal e
 * amostras do audit_log com antes/depois (ação com rótulo em português).
 */
const { sequelize } = require('../../src/models');
const { inTenant } = require('./ambiente');

const ROTULOS = {
  'finance.entry.create': 'Lançamento criado',
  'finance.entry.settle': 'Baixa integral',
  'finance.entry.settle_partial': 'Baixa parcial',
  'finance.entry.reverse': 'Estorno',
  'finance.financial_entry.row_change': 'Alteração registrada pelo gatilho do banco',
  'finance.payment_intent.create': 'Intenção de pagamento criada',
  'finance.payment_intent.approve': 'Intenção de pagamento aprovada',
  'finance.approval_request.create': 'Solicitação de aprovação aberta',
  'finance.approval_step.decide': 'Decisão de aprovação',
  'finance.owner_repasse.create': 'Repasse criado',
  'finance.owner_repasse.approve': 'Repasse aprovado',
  'finance.owner_repasse.pay': 'Repasse pago',
  'finance.commission.create': 'Comissão criada',
  'finance.commission.cancel': 'Comissão cancelada',
  'finance.intercompany_transfer.create': 'Transferência entre empresas pedida',
  'finance.intercompany_transfer.approve': 'Transferência entre empresas aprovada',
  'finance.period.close': 'Pedido de fechamento',
  'finance.period.approve': 'Fechamento aprovado',
  'finance.period.reopen': 'Período reaberto',
  'finance.reconciliation.match': 'Conciliação confirmada',
};

async function consulta(R, { id, linhas, descricao, sql, tenant, companyId, replacements, avaliar, explicar }) {
  let resultado;
  let erro = null;
  try {
    resultado = await inTenant(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0], companyId);
  } catch (err) { erro = err.message; }
  const invarianteOk = erro ? false : avaliar ? !!avaliar(resultado) : true;
  R.consultas.push({ id, linhas, descricao, sql: sql.replace(/\s+/g, ' ').trim(), contexto: `RLS do tenant (company ${companyId || tenant.companyId})`, resultado: erro ? { erro } : resultado, invariante: explicar || 'listagem (sem invariante numérico)', invarianteOk, quando: new Date().toISOString() });
  if (!invarianteOk) console.error(`[captura] INVARIANTE FALHOU ${id}: ${erro || JSON.stringify(resultado).slice(0, 300)}`);
}

module.exports = async function consultas(R) {
  const A = R.tenant('A:gestor');
  const B = R.tenant('B:gestor');
  const c = R.ctx;
  const cents = (v) => Math.round(Number(v) * 100);

  await consulta(R, { id: 'Q01', linhas: ['M4-G§20.2'], descricao: 'Role usada pela API: sem superusuário e sem bypass de RLS', tenant: A, sql: 'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user', avaliar: (r) => r[0] && !r[0].rolsuper && !r[0].rolbypassrls, explicar: 'rolsuper = false e rolbypassrls = false' });
  await consulta(R, { id: 'Q02', linhas: ['M4-§10.3', 'M4-FIN-TS-006'], descricao: 'Recebível de R$ 0,30: pai, baixas filhas e saldo = valor − Σ baixas SETTLED', tenant: A, replacements: { id: c.rec }, sql: `select p.id, p.amount, p.status, p.settled_at, (select count(*) from finance.financial_entries f where f.parent_entry_id = p.id and f.status = 'SETTLED')::int as baixas, (select coalesce(sum(f.amount),0) from finance.financial_entries f where f.parent_entry_id = p.id and f.status = 'SETTLED') as baixado, p.amount - (select coalesce(sum(f.amount),0) from finance.financial_entries f where f.parent_entry_id = p.id and f.status = 'SETTLED') as saldo from finance.financial_entries p where p.id = :id`, avaliar: (r) => r[0] && cents(r[0].amount) === 30 && r[0].baixas === 2 && cents(r[0].saldo) === 0 && r[0].status === 'SETTLED', explicar: 'valor 0,30; 2 baixas; saldo 0,00; status SETTLED' });
  await consulta(R, { id: 'Q03', linhas: ['M4-§10.3', 'M4-G§16.6'], descricao: 'Saldo restante após cada baixa do recebível de R$ 0,30 (soma acumulada em ordem de liquidação)', tenant: A, replacements: { id: c.rec }, sql: `select f.id, f.amount, f.status, f.settled_at, f.idempotency_key, sum(f.amount) over (order by f.created_at) as baixado_acumulado, (select amount from finance.financial_entries where id = :id) - sum(f.amount) over (order by f.created_at) as saldo_restante from finance.financial_entries f where f.parent_entry_id = :id order by f.created_at`, avaliar: (r) => r.length === 2 && cents(r[0].saldo_restante) === 20 && cents(r[1].saldo_restante) === 0, explicar: 'saldo 0,20 após a 1ª baixa e 0,00 após a 2ª' });
  await consulta(R, { id: 'Q04', linhas: ['M4-§5.7', 'M4-§6.2'], descricao: 'Movimentos do recebível em finance.ledger (CREDIT, um por baixa)', tenant: A, replacements: { id: c.rec }, sql: 'select id, financial_entry_id, movement_type, direction, amount, idempotency_key, occurred_at from finance.ledger where financial_entry_id = :id order by occurred_at', avaliar: (r) => r.length === 2 && r.every((x) => x.direction === 'CREDIT'), explicar: '2 movimentos CREDIT' });
  await consulta(R, { id: 'Q05', linhas: ['M4-FIN-015'], descricao: 'Trilha de auditoria do recebível de R$ 0,30 (antes/depois)', tenant: A, replacements: { id: c.rec }, sql: 'select action, user_id, before_json, after_json, reason, occurred_at from audit.audit_log where entity_id = :id order by occurred_at', avaliar: (r) => r.some((x) => x.action === 'finance.entry.create') && r.filter((x) => x.action === 'finance.entry.settle_partial').length === 2, explicar: '1 criação e 2 baixas parciais na trilha' });
  await consulta(R, { id: 'Q06', linhas: ['M4-FIN-003', 'M4-G§20.3'], descricao: 'Gatilhos de imutabilidade (append-only) em financial_entries e audit_log', tenant: A, sql: "select c.relname as tabela, t.tgname as gatilho from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and ((n.nspname = 'finance' and c.relname = 'financial_entries') or (n.nspname = 'audit' and c.relname = 'audit_log')) order by 1, 2", avaliar: (r) => r.length >= 2, explicar: 'há gatilhos nas duas tabelas' });
  await consulta(R, { id: 'Q07', linhas: ['M4-FIN-008', 'M4-G§18.1'], descricao: 'Nenhuma coluna de dinheiro em ponto flutuante no schema finance', tenant: A, sql: "select table_name, column_name, data_type from information_schema.columns where table_schema = 'finance' and data_type in ('real', 'double precision')", avaliar: (r) => r.length === 0, explicar: '0 colunas real/double precision' });
  await consulta(R, { id: 'Q08', linhas: ['M4-§5.1', 'M4-§5.6', 'M4-§5.15'], descricao: 'As 19 tabelas/views do §5 existem com os nomes literais', tenant: A, sql: "select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'finance' and c.relname in ('accounts_chart','cost_centers','result_centers','bank_accounts','financial_entries','entry_installments','ledger','bank_transactions','reconciliations','approval_requests','approval_steps','commissions','commission_installments','owner_repasses','security_deposits','intercompany_transfers','closing_periods','budgets_forecasts','anomaly_cases') order by 1", avaliar: (r) => r.length === 19, explicar: '19 objetos encontrados' });
  await consulta(R, { id: 'Q09', linhas: ['M4-FIN-001', 'M4-G§17.11'], descricao: 'RLS ligada e forçada nas tabelas do Financeiro (exceto a tabela de roteamento do webhook bancário, que só guarda id externo -> empresa para o callback público achar o tenant)', tenant: A, sql: "select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'finance' and c.relkind = 'r' and c.relname not like '%provider_routing' order by 1", avaliar: (r) => r.length > 0 && r.every((x) => x.relrowsecurity && x.relforcerowsecurity), explicar: 'todas com relrowsecurity e relforcerowsecurity' });
  await consulta(R, { id: 'Q10', linhas: ['M4-FIN-TS-020'], descricao: 'No contexto do tenant B, os lançamentos do tenant A não existem (0 linhas)', tenant: B, replacements: { ids: [c.rec, c.pg, c.idem].filter(Boolean) }, sql: 'select count(*)::int as visiveis from finance.financial_entries where id in (:ids)', avaliar: (r) => r[0].visiveis === 0, explicar: '0 visíveis' });
  await consulta(R, { id: 'Q11', linhas: ['M4-G§14.1', 'M4-G§14.4', 'M4-G§14.10'], descricao: 'Eventos finance.* gravados no outbox na mesma transação (nomes literais do Guia §14)', tenant: A, sql: "select event_type, count(*)::int as quantidade from integration.outbox_events where event_type like 'finance.%' group by 1 order by 1", avaliar: (r) => r.length > 0, explicar: 'há eventos finance.* (a lista mostra os nomes)' });
  await consulta(R, { id: 'Q12', linhas: ['M4-§5.10', 'M4-G§20.5'], descricao: 'Intenções de pagamento com snapshot e hash gravados', tenant: A, sql: 'select id, status, snapshot_hash is not null as tem_hash, length(snapshot_hash) as tamanho_hash, idempotency_key is not null as tem_chave from finance.payment_intents order by created_at', avaliar: (r) => r.length > 0 && r.every((x) => x.tem_hash), explicar: 'todas com snapshot_hash (a chave de idempotência é gravada no envio ao banco)' });
  await consulta(R, { id: 'Q13', linhas: ['M4-G§10', 'M4-§7'], descricao: 'Índices únicos de idempotência no schema finance (extrato, lançamentos, intenções, comissões, repasses)', tenant: A, sql: "select tablename, indexname, indexdef from pg_indexes where schemaname = 'finance' and indexdef ilike '%unique%' and tablename in ('bank_transactions','financial_entries','payment_intents','commissions','owner_repasses') order by 1, 2", avaliar: (r) => r.some((x) => x.tablename === 'bank_transactions') && r.some((x) => /idempotency_key/i.test(x.indexdef)), explicar: 'unicidade no extrato e nas chaves de idempotência' });
  await consulta(R, { id: 'Q14', linhas: ['M4-FIN-TS-016', 'M4-§15'], descricao: 'Transferência entre empresas: os dois lados vinculados pelo id da transferência', tenant: A, sql: 'select id, from_company_id, to_company_id, amount, status, from_entry_id, to_entry_id, reason, evidence_file_id is not null as tem_documento from finance.intercompany_transfers order by created_at', avaliar: (r) => r.some((x) => x.from_entry_id && x.to_entry_id && x.from_company_id !== x.to_company_id), explicar: 'lado de saída e de entrada preenchidos, empresas diferentes' });
  await consulta(R, { id: 'Q15', linhas: ['M4-§16.1', 'M4-§5.17'], descricao: `Fechamentos (closing_periods) do mês ${c.mesFechado} e do mês do ajuste`, tenant: A, replacements: { m: [c.mesFechado, c.mesAjuste].filter(Boolean) }, sql: 'select * from finance.closing_periods where reference_month in (:m) order by reference_month', avaliar: (r) => r.length >= 1, explicar: 'fechamentos registrados' });
  await consulta(R, { id: 'Q16', linhas: ['M4-§14.2', 'M4-§21.8'], descricao: 'Comissões com rule_version_id, base e percentual gravados', tenant: A, sql: 'select id, component, base_amount, percentage, rule_version_id is not null as tem_versao, status from finance.commissions order by created_at', avaliar: (r) => r.length > 0 && r.every((x) => x.tem_versao), explicar: 'todas com versão da regra' });
  await consulta(R, { id: 'Q17', linhas: ['M4-FIN-006', 'M4-§13.2'], descricao: 'Caução marcada como dinheiro de terceiros e separada da receita própria', tenant: A, sql: 'select is_third_party_funds, nature, status, count(*)::int as qtd, sum(amount) as total from finance.financial_entries where is_third_party_funds = true group by 1, 2, 3 order by 1, 2, 3', avaliar: (r) => r.length > 0, explicar: 'lançamentos de terceiros existem e são listados à parte' });
  await consulta(R, { id: 'Q18', linhas: ['M4-§12.5'], descricao: 'Repasses: bruto, descontos com motivo, líquido e status', tenant: A, sql: 'select id, gross_amount, deductions_amount, deductions_reason, net_amount, status, reference_month from finance.owner_repasses order by created_at', avaliar: (r) => r.some((x) => x.status === 'PAID'), explicar: 'há repasse PAID' });
  await consulta(R, { id: 'Q19', linhas: ['M4-§19.7', 'M4-§11.5'], descricao: 'Transações bancárias sem conciliação (pendências) por conta', tenant: A, sql: 'select bt.bank_account_id, count(*)::int as pendentes, sum(abs(bt.amount)) as valor from finance.bank_transactions bt where not exists (select 1 from finance.reconciliations r where r.bank_transaction_id = bt.id) group by 1', avaliar: () => true });
  await consulta(R, {
    id: 'Q20', linhas: ['M4-FIN-015', 'M4-§16.4'], descricao: 'Amostras do audit_log das ações do marco, com antes/depois', tenant: A, replacements: { acoes: Object.keys(ROTULOS) },
    sql: 'select distinct on (action) action, entity_type, entity_id, before_json, after_json, reason, occurred_at from audit.audit_log where action in (:acoes) order by action, occurred_at desc',
    avaliar: (r) => { r.forEach((x) => { x.rotulo = ROTULOS[x.action] || x.action; if (x.before_json === null) x.before_json = 'Não existia (registro criado nesta ação)'; }); return r.length > 5; },
    explicar: 'mais de 5 tipos de ação do marco auditados',
  });
};
