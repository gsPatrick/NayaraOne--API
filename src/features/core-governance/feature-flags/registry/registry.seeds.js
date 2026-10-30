'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KEY_RE, KEY_MAX, RISKS } = require('../flags.constants');

/** Erro de validação de um seed, com o código do catálogo (a mensagem é a do livro). */
function seedError(code, message, seed, key) {
  return Object.assign(new Error(`${code} ${message} [${seed}${key ? `: ${key}` : ''}]`), { code });
}

function normalize(domain, seed, raw) {
  const where = raw && raw.key;
  const fail = (code, message) => { throw seedError(code, message, seed, where); };
  if (!raw || typeof raw.key !== 'string' || raw.key.length > KEY_MAX || !KEY_RE.test(raw.key)) fail('GOV_FLAG_INPUT_INVALID', 'A chave deve ter o formato dominio.recurso.nome, em minúsculas.');
  if (typeof raw.owner !== 'string' || !raw.owner.trim()) fail('GOV_FLAG_OWNER_REQUIRED', 'Informe o responsável pela chave.');
  const risk = raw.risk === undefined ? 'MEDIUM' : String(raw.risk).toUpperCase();
  if (!RISKS.includes(risk)) fail('GOV_FLAG_INPUT_INVALID', `Risco desconhecido: ${risk}.`);
  if (raw.temporary !== undefined && typeof raw.temporary !== 'boolean') fail('GOV_FLAG_INPUT_INVALID', '"temporary" deve ser verdadeiro ou falso.');
  let validUntil = null;
  if (raw.validUntil !== undefined && raw.validUntil !== null) {
    const date = new Date(raw.validUntil);
    if (typeof raw.validUntil !== 'string' || Number.isNaN(date.getTime())) fail('GOV_FLAG_INPUT_INVALID', 'Data inválida em "validUntil".');
    validUntil = date.toISOString();
  }
  if (raw.temporary === true && !validUntil) fail('GOV_FLAG_EXPIRY_REQUIRED', 'Flag temporária precisa de data de expiração.');
  return {
    key: raw.key, domain, owner: raw.owner.trim(), risk, temporary: raw.temporary === true, validUntil, killSwitch: raw.killSwitch === true,
    probe: typeof raw.probe === 'string' && raw.probe ? raw.probe : null, description: typeof raw.description === 'string' ? raw.description : null, seed,
  };
}

/**
 * Lê os seeds (`*.seed.js`, cada um `{ domain, flags: [...] }`) de uma pasta e devolve as flags declaradas, validadas, ordenadas pela chave. Chave repetida entre seeds reprova
 * (GOV_FLAG_DUPLICATE). O CI só enxerga o que está versionado aqui; as flags criadas em tempo de execução são cobertas pelo job de expiração (M9-D871 §3.3).
 */
function loadSeedFlags(dir) {
  const flags = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.seed.js')).sort() : [];
  for (const file of files) {
    const seed = require(path.resolve(dir, file));
    if (!seed || !Array.isArray(seed.flags)) throw seedError('GOV_FLAG_INPUT_INVALID', 'O seed deve exportar { domain, flags: [...] }.', file);
    for (const raw of seed.flags) {
      const flag = normalize(String(seed.domain || file.replace('.seed.js', '')), file, raw);
      if (flags.some((f) => f.key === flag.key)) throw seedError('GOV_FLAG_DUPLICATE', 'Já existe uma chave igual neste escopo.', file, flag.key);
      flags.push(flag);
    }
  }
  return flags.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = { loadSeedFlags };
