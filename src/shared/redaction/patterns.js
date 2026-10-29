'use strict';

/**
 * Biblioteca única de redaction (M9-D246): AQUI moram todas as expressões e validações que reconhecem
 * dado sensível (segredo, documento, cartão, e-mail, telefone). Nenhum outro arquivo de src/ pode ter
 * detecção própria (teste de arquitetura `redaction_biblioteca_unica_sem_regex_de_deteccao_duplicada`).
 * Perfis (log, erro, texto livre público, ...) só mudam o formato de saída.
 */
const SOURCES = Object.freeze({
  jwt: 'eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]*',
  bearer: '\\bBearer\\s+[A-Za-z0-9._~+/=-]+',
  pem: '-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:[\\s\\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----|[\\s\\S]*$)',
  pemHeader: '-----BEGIN ',
  connectionPassword: '([a-z][a-z0-9+.-]*:\\/\\/[^/\\s:@]+:)([^@\\s/]+)(@)',
  assignment: '\\b(api[_-]?key|x-api-key|client[_-]?secret|webhook[_-]?secret|secret|(?:access|refresh|id)[_-]?token|token|password|passwd|senha|private[_-]?key)(["\']?\\s*[:=]\\s*["\']?)([^\\s"\',;&]+)',
  keywordValue: '\\b(token|secret|segredo|password|senha|apikey|credential|credencial)(\\s+)([^\\s"\',;]{8,})',
  // Token na própria URL das rotas públicas por link (M9-D823: /public/share/<token>): o log de requisição não pode gravá-lo em claro.
  publicToken: '(\\/public\\/share\\/)[A-Za-z0-9_-]{20,}',
  awsKey: '\\bAKIA[0-9A-Z]{16}\\b',
  providerKey: '\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+',
  slackToken: '\\bxox[baprs]-[A-Za-z0-9-]+',
  githubToken: '\\bghp_[A-Za-z0-9]{20,}',
  openAiKey: '\\bsk-[a-z0-9]{12,}',
  cpfFormatted: '(?<![\\w.])\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}(?![\\w])',
  cpfBare: '(?<![\\w.-])\\d{11}(?![\\w.-])',
  cnpjFormatted: '(?<![\\w.])\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}(?![\\w])',
  cnpjBare: '(?<![\\w.-])\\d{14}(?![\\w.-])',
  cardCandidate: '(?<![\\w.-])\\d(?:[ -]?\\d){12,18}(?![\\w.-])',
  email: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+',
  phone: '(?:\\+55[\\s.-]?)?\\(\\d{2}\\)[\\s.-]?9?\\d{4}[\\s.-]?\\d{4}(?!\\d)|\\+55[\\s.-]?\\d{2}[\\s.-]?9?\\d{4}[\\s.-]?\\d{4}(?!\\d)|(?<!\\d)\\d{2}\\s9\\d{4}[\\s-]?\\d{4}(?!\\d)',
  phoneLoose: '(?:\\+?55\\s?)?\\(?\\d{2}\\)?\\s?9?\\d{4}[-\\s]?\\d{4}',
  localPhone: '(?<![\\d-])9?\\d{4}-\\d{4}(?!\\d)',
  cpfLoose: '\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}',
  cnpjLoose: '\\d{2}\\.?\\d{3}\\.?\\d{3}\\/?\\d{4}-?\\d{2}',
  emailLoose: '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
  // Perfil `ai` (M9-D027): tipos além de documento/cartão/e-mail/telefone. Os rótulos ("RG", "conta", "agência", "pix") evitam
  // mascarar número comum; o que tem formato próprio (linha digitável, CEP com hífen) dispensa rótulo.
  rgLabeled: '(\\bRG\\b\\s*(?:n[º°o]\\.?)?\\s*[:=-]?\\s*)(\\d{1,2}\\.?\\d{3}\\.?\\d{3}-?[\\dxX]\\b)',
  rgFormatted: '(?<![\\d.])\\d{2}\\.\\d{3}\\.\\d{3}-[\\dxX](?![\\w-])',
  pixLabeled: '(\\b(?:chave\\s+)?pix\\b\\s*[:=-]?\\s*)([A-Za-z0-9._%+@-]{8,})',
  boletoFormatted: '(?<!\\d)\\d{5}\\.\\d{5}\\s\\d{5}\\.\\d{6}\\s\\d{5}\\.\\d{6}\\s\\d\\s\\d{14}(?!\\d)',
  boletoDigits: '(?<![\\d.-])(?:\\d{47}|\\d{48})(?![\\d.-])',
  agencyLabeled: '(\\bag(?:[eê]ncia|\\.)?\\s*(?:n[º°o]\\.?)?\\s*[:=-]?\\s*)(\\d{3,5}(?:-[\\dxX])?\\b)',
  accountLabeled: '(\\b(?:conta(?:\\s+(?:corrente|poupan[cç]a))?|c\\/c|cc|c\\.c\\.)\\s*(?:n[º°o]\\.?)?\\s*[:=-]?\\s*)(\\d{4,12}-?[\\dxX]\\b)',
  addressPattern: '\\b(?:rua|avenida|av\\.|alameda|travessa|rodovia|estrada|pra[cç]a)\\s+[^\\n,;.]{2,60}?,?\\s*(?:n[º°o]?\\.?\\s*)?\\d{1,6}(?:\\s*[,-]\\s*[^\\n,;]{2,40})?',
  cepFormatted: '(?<![\\d.-])\\d{5}-\\d{3}(?![\\d-])',
  cepLabeled: '(\\bCEP\\b\\s*[:=-]?\\s*)(\\d{8}\\b)',
});

/** Cria uma RegExp nova (nunca compartilhada: flag `g` guarda estado em `lastIndex`). */
function rx(name, flags = 'g') {
  if (!SOURCES[name]) throw new Error(`Padrão de redaction desconhecido: ${name}`);
  return new RegExp(SOURCES[name], flags);
}

const onlyDigits = (text) => String(text).replace(/\D/g, '');

function luhnValid(text) {
  const digits = onlyDigits(text);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function checkDigit(digits, length, startWeight, weights) {
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (digits.charCodeAt(i) - 48) * (weights ? weights[i] : startWeight - i);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function cpfValid(text) {
  const d = onlyDigits(text);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  return checkDigit(d, 9, 10) === d.charCodeAt(9) - 48 && checkDigit(d, 10, 11) === d.charCodeAt(10) - 48;
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function cnpjValid(text) {
  const d = onlyDigits(text);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  return checkDigit(d, 12, 0, CNPJ_W1) === d.charCodeAt(12) - 48 && checkDigit(d, 13, 0, CNPJ_W2) === d.charCodeAt(13) - 48;
}

module.exports = { SOURCES, rx, onlyDigits, luhnValid, cpfValid, cnpjValid };
