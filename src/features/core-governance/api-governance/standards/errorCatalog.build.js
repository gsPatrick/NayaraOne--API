'use strict';

const { DEFAULT_PREFIX_EXCEPTIONS, GOV_PREFIX } = require('../../governance.errors');
const { scanDir } = require('./errorCatalog.scan');

/** Códigos da lista fechada da K4 (não levam GOV_) e legados que o contrato OpenAPI cita; sempre no catálogo. */
const BASE_CODES = Object.freeze({
  PERMISSION_DENIED: { status: 403, message: 'Você não tem permissão para realizar esta ação.', module: 'plataforma' },
  MISSING_ACCESS_TOKEN: { status: 401, message: 'Token de acesso ausente.', module: 'plataforma' },
  MFA_STEP_UP_REQUIRED: { status: 403, message: 'Confirme sua identidade com o código de verificação em duas etapas.', module: 'plataforma' },
  MFA_REQUIRED_NOT_ENABLED: { status: 403, message: 'Ative a verificação em duas etapas para continuar.', module: 'plataforma' },
  INTERNAL_ERROR: { status: 500, message: 'Erro interno.', module: 'plataforma' },
  VALIDATION_ERROR: { status: 400, message: 'Os dados enviados são inválidos.', module: 'plataforma' },
  AUTH_VALIDATION: { status: 400, message: 'Os dados de acesso enviados são inválidos.', module: 'plataforma' },
  LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE: { status: 409, message: 'Esta vistoria já tem assinatura registrada e ficou imutável.', module: 'legal' },
  MKT_PAGE_NOT_FOUND: { status: 404, message: 'Página não encontrada.', module: 'marketing' },
  MKT_PAGE_GONE: { status: 410, message: 'Esta página não está mais disponível.', module: 'marketing' },
});

const moduleOf = (files) => { const first = [...files][0] || ''; return first.includes('/') ? first.split('/')[0] : 'core-governance'; };

/** Atualiza o catálogo com o que a varredura achou: mantém o que já existe (versão de origem, descontinuação, texto) e acrescenta o novo com `since`. */
function buildCatalog({ dir, data, since }) {
  const scan = scanDir(dir);
  const codes = { ...data.codes };
  for (const [code, base] of Object.entries(BASE_CODES)) if (!codes[code]) codes[code] = { ...base, since, deprecated: false };
  const wanted = new Set([...scan.literals, ...scan.used.keys()].filter((code) => code.startsWith(GOV_PREFIX)));
  for (const code of wanted) {
    const found = scan.used.get(code);
    const current = codes[code] || { since, deprecated: false };
    codes[code] = {
      status: current.status || (found && found.status) || 0,
      message: current.message || (found && found.message) || '',
      module: current.module || moduleOf(found ? found.files : []),
      since: current.since,
      deprecated: Boolean(current.deprecated),
    };
  }
  return { codes };
}

/** Problemas do catálogo contra o código: [{ rule, code, where, message }]. Vazio = ok. */
function checkCatalog({ dir, data, exceptions = DEFAULT_PREFIX_EXCEPTIONS }) {
  const scan = scanDir(dir);
  const problems = [];
  const known = (code) => Boolean(data.codes[code]);
  for (const call of scan.calls) {
    if (!call.code.startsWith(GOV_PREFIX) && !exceptions.includes(call.code)) problems.push({ rule: 'GOV_ERROR_CODE_PREFIX', code: call.code, where: `${call.file}:${call.line}`, message: `Código fora do padrão ${GOV_PREFIX}: ${call.code} (${call.file}:${call.line}).` });
    else if (!known(call.code)) problems.push({ rule: 'GOV_ERROR_CODE_UNKNOWN', code: call.code, where: `${call.file}:${call.line}`, message: `Código de erro não catalogado: ${call.code}.` });
  }
  for (const code of scan.literals) if (!known(code) && !scan.calls.some((c) => c.code === code)) problems.push({ rule: 'GOV_ERROR_CODE_UNKNOWN', code, where: 'literal', message: `Código de erro não catalogado: ${code}.` });
  for (const [code, entry] of Object.entries(data.codes)) {
    if (!entry.status || !String(entry.message).trim() || !entry.module || !entry.since) problems.push({ rule: 'GOV_ERROR_CODE_INCOMPLETE', code, where: 'catálogo', message: `Entrada incompleta no catálogo: ${code} (falta status, mensagem, módulo ou versão).` });
  }
  return problems;
}

module.exports = { buildCatalog, checkCatalog, BASE_CODES };
