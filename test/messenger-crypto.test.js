import test from 'node:test';
import assert from 'node:assert/strict';
import { makeIdentity } from '../src/crypto/identity.js';
import { newIdentityDH, newSignedPrekeys, newOneTimePrekeys, publicBundle, initiate, respond } from '../src/crypto/pqxdh.js';
import { initAlice, initBob, encrypt, decrypt } from '../src/crypto/ratchet.js';
import { randomBytes, bytesToHex } from '../src/crypto/prim.js';

function device() {
  const identity = makeIdentity(randomBytes(32));
  const keys = { ikx: newIdentityDH(identity), ...newSignedPrekeys(identity), opks: newOneTimePrekeys(1, 3) };
  return { identity, keys };
}
const lookupFor = (keys) => ({
  spk: (id) => (keys.spk.id === id ? keys.spk : undefined),
  pqspk: (id) => (keys.pqspk.id === id ? keys.pqspk : undefined),
  opk: (id) => keys.opks.find((o) => o.id === id),
});

function setup({ withOpk = true, pskA, pskB } = {}) {
  const A = device(), B = device();
  const psk = randomBytes(32);
  const them = { ik: Buffer.from(B.identity.pk).toString('base64url'), bundle: publicBundle(B.keys), opk: withOpk ? { id: 1, pub: B.keys.opks[0].pub } : null };
  const a = initiate({ identity: A.identity, ikx: A.keys.ikx }, them, pskA ?? psk, 'inv1');
  const b = respond({ identity: B.identity }, B.keys, lookupFor(B.keys), a.pre, pskB ?? psk);
  return { A, B, a, b };
}

test('PQXDH agrees with and without one-time prekey; PSK mismatch diverges', () => {
  for (const withOpk of [true, false]) {
    const { a, b } = setup({ withOpk });
    assert.equal(bytesToHex(a.sk), bytesToHex(b.sk));
    assert.equal(bytesToHex(a.ad), bytesToHex(b.ad));
  }
  const { a, b } = setup({ pskA: randomBytes(32), pskB: randomBytes(32) });
  assert.notEqual(bytesToHex(a.sk), bytesToHex(b.sk));
});

test('PQXDH rejects tampered prekey message and forged bundle', () => {
  const { A, B, a } = setup();
  const lk = lookupFor(B.keys);
  assert.throws(() => respond({ identity: B.identity }, B.keys, lk, { ...a.pre, ek: a.pre.ikx }, randomBytes(32)));
  const M = device();
  const forged = { ik: Buffer.from(B.identity.pk).toString('base64url'), bundle: publicBundle(M.keys), opk: null };
  assert.throws(() => initiate({ identity: A.identity, ikx: A.keys.ikx }, forged, randomBytes(32), 'x'), /signature/);
});

function sessions() {
  const { B, a, b } = setup();
  let alice = initAlice(a.sk, a.ad, a.theirSpk, a.theirPq);
  let bob = initBob(b.sk, b.ad, B.keys.spk, B.keys.pqspk);
  return { get: () => ({ alice, bob }), set: (x, y) => { alice = x; bob = y; } };
}

test('double ratchet: ping-pong, out-of-order across turns, replay, tamper, no state corruption', () => {
  const S = sessions();
  let { alice, bob } = S.get();
  const send = (st, t) => { const r = encrypt(st, t); return [r.state, r.msg]; };
  const recv = (st, m) => { const r = decrypt(st, m); return [r.state, r.plaintext]; };

  let m1, m2, m3, pt;
  [alice, m1] = send(alice, 'a1'); [alice, m2] = send(alice, 'a2');
  [bob, pt] = recv(bob, m2); assert.equal(pt, 'a2');
  let r1; [bob, r1] = send(bob, 'b1');
  [alice, pt] = recv(alice, r1); assert.equal(pt, 'b1');
  [alice, m3] = send(alice, 'a3');
  [bob, pt] = recv(bob, m3); assert.equal(pt, 'a3');
  [bob, pt] = recv(bob, m1); assert.equal(pt, 'a1'); // late message from an older turn
  assert.throws(() => recv(bob, m1)); // replay

  const bad = structuredClone(m3); bad.c = bad.c.slice(0, -4) + 'AAAA';
  const before = JSON.stringify(bob);
  assert.throws(() => recv(bob, bad));
  assert.equal(JSON.stringify(bob), before); // failed decrypt leaves state untouched

  // many turns: KEM braid keeps working, both sides converge
  for (let i = 0; i < 20; i++) {
    let x, y; [alice, x] = send(alice, `A${i}`); [bob, pt] = recv(bob, x); assert.equal(pt, `A${i}`);
    [bob, y] = send(bob, `B${i}`); [alice, pt] = recv(alice, y); assert.equal(pt, `B${i}`);
  }
  // each turn carries a fresh KEM key
  let x; [alice, x] = send(alice, 'z');
  assert.equal(x.h.kpk.length > 1500, true);
  assert.equal(x.h.kct.length > 1400, true);
});

test('state round-trips through JSON (IndexedDB) mid-conversation', () => {
  const S = sessions();
  let { alice, bob } = S.get();
  let r = encrypt(alice, 'hello'); alice = JSON.parse(JSON.stringify(r.state));
  let d = decrypt(JSON.parse(JSON.stringify(bob)), r.msg); bob = d.state;
  assert.equal(d.plaintext, 'hello');
  r = encrypt(bob, 'back'); d = decrypt(alice, r.msg);
  assert.equal(d.plaintext, 'back');
});
