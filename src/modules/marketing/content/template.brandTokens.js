'use strict';

const { TEMPLATE_CHANNELS } = require('./template.constants');
const { brandTokensInvalid } = require('./template.errors');

const ALLOWED_KEYS = ['colors', 'fonts', 'logo', 'margins', 'proportions'];
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 50;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkMap(name, value, problems, checkValue) {
  if (!isPlainObject(value)) { problems.push(`${name} deve ser um objeto.`); return; }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) problems.push(`${name} aceita até ${MAX_ENTRIES} itens.`);
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k) && name !== 'proportions') problems.push(`${name}.${k}: nome inválido.`);
    else checkValue(k, v);
  }
}

/** Valida o formato dos tokens de marca (sem acessar o banco). Devolve a lista de problemas (vazia = válido). */
function collectBrandTokenProblems(tokens) {
  const problems = [];
  if (!isPlainObject(tokens)) return ['brandTokens deve ser um objeto.'];
  for (const key of Object.keys(tokens)) if (!ALLOWED_KEYS.includes(key)) problems.push(`Campo desconhecido em brandTokens: ${key}.`);
  if (tokens.colors !== undefined) {
    checkMap('colors', tokens.colors, problems, (k, v) => { if (typeof v !== 'string' || !HEX_RE.test(v)) problems.push(`colors.${k}: use cor hexadecimal (#RGB ou #RRGGBB).`); });
  }
  if (tokens.fonts !== undefined) {
    checkMap('fonts', tokens.fonts, problems, (k, v) => { if (typeof v !== 'string' || !v.trim() || v.length > 80) problems.push(`fonts.${k}: informe o nome da fonte (até 80 caracteres).`); });
  }
  if (tokens.margins !== undefined) {
    checkMap('margins', tokens.margins, problems, (k, v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000) problems.push(`margins.${k}: use número de 0 a 10000.`); });
  }
  if (tokens.proportions !== undefined) {
    checkMap('proportions', tokens.proportions, problems, (k, v) => {
      if (!TEMPLATE_CHANNELS.includes(k)) problems.push(`proportions.${k}: canal desconhecido.`);
      else if (!isPlainObject(v) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.height < 1 || v.width > 20000 || v.height > 20000) {
        problems.push(`proportions.${k}: informe width e height inteiros maiores que zero.`);
      }
    });
  }
  if (tokens.logo !== undefined) {
    const logo = tokens.logo;
    if (!isPlainObject(logo) || typeof logo.fileId !== 'string' || !UUID_RE.test(logo.fileId)) problems.push('logo.fileId deve ser o id de um arquivo do módulo de arquivos.');
    else if (typeof logo.sha256 !== 'string' || !SHA_RE.test(logo.sha256)) problems.push('logo.sha256 deve ser o SHA-256 do arquivo (64 caracteres hexadecimais minúsculos).');
  }
  return problems;
}

/** Normaliza (descarta undefined) e valida o formato; lança 422 MKT_TEMPLATE_BRAND_TOKENS_INVALID. */
function normalizeBrandTokens(tokens) {
  const clean = tokens === undefined || tokens === null ? {} : JSON.parse(JSON.stringify(tokens));
  const problems = collectBrandTokenProblems(clean);
  if (problems.length > 0) throw brandTokensInvalid(problems);
  return clean;
}

/** O logotipo precisa existir na empresa (RLS) e o SHA-256 informado precisa ser o do arquivo guardado pelo módulo de arquivos. */
async function assertLogoMatchesFile(tokens, transaction) {
  if (!tokens.logo) return;
  // require tardio: evita ciclo de carga entre os models e o módulo.
  const { getFileMetadata } = require('../../../features/files/files.service');
  let file;
  try {
    file = await getFileMetadata(tokens.logo.fileId, transaction);
  } catch (err) {
    if (err && err.statusCode === 404) throw brandTokensInvalid(['logo.fileId: arquivo não encontrado.']);
    throw err;
  }
  const stored = file.checksumSha256 ? String(file.checksumSha256).toLowerCase() : null;
  if (!stored) throw brandTokensInvalid(['logo.sha256: o arquivo não tem SHA-256 registrado.']);
  if (stored !== tokens.logo.sha256) throw brandTokensInvalid(['logo.sha256: não confere com o SHA-256 do arquivo.']);
}

module.exports = { collectBrandTokenProblems, normalizeBrandTokens, assertLogoMatchesFile };
