import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPaise, toRupees, sumPaise, amountInWordsINR, financialYear } from '../../lib/money';

test('paise conversion is exact and rounds half away from zero', () => {
  assert.equal(toPaise(1.005), 101);
  assert.equal(toPaise(-1.005), -101);
  assert.equal(toPaise('497002.5'), 49700250);
  assert.equal(toPaise(null), 0);
  assert.equal(sumPaise([0.1, 0.2, 0.3]), 60);
  assert.equal(toRupees(sumPaise([0.1, 0.2])), 0.3);
});

test('amount in words (Indian numbering)', () => {
  assert.equal(amountInWordsINR(0), 'Rupees Zero Only');
  assert.equal(amountInWordsINR(toPaise(492500)), 'Rupees Four Lakh Ninety Two Thousand Five Hundred Only');
  assert.equal(amountInWordsINR(toPaise(10_00_00_000.5)), 'Rupees Ten Crore and Fifty Paise Only');
  assert.equal(amountInWordsINR(toPaise(150_00_00_000)), 'Rupees One Hundred Fifty Crore Only');
  assert.equal(amountInWordsINR(toPaise(1_23_45_67_890.07)), 'Rupees One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety and Seven Paise Only');
});

test('financial year boundaries (April–March)', () => {
  assert.deepEqual(financialYear('2026-03-31'), { start: '2025-04-01', end: '2026-03-31', label: '2025-26' });
  assert.deepEqual(financialYear('2026-04-01'), { start: '2026-04-01', end: '2027-03-31', label: '2026-27' });
});
