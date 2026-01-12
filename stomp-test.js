const WebSocket = require('ws');

const url   = 'wss://demo-api.api.whispchat.com/api/wsConnect';
const token = '<jwt>';
const ticket = "<ticket>"


const ws = new WebSocket(url + '?ticket=' + ticket, {
  headers: { Authorization: `Bearer ${token}` },
  rejectUnauthorized: false // skip TLS verify if needed
});

ws.on('open', () => {
  console.log('TCP/WebSocket connected, sending STOMP CONNECT…');

  // Build the STOMP CONNECT frame, ending with \0
  const frame =
    'CONNECT\n' +
    'accept-version:1.2\n' +
    `Authorization:Bearer ${token}\n\n` +
    '\0';

  ws.send(frame);
});

ws.on('message', (data) => {
  console.log('<<< Received STOMP frame >>>\n', data.toString());
  ws.close();
});

ws.on('error', (err) => {
  console.error('WS error:', err);
});