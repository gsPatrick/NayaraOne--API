'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Inventário fechado das ações destrutivas ou críticas (M9-D852 §3.3, R34): docs/governance/destructive-actions.json.
 * Uma linha do livro pode ter mais de uma chave (linha 2: estornar lançamento e cancelar pagamento; linha 14: acionar e restaurar;
 * linha 13: revogar e criar credencial). `wired=false` = a rota ainda não existe e a demanda dona (ownerDemand) a entrega usando este núcleo.
 */
const FILE = path.join(__dirname, '../../../docs/governance/destructive-actions.json');
const LEVELS = [1, 2, 3];
const MFA_VALUES = ['sim', 'não', 'rota'];

function validate(actions) {
  const seen = new Set();
  for (const a of actions) {
    if (!a.key || seen.has(a.key)) throw new Error(`Inventário de ações destrutivas: chave repetida ou vazia (${a.key}).`);
    seen.add(a.key);
    if (!LEVELS.includes(a.level)) throw new Error(`Inventário de ações destrutivas: nível inválido em ${a.key}.`);
    if (!MFA_VALUES.includes(a.mfa)) throw new Error(`Inventário de ações destrutivas: MFA inválido em ${a.key}.`);
    if (!a.impact || !a.impact.path) throw new Error(`Inventário de ações destrutivas: ${a.key} sem rota de impacto.`);
  }
  return actions;
}

let cache = null;
function all() {
  if (!cache) cache = Object.freeze(validate(JSON.parse(fs.readFileSync(FILE, 'utf8')).actions).map((a) => Object.freeze(a)));
  return cache;
}

function get(key) {
  const found = all().find((a) => a.key === key);
  if (!found) throw new Error(`Ação destrutiva fora do inventário: ${key}.`);
  return found;
}

const wired = () => all().filter((a) => a.wired);
const unwired = () => all().filter((a) => !a.wired);

module.exports = { all, get, wired, unwired, FILE };
