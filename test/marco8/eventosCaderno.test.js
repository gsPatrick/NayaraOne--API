'use strict';

// Marco 8 — os 12 eventos nomeados no caderno, mais o financing.submission_requested do guia.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../../src/features/correspondent/correspondentEvents.service.js'),
  'utf8'
);

const EVENTOS = [
  'financing.case.created',
  'financing.documents.completed',
  'financing.submitted',
  'financing.status.changed',
  'financing.approved',
  'financing.rejected',
  'financing.completed',
  'appraisal.requested',
  'appraisal.completed',
  'commission.entitlement.created',
  'commission.confirmed',
  'integration.correspondent.failed',
  'financing.submission_requested',
];

test('M8-EVT-01: cada evento do caderno é publicado pelo módulo', () => {
  for (const evento of EVENTOS) {
    assert.ok(src.includes(`'${evento}'`), evento);
  }
});
