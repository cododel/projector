#!/usr/bin/env node
import process from 'node:process';
process.stdin.setRawMode(true);
const mode = process.argv[2] ?? 'mouse';
if (mode !== 'normal') process.stdout.write('\x1b[?1049h');
if (mode === 'binary') process.stdout.write('\x1b[?1000h');
if (mode === 'mouse') process.stdout.write('\x1b[?1000h\x1b[?1006h');
if (mode === 'normal') for (let i = 0; i < 200; i++) process.stdout.write(`HISTORY_${i}\r\n`);
process.stdout.write('WHEEL_READY\r\n');
let input = '',
  up = 0,
  down = 0;
process.stdin.on('data', (bytes) => {
  if (bytes.toString() === 'r') {
    process.stdout.write('\r\nWHEEL_INPUT_READY\r\n');
    return;
  }
  if (bytes.toString() === 't') {
    process.stdout.write('\x1b[?1000l\x1b[?1000h\r\nMOUSE_CYCLE\r\n');
    return;
  }
  if (bytes.toString() === 'o' || bytes.toString() === 'i') {
    process.stdout.write(
      bytes.toString() === 'o' ? '\x1b[?1000l\r\nMOUSE_OFF\r\n' : '\x1b[?1000h\r\nMOUSE_ON\r\n',
    );
    return;
  }
  if (mode === 'binary') {
    input += bytes.toString('hex');
    process.stdout.write('\r\nBINARY_HEX:' + input + '\r\n');
    return;
  }
  input += bytes.toString();
  if (bytes.includes(4)) process.exit(0);
  // Match native terminal protocol escape sequences, including fragmented PTY output.
  // eslint-disable-next-line no-control-regex
  const pattern = /\x1b\[<(\d+);\d+;\d+[Mm]|\x1b(?:\[|O)([AB])/g;
  let match,
    consumed = 0;
  while ((match = pattern.exec(input))) {
    consumed = match.index + match[0].length;
    if (match[2] === 'A' || (match[1] && (Number(match[1]) & 67) === 64)) up++;
    if (match[2] === 'B' || (match[1] && (Number(match[1]) & 67) === 65)) down++;
  }
  input = input.slice(consumed).slice(-256); // preserve split protocol packets across PTY chunks
  process.stdout.write(`\r\nSCROLL_UP=${up} DOWN=${down}\r\n`);
});
