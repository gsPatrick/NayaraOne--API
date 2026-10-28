'use strict';

const crypto = require('crypto');

/** SHA-256 em hexadecimal do corpo bruto (Buffer ou texto). */
const sha256Hex = (corpo) => crypto.createHash('sha256').update(Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8')).digest('hex');

module.exports = { sha256Hex };
