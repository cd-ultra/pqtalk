import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, deriveRoom, normalizeCode } from '../src/crypto/code.js';
import { makeIdentity, safetyNumber } from '../src/crypto/identity.js';
import { createEphemeral, makeHello, verifyHello, encapsulateTo, decapsulateFrom, deriveRoot } from '../src/crypto/handshake.js';
import { PairSession } from '../src/crypto/session.js';
import { SenderChain, ReceiverChain } from '../src/crypto/sframe.js';
import { randomBytes, bytesToHex } from '../src/crypto/prim.js';

test('room code roundtrip + derivation', () => {
  const c = generateCode();
  assert.equal(normalizeCode(c).length, 32);
  assert.equal(normalizeCode(c.toLowerCase().replace(/-/g, ' ')), normalizeCode(c));
  const a = deriveRoom(c), b = deriveRoom(c.toLowerCase());
  assert.equal(a.roomId, b.roomId);
  assert.notEqual(deriveRoom(generateCode()).roomId, a.roomId);
  assert.equal(normalizeCode('short'), null);
});

function party(roomId, id, nick) {
  const identity = makeIdentity(randomBytes(32));
  const eph = createEphemeral();
  const hello = makeHello({ roomId, peerId: id, nick, identity, eph });
  return { id, identity, eph, hello, hash: verifyHello(roomId, hello).hash };
}

function handshake(room, A, B) {
  const vB = verifyHello(room.roomId, B.hello), vA = verifyHello(room.roomId, A.hello);
  const ab = encapsulateTo({ roomId: room.roomId, myId: A.id, myHelloHash: A.hash, identity: A.identity, peer: vB });
  const ba = encapsulateTo({ roomId: room.roomId, myId: B.id, myHelloHash: B.hash, identity: B.identity, peer: vA });
  const atB = decapsulateFrom({ roomId: room.roomId, myId: B.id, myHelloHash: B.hash, eph: B.eph, peer: vA, msg: ab.msg });
  const atA = decapsulateFrom({ roomId: room.roomId, myId: A.id, myHelloHash: A.hash, eph: A.eph, peer: vB, msg: ba.msg });
  const rA = deriveRoot({ psk: room.psk, myId: A.id, peerId: B.id, eph: A.eph, peerHello: vB, myHelloHash: A.hash, myCt: ab.ct, mySs: ab.ss, theirCt: atA.ct, theirSs: atA.ss });
  const rB = deriveRoot({ psk: room.psk, myId: B.id, peerId: A.id, eph: B.eph, peerHello: vA, myHelloHash: B.hash, myCt: ba.ct, mySs: ba.ss, theirCt: atB.ct, theirSs: atB.ss });
  return { rA, rB, ab, vA, vB };
}

test('hybrid handshake agrees, tamper detected, PSK matters', () => {
  const room = deriveRoom(generateCode());
  const A = party(room.roomId, 'aaaa', 'Alice'), B = party(room.roomId, 'bbbb', 'Bob');
  const { rA, rB, ab, vA } = handshake(room, A, B);
  assert.equal(bytesToHex(rA.root), bytesToHex(rB.root));
  assert.notEqual(rA.iAmLo, rB.iAmLo);

  // tampered hello
  assert.throws(() => verifyHello(room.roomId, { ...A.hello, nick: 'Mallory' }));
  // hello replayed into a different room
  assert.throws(() => verifyHello(deriveRoom(generateCode()).roomId, A.hello));
  // KEM ct forged by someone without A's identity key
  const M = party(room.roomId, 'aaaa', 'Alice');
  const vB = verifyHello(room.roomId, B.hello);
  const forged = encapsulateTo({ roomId: room.roomId, myId: 'aaaa', myHelloHash: A.hash, identity: M.identity, peer: vB });
  assert.throws(() => decapsulateFrom({ roomId: room.roomId, myId: B.id, myHelloHash: B.hash, eph: B.eph, peer: vA, msg: forged.msg }));
  assert.ok(ab);
  // different PSK => different root
  const other = { ...room, psk: randomBytes(32) };
  const { rA: rA2 } = handshake(other, A, B);
  assert.notEqual(bytesToHex(rA2.root), bytesToHex(rA.root));
});

test('safety numbers symmetric', () => {
  const a = makeIdentity(randomBytes(32)), b = makeIdentity(randomBytes(32));
  assert.equal(safetyNumber(a.pk, b.pk), safetyNumber(b.pk, a.pk));
  assert.equal(safetyNumber(a.pk, b.pk).replace(/ /g, '').length, 60);
});

test('pair session: ordering, skips, replay, PQ rekey', () => {
  const root = randomBytes(32);
  const A = new PairSession(root.slice(), true), B = new PairSession(root.slice(), false);
  const m1 = A.encrypt({ x: 1 }), m2 = A.encrypt({ x: 2 }), m3 = A.encrypt({ x: 3 });
  assert.deepEqual(B.decrypt(m3), { x: 3 }); // out of order
  assert.deepEqual(B.decrypt(m1), { x: 1 });
  assert.throws(() => B.decrypt(m1)); // replay
  assert.deepEqual(B.decrypt(m2), { x: 2 });
  assert.deepEqual(A.decrypt(B.encrypt({ y: 1 })), { y: 1 });

  // rekey: A -> rk1 ; B answers (sent under old epoch) then commits ; A finishes
  const rk1 = B.decrypt(A.encrypt(A.startRekey()));
  const inflight = A.encrypt({ before: true }); // A still on epoch 0
  const { reply, commit } = B.answerRekey(rk1);
  const env = B.encrypt(reply); commit();
  A.finishRekey(A.decrypt(env));
  assert.equal(A.epoch, 1); assert.equal(B.epoch, 1);
  assert.deepEqual(B.decrypt(inflight), { before: true }); // old-epoch msg still accepted
  assert.deepEqual(B.decrypt(A.encrypt({ after: 1 })), { after: 1 });
  assert.deepEqual(A.decrypt(B.encrypt({ after: 2 })), { after: 2 });
  assert.throws(() => B.decrypt({ e: 0, n: 99, c: 'AAAA' })); // old epoch dropped after switch
});

test('sframe sender keys: roundtrip, generations, tamper, wrong epoch, overhead', () => {
  const ck = randomBytes(32);
  const s = new SenderChain(ck, 7), r = new ReceiverChain(ck, 7);
  let last;
  for (let i = 0; i < 1000; i++) {
    const pt = randomBytes(30);
    const f = s.encrypt(pt);
    assert.equal(f.length, pt.length + 15);
    if (i % 3 === 0) continue; // simulate loss
    assert.deepEqual(r.decrypt(f), pt);
    last = f;
  }
  const bad = last.slice(); bad[7] ^= 1;
  assert.equal(r.decrypt(bad), null);
  assert.equal(new ReceiverChain(ck, 8).decrypt(last), null);
  assert.equal(new ReceiverChain(randomBytes(32), 7).decrypt(last), null);
  // forward secrecy: a receiver created from the *current* chain state can't read gen 0
  const s2 = new SenderChain(ck, 1); const f0 = s2.encrypt(Uint8Array.of(1, 2, 3));
  for (let i = 0; i < 300; i++) s2.encrypt(Uint8Array.of(0));
  const late = new ReceiverChain(s2.ck, 1, s2.gen);
  assert.equal(late.decrypt(f0), null);
});
