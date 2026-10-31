'use strict';

const { rx, SOURCES, luhnValid, cpfValid, cnpjValid } = require('./patterns');

/** Detectores (sem trocar nada): quem precisa decidir "isto parece segredo/e-mail/documento" chama estes. */

const EMBEDDED_SECRET_NAMES = ['pemHeader', 'awsKey'];

/** Valor de configuração que carrega segredo embutido (cadeia de conexão com senha, Bearer, chave PEM, JWT, chave de API). */
function looksLikeEmbeddedSecret(value) {
  const text = String(value || '');
  return /postgres(ql)?:\/\//i.test(text)
    || /^bearer\s/i.test(text)
    || /:\/\/[^/\s]*:[^@\s]*@/.test(text)
    || new RegExp(`^${SOURCES.jwt}$`).test(text)
    || /^(sk|pk|rk)_(live|test)_/i.test(text)
    || ['openAiKey', 'googleKey', 'modelProviderKey'].some((name) => new RegExp(`^${SOURCES[name]}$`).test(text))
    || EMBEDDED_SECRET_NAMES.some((name) => rx(name, '').test(text));
}

/** Texto com segredo reconhecível (Bearer, JWT, PEM, chave de API), em qualquer posição. */
function containsSecretLike(value) {
  const text = String(value || '');
  return ['bearer', 'jwt', 'pemHeader', 'openAiKey', 'googleKey', 'modelProviderKey'].some((name) => rx(name, 'i').test(text));
}

const containsEmail = (value) => rx('emailLoose', '').test(String(value || ''));

/** O valor INTEIRO tem formato de e-mail? `requireDot: false` aceita domínio sem ponto (regra mais frouxa dos cadastros de consumidor da API). */
const isEmailFormat = (value, { requireDot = true } = {}) => new RegExp(`^${SOURCES[requireDot ? 'emailLoose' : 'emailSimple']}$`).test(String(value ?? ''));

/** O texto tem número de cartão completo (candidato válido pelo algoritmo do cartão)? Candidato que é CPF ou CNPJ válido não conta. */
function containsCardNumber(text) {
  let achou = false;
  String(text ?? '').replace(rx('cardCandidate'), (m) => { if (luhnValid(m) && !cpfValid(m) && !cnpjValid(m)) achou = true; return m; });
  return achou;
}

/** CPF e CNPJ (com ou sem pontuação) encontrados em um texto: { cpf, cnpj } com o primeiro de cada. */
function findDocumentNumbers(text) {
  const source = String(text || '');
  const cnpj = source.match(new RegExp(`\\b${SOURCES.cnpjLoose}\\b`));
  const cpf = source.match(new RegExp(`\\b${SOURCES.cpfLoose}\\b`));
  return { cpf: cpf ? cpf[0] : null, cnpj: cnpj ? cnpj[0] : null };
}

module.exports = { looksLikeEmbeddedSecret, containsSecretLike, containsEmail, isEmailFormat, containsCardNumber, findDocumentNumbers };
