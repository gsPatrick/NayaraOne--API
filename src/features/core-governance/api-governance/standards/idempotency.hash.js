'use strict';

const crypto = require('node:crypto');

/** JSON canônico (chaves em ordem) para o mesmo corpo dar o mesmo hash, qualquer que seja a ordem dos campos. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

const bodyHash = (body) => crypto.createHash('sha256').update(canonical(body === undefined ? {} : body)).digest('hex');

module.exports = { canonical, bodyHash };
