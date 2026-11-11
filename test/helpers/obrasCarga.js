'use strict';

/**
 * Apoio dos testes de concorrência, carga e falha de Obras (esteira do Guia M6 §13: "concurrency" e "load/failure tests").
 *   - parametros(): limites e tempos de scripts/ci-obras/parametros.json, com troca por OBRAS_<NOME> (nenhum número no teste);
 *   - comCommit(): transação COMMITADA de verdade na conexão própria (carga e falha precisam de commit/rollback reais);
 *   - montagem pelos SERVIÇOS reais: obra + etapa, medição até REVIEWED, aprovação, baixa preparada;
 *   - derrubarConexaoAntes(): falha REAL no meio da transação — encerra o processo do PostgreSQL da própria transação
 *     (pg_terminate_backend pela URL de administrador do banco descartável) antes de o passo seguinte rodar.
 * Só roda em banco descartável (DISPOSABLE_DB=1) ou no CI: os dados são commitados.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { sequelize, getSeedTenant, uniqueSuffix, prepareManualSettlement } = require('../testHelpers');

const svc = (nome) => require(path.join(__dirname, '..', '..', 'src', 'features', 'construction', `${nome}.service`));
const ARQUIVO_PARAMETROS = path.join(__dirname, '..', '..', 'scripts', 'ci-obras', 'parametros.json');

const podeRodar = Boolean(process.env.DISPOSABLE_DB || process.env.CI);
const motivoPular = podeRodar ? false : 'commita dados: rode com scripts/withDisposableDb.js (ou no CI)';

function parametros(env = process.env) {
  const { parametros: lista } = JSON.parse(fs.readFileSync(ARQUIVO_PARAMETROS, 'utf8'));
  const saida = {};
  for (const [nome, { valor }] of Object.entries(lista)) {
    const chaveEnv = `OBRAS_${nome.replace(/([A-Z0-9]+)/g, '_$1').toUpperCase()}`;
    const bruto = env[chaveEnv] !== undefined ? Number(env[chaveEnv]) : valor;
    if (!Number.isFinite(bruto) || bruto <= 0) throw new Error(`parâmetro ${nome} (${chaveEnv}) precisa ser número positivo; veio ${env[chaveEnv]}`);
    saida[nome] = bruto;
  }
  return saida;
}

const intervalo = (n) => Array.from({ length: n }, (_, i) => i);

function percentil(amostrasMs, p) {
  const ordenadas = [...amostrasMs].sort((a, b) => a - b);
  if (!ordenadas.length) return null;
  return ordenadas[Math.max(0, Math.min(ordenadas.length - 1, Math.ceil((p / 100) * ordenadas.length) - 1))];
}

const codigoPg = (err) => (err && ((err.original && err.original.code) || (err.parent && err.parent.code))) || null;

async function comCommit(tenant, fn, tentativa = 1) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
      replacements: { g: tenant.groupId, c: tenant.companyId, u: tenant.userId }, transaction: t,
    });
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback().catch(() => {});
    if (codigoPg(err) === '40P01' && tentativa < 5) return comCommit(tenant, fn, tentativa + 1);
    throw err;
  }
}

const W = (tenant, campos) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...campos });

async function obraComEtapa(tenant, t, rotulo, extras = {}) {
  const s = uniqueSuffix();
  const project = await svc('projects').createProject(W(tenant, { name: `O9 ${rotulo} ${s}`, budgetAmount: 100000, ...extras }), tenant.userId, t);
  const stage = await svc('projectStages').createProjectStage(project.id, W(tenant, { name: `Etapa ${rotulo}`, stageCode: `O9-${s}`, sequence: 1, plannedPct: 100, plannedCost: 50000 }), tenant.userId, t);
  return { project, stage };
}

/** Medição pelos serviços até REVIEWED (pronta para a decisão). Ponto único a ajustar se a regra de evidência da medição mudar. */
async function medicaoRevisada(tenant, rotulo, valor) {
  return comCommit(tenant, async (t) => {
    const { project, stage } = await obraComEtapa(tenant, t, rotulo);
    const m = svc('stageMeasurements');
    const med = await m.createStageMeasurement(stage.id, W(tenant, { measuredPct: 50, measuredAt: '2026-11-04', items: [{ description: `${rotulo} ${uniqueSuffix()}`, quantity: 1, unitPrice: valor }] }), tenant.userId, t);
    await m.submitStageMeasurement(med.id, tenant.userId, t);
    await m.reviewStageMeasurement(med.id, { notes: `conferido (${rotulo})` }, tenant.userId, t);
    return { projectId: project.id, stageId: stage.id, measurementId: med.id };
  });
}

const aprovar = (tenant, measurementId, t) => svc('stageMeasurements').decideStageMeasurement(measurementId, { decision: 'APPROVED' }, tenant.userId, t);

/** Medição aprovada (conta a pagar criada) e baixa preparada: comprovante anexado e aprovação de outra pessoa (regra do Financeiro). */
async function contaDaMedicaoProntaParaBaixa(tenant, rotulo, valor) {
  const fx = await medicaoRevisada(tenant, rotulo, valor);
  const aprovada = await comCommit(tenant, (t) => aprovar(tenant, fx.measurementId, t));
  const manualSettlement = await comCommit(tenant, (t) => prepareManualSettlement(tenant, aprovada.payableFinancialEntryId, tenant.userId, t));
  return { ...fx, entryId: aprovada.payableFinancialEntryId, manualSettlement };
}

async function contar(sql, replacements) {
  const [[linha]] = await sequelize.query(`SELECT count(*)::int AS n FROM (${sql}) x`, { replacements });
  return linha.n;
}

/** Linha bruta (superusuário do banco descartável, sem RLS) para conferir o estado final de verdade. */
async function linhaAdmin(sql, params = []) {
  const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

/**
 * Troca obj[metodo] por uma versão que, ANTES de chamar o original, encerra o processo do PostgreSQL da transação em curso
 * (pg_terminate_backend pelo administrador). O original roda numa conexão morta e a transação inteira cai: falha real de rede/banco
 * no meio do caminho, não uma exceção simulada. transacaoDe(args) diz onde está a transação nos argumentos; antes(t), se vier, lê
 * DENTRO da transação o que ela já tinha gravado quando a conexão caiu (prova de que a queda foi no meio). Devolve o restaurador.
 */
function derrubarConexaoAntes(obj, metodo, transacaoDe, antes) {
  if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL ausente: a falha real só roda no banco descartável');
  const original = obj[metodo];
  const estado = { derrubou: 0 };
  obj[metodo] = async function comQueda(...args) {
    const t = transacaoDe(args);
    if (t && !estado.derrubou) {
      if (antes) estado.antes = await antes(t);
      const [[{ pid }]] = await sequelize.query('SELECT pg_backend_pid() AS pid', { transaction: t });
      const [{ ok }] = await linhaAdmin('SELECT pg_terminate_backend($1) AS ok', [pid]);
      estado.derrubou = ok ? pid : 0;
    }
    return original.apply(this, args);
  };
  return { estado, restaurar: () => { obj[metodo] = original; } };
}

module.exports = {
  podeRodar, motivoPular, parametros, intervalo, percentil, codigoPg, comCommit, W, svc, obraComEtapa, medicaoRevisada, aprovar,
  contaDaMedicaoProntaParaBaixa, contar, linhaAdmin, derrubarConexaoAntes, sequelize, getSeedTenant, uniqueSuffix,
};
