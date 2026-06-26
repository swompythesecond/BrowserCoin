/**
 * Human-readable opcode reference for the script engine. Documentation only —
 * `script.ts` is the authoritative implementation; these one-liners describe
 * each opcode's effect for the Scripts page and the developer docs. Semantics
 * follow Bitcoin Script, which is what the interpreter mirrors.
 */
import { Op } from './script.js';

export interface OpcodeDoc {
  name: string;
  hex: string;
  desc: string;
}
export interface OpcodeGroup {
  title: string;
  note?: string;
  ops: OpcodeDoc[];
}

function op(name: string, value: number, desc: string): OpcodeDoc {
  return { name, hex: '0x' + value.toString(16).padStart(2, '0'), desc };
}

export const OPCODE_REFERENCE: OpcodeGroup[] = [
  {
    title: 'Pushing data',
    note: 'Bytes 0x01–0x4b are not named opcodes — each pushes that many literal bytes onto the stack.',
    ops: [
      op('OP_0', Op.OP_0, 'Push an empty value (also the canonical "false").'),
      op('OP_1…OP_16', Op.OP_1, 'Push the small integer 1 through 16 (0x51…0x60).'),
      op('OP_PUSHDATA1', Op.OP_PUSHDATA1, 'Push N bytes, where the next 1 byte is the length N.'),
      op('OP_PUSHDATA2', Op.OP_PUSHDATA2, 'Push N bytes, where the next 2 bytes (little-endian) are the length N.'),
    ],
  },
  {
    title: 'Flow control',
    ops: [
      op('OP_IF', Op.OP_IF, 'Run the next branch only if the top stack value is true.'),
      op('OP_ELSE', Op.OP_ELSE, 'The alternative branch for the matching OP_IF.'),
      op('OP_ENDIF', Op.OP_ENDIF, 'Close an OP_IF / OP_ELSE block.'),
      op('OP_VERIFY', Op.OP_VERIFY, 'Pop the top value; abort the whole script if it is not true.'),
    ],
  },
  {
    title: 'Stack',
    ops: [
      op('OP_DUP', Op.OP_DUP, 'Duplicate the top item.'),
      op('OP_DROP', Op.OP_DROP, 'Remove the top item.'),
      op('OP_SWAP', Op.OP_SWAP, 'Swap the top two items.'),
      op('OP_OVER', Op.OP_OVER, 'Copy the second-from-top item to the top.'),
      op('OP_ROT', Op.OP_ROT, 'Rotate the top three items.'),
      op('OP_TUCK', Op.OP_TUCK, 'Copy the top item to just below the second item.'),
      op('OP_NIP', Op.OP_NIP, 'Remove the second-from-top item.'),
      op('OP_IFDUP', Op.OP_IFDUP, 'Duplicate the top item only if it is non-zero.'),
      op('OP_2DUP', Op.OP_2DUP, 'Duplicate the top two items.'),
      op('OP_DEPTH', Op.OP_DEPTH, 'Push the current number of items on the stack.'),
      op('OP_PICK', Op.OP_PICK, 'Copy the Nth-from-top item to the top (N taken from the stack).'),
      op('OP_ROLL', Op.OP_ROLL, 'Move the Nth-from-top item to the top (N taken from the stack).'),
      op('OP_TOALTSTACK', Op.OP_TOALTSTACK, 'Move the top item onto the alt stack.'),
      op('OP_FROMALTSTACK', Op.OP_FROMALTSTACK, 'Move the top alt-stack item back onto the main stack.'),
      op('OP_SIZE', Op.OP_SIZE, 'Push the byte length of the top item (without removing it).'),
    ],
  },
  {
    title: 'Comparison & arithmetic',
    note: 'Numeric operands are limited to 4 bytes, like Bitcoin.',
    ops: [
      op('OP_EQUAL', Op.OP_EQUAL, 'Push 1 if the top two items are byte-equal, else 0.'),
      op('OP_EQUALVERIFY', Op.OP_EQUALVERIFY, 'OP_EQUAL followed by OP_VERIFY.'),
      op('OP_ADD', Op.OP_ADD, 'Add the top two numbers.'),
      op('OP_SUB', Op.OP_SUB, 'Subtract the top number from the one below it.'),
      op('OP_1ADD', Op.OP_1ADD, 'Add 1 to the top number.'),
      op('OP_1SUB', Op.OP_1SUB, 'Subtract 1 from the top number.'),
      op('OP_NEGATE', Op.OP_NEGATE, 'Flip the sign of the top number.'),
      op('OP_ABS', Op.OP_ABS, 'Absolute value of the top number.'),
      op('OP_NOT', Op.OP_NOT, 'Push 1 if the input is 0, else 0.'),
      op('OP_0NOTEQUAL', Op.OP_0NOTEQUAL, 'Push 1 if the input is non-zero, else 0.'),
      op('OP_BOOLAND', Op.OP_BOOLAND, 'Push 1 if both inputs are non-zero.'),
      op('OP_BOOLOR', Op.OP_BOOLOR, 'Push 1 if either input is non-zero.'),
      op('OP_NUMEQUAL', Op.OP_NUMEQUAL, 'Push 1 if the two numbers are equal.'),
      op('OP_NUMEQUALVERIFY', Op.OP_NUMEQUALVERIFY, 'OP_NUMEQUAL followed by OP_VERIFY.'),
      op('OP_NUMNOTEQUAL', Op.OP_NUMNOTEQUAL, 'Push 1 if the two numbers differ.'),
      op('OP_LESSTHAN', Op.OP_LESSTHAN, 'Push 1 if the second number is less than the top.'),
      op('OP_GREATERTHAN', Op.OP_GREATERTHAN, 'Push 1 if the second number is greater than the top.'),
      op('OP_LESSTHANOREQUAL', Op.OP_LESSTHANOREQUAL, 'Push 1 if the second number is ≤ the top.'),
      op('OP_GREATERTHANOREQUAL', Op.OP_GREATERTHANOREQUAL, 'Push 1 if the second number is ≥ the top.'),
      op('OP_MIN', Op.OP_MIN, 'Push the smaller of the two numbers.'),
      op('OP_MAX', Op.OP_MAX, 'Push the larger of the two numbers.'),
      op('OP_WITHIN', Op.OP_WITHIN, 'Push 1 if a number is within the range [min, max).'),
    ],
  },
  {
    title: 'Crypto & hashing',
    ops: [
      op('OP_SHA256', Op.OP_SHA256, 'Replace the top item with its SHA-256 hash.'),
      op('OP_HASH256', Op.OP_HASH256, 'Replace the top item with its double-SHA-256 hash.'),
      op('OP_RIPEMD160', Op.OP_RIPEMD160, 'Replace the top item with its RIPEMD-160 hash.'),
      op('OP_HASH160', Op.OP_HASH160, 'RIPEMD-160 of the SHA-256 of the top item.'),
      op('OP_CHECKSIG', Op.OP_CHECKSIG, 'Verify an Ed25519 signature against a public key over the spend; push 1/0.'),
      op('OP_CHECKSIGVERIFY', Op.OP_CHECKSIGVERIFY, 'OP_CHECKSIG followed by OP_VERIFY.'),
      op('OP_CHECKMULTISIG', Op.OP_CHECKMULTISIG, 'Verify M valid signatures against N listed public keys.'),
    ],
  },
  {
    title: 'Time locks',
    ops: [
      op('OP_CHECKLOCKTIMEVERIFY', Op.OP_CHECKLOCKTIMEVERIFY, 'Abort unless the block height / time has reached the given locktime (values below 500,000,000 are heights, at or above are unix timestamps).'),
    ],
  },
  {
    title: 'Reserved',
    note: 'These do nothing today. They are reserved so a future rule can give one meaning as a soft fork (old nodes keep accepting, new nodes enforce).',
    ops: [
      op('OP_NOP, OP_NOP1, OP_NOP3…OP_NOP10', Op.OP_NOP, 'No-ops reserved for future upgrades.'),
    ],
  },
];
