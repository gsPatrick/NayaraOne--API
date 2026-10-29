'use strict';

const crypto = require('node:crypto');

/** Token do link: 32 bytes aleatórios em base64url (43 caracteres). Só o hash SHA-256 vai ao banco; o token em claro aparece uma única vez, na resposta da criação. */
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
/** Forma válida de um token (43 caracteres base64url); qualquer outra é descartada antes de ir ao banco. */
const looksLikeToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

module.exports = { newToken, hashToken, looksLikeToken };
