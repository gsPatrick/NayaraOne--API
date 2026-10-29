'use strict';

/**
 * Estágios 13 a 16 (DEV, LAB, red-team, production approval): portões de ambiente que só um registro humano abre. O CI não faz push nem
 * deploy; ele apenas confere que existe o registro APPROVED em ai.release_gates (M9-D046, escopo GLOBAL, com quem aprovou e quando).
 */
const ITENS = Object.freeze({ 13: 'DEV_DEPLOY', 14: 'LAB_VALIDATION', 15: 'RED_TEAM', 16: 'PRODUCTION_APPROVAL' });
const TABELA_AUSENTE = '42P01';

const SQL = `SELECT id, evidence_ref, approved_by, approved_at FROM ai.release_gates
 WHERE scope_type = 'GLOBAL' AND item = $1 AND status = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL
 ORDER BY approved_at DESC LIMIT 1`;

/**
 * `consulta(sql, [item])` devolve as linhas. Resultado: { ok, motivo }. Sem registro aprovado (ou sem a tabela, ou sem conexão) o portão
 * fica vermelho. `exigeEvidencia`: o registro precisa citar a evidência (LAB: o relatório da suíte adversarial repetida em LAB).
 */
async function verificarPortao(consulta, item, { exigeEvidencia = false } = {}) {
  if (!consulta) return { ok: false, motivo: `sem registro de ${item}: informe AI_CI_RELEASE_DATABASE_URL (leitura de ai.release_gates do ambiente)` };
  let linhas;
  try {
    linhas = await consulta(SQL, [item]);
  } catch (err) {
    if (err && err.code === TABELA_AUSENTE) return { ok: false, motivo: `sem registro de ${item}: a tabela ai.release_gates não existe neste ambiente` };
    return { ok: false, motivo: `sem registro de ${item}: falha ao consultar ai.release_gates (${(err && err.code) || 'erro'})` };
  }
  if (!linhas.length) return { ok: false, motivo: `sem registro aprovado de ${item} em ai.release_gates` };
  if (exigeEvidencia && !String(linhas[0].evidence_ref || '').trim()) return { ok: false, motivo: `o registro de ${item} não cita a evidência (evidence_ref)` };
  return { ok: true, motivo: `${item} aprovado em ai.release_gates (registro ${linhas[0].id})` };
}

/** Consulta somente leitura ao ambiente informado em AI_CI_RELEASE_DATABASE_URL (segredo do CI; nunca escrito em log). */
async function abrirConsulta(url) {
  if (!url) return { consulta: null, fechar: async () => {} };
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  return { consulta: async (sql, params) => (await client.query(sql, params)).rows, fechar: () => client.end() };
}

module.exports = { ITENS, verificarPortao, abrirConsulta };
