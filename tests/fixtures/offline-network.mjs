// Loaded before the packaging script. Fail on attempted network access rather
// than allowing a warm download cache to conceal the dependency.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

const reject = () => {
  throw new Error('OFFLINE_PACKAGING: network access is forbidden');
};
globalThis.fetch = reject;
http.get = http.request = reject;
https.get = https.request = reject;
net.connect = net.createConnection = net.Socket.prototype.connect = reject;
dns.lookup = dns.resolve = reject;
dns.promises.lookup = dns.promises.resolve = reject;
