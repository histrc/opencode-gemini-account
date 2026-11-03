import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationOptions } from '../src/verification-options.mjs';

test('verification requires deliberate quota use and an explicit model, without a Flash Lite default', () => {
  assert.throws(() => verificationOptions([], {}), /--live/);
  assert.throws(() => verificationOptions(['--live'], {}), /显式指定/);
  assert.equal(verificationOptions(['--live', '--model', 'gemini-3.8-flash'], {}).model, 'gemini-3.8-flash');
});

test('explicit model wins over inherited preferences and preserves provider-qualified selection', () => {
  assert.equal(verificationOptions(['--live', '--model', 'aistudio-account/gemini-3.8-flash'], { GEMINI_ACCOUNT_VERIFY_MODEL: 'gemini-3.5-flash-lite' }).model, 'gemini-3.8-flash');
  assert.equal(verificationOptions(['--live'], { GEMINI_ACCOUNT_VERIFY_MODEL: 'gemini-3.8-flash' }).model, 'gemini-3.8-flash');
  assert.throws(() => verificationOptions(['--live', '--model'], { GEMINI_ACCOUNT_VERIFY_MODEL: 'gemini-3.5-flash-lite' }), /后需要/);
  for (const args of [['--live', '--model'], ['--live', '--model', 'gemini-test?key=private'], ['--live', '--model', 'gemini-a', '--model', 'gemini-b'], ['--live', '--unknown']]) assert.throws(() => verificationOptions(args, {}));
});
