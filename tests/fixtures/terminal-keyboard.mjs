#!/usr/bin/env node
import process from 'node:process';
process.stdin.setRawMode(true);
process.stdout.write('\r\nKEY_READY\r\n');
process.stdin.on('data', (data) => {
  process.stdout.write('\r\nKEY:' + data.toString('hex') + '\r\n');
  if (data.includes(4)) process.exit(0);
});
