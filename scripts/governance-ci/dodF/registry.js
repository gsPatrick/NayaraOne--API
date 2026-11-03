'use strict';

const path = require('node:path');
const { LeituraError } = require('./erros');
const { RAIZ_API } = require('./config');
const { rodar, rodarSuite } = require('./processo');
const { withClient } = require('../../lib/classificationDb');

const NOME = 'governance registry';
const SQL_RETENCAO = `SELECT
  (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'governance' AND table_name = 'data_classification_registry' AND column_name = 'retention_policy_id') AS anulavel,
  (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'governance.data_classification_registry'::regclass AND contype = 'f' AND confrelid = 'governance.retention_policies'::regclass) AS fks,
  (SELECT count(*)::int FROM governance.data_classification_registry WHERE retention_policy_id IS NULL) AS sem_politica`;

/** Cobertura: 100% das colunas de negócio do banco migrado têm entrada no inventário (checkClassificationCoverage.js, banco descartável). */
function cobertura() {
  const r = rodar(process.execPath, [path.join(RAIZ_API, 'scripts', 'checkClassificationCoverage.js'), '--json']);
  if (r.status === 2) throw new LeituraError(`a conferência de classificação não leu o banco: ${r.out.trim().slice(0, 160)}`);
  let j;
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_e) { throw new LeituraError('a saída de checkClassificationCoverage.js não é JSON'); }
  if (r.status !== 0 || j.missing.length) return { ok: false, motivo: `${j.missing.length} coluna(s) sem classificação (GOV_CLASSIFICATION_MISSING ${j.missing.slice(0, 3).join(', ')}${j.missing.length > 3 ? ', ...' : ''})` };
  if (j.percent !== 100) return { ok: false, motivo: `cobertura de classificação ${j.percent}%` };
  return { ok: true, motivo: `cobertura de classificação 100% (${j.total} colunas)` };
}

/** Retenção em toda linha: retention_policy_id é obrigatório e aponta para a política da M9-D911; nenhuma linha do registro fica sem política. */
async function retencao() {
  const r = (await withClient((c) => c.query(SQL_RETENCAO))).rows[0];
  if (r.anulavel !== 'NO' || r.fks !== 1) return { ok: false, motivo: 'retention_policy_id do registro de classificação não é obrigatório com chave para a política de retenção' };
  if (r.sem_politica > 0) return { ok: false, motivo: `${r.sem_politica} linha(s) do registro sem política de retenção` };
  return { ok: true, motivo: 'política de retenção obrigatória em toda linha do registro' };
}

/** Item 2: cobertura 100%, retenção em toda linha e a suíte do registro (D910, D911, D912, D915, incluindo legal hold bloqueando a disposição) verde. */
async function verificar({ cfg }) {
  const etapas = [['classificação', cobertura], ['retenção', retencao], ['suíte', async () => rodarSuite(cfg.registry.suites)]];
  const partes = [];
  let naoAplicavel = 0;
  for (const [rotulo, etapa] of etapas) {
    const r = await etapa();
    if (!r.ok) return { nome: NOME, ok: false, motivo: `${rotulo}: ${r.motivo}` };
    naoAplicavel += r.naoAplicavel || 0;
    partes.push(`${rotulo}: ${r.motivo}`);
  }
  // Parte da suíte não executou por falta de artefato irmão (CI só com a API): o item não é "OK", é NAO_APLICAVEL_NO_CI (visível e contado à parte).
  if (naoAplicavel) return { nome: NOME, ok: true, situacao: 'NAO_APLICAVEL_NO_CI', motivo: `NAO_APLICAVEL_NO_CI em ${naoAplicavel} teste(s), o resto verde; ${partes.join('; ')}` };
  return { nome: NOME, ok: true, motivo: partes.join('; ') };
}

module.exports = { verificar, NOME, precisaBanco: true };
