const WebSocket = require('ws');

const url   = 'wss://subtle-zebra.api.whispchat.com/api/wsConnect';
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJST0xFIjoiVVNFUiIsInVzZXJuYW1lIjoiYm9iYnkiLCJzdWIiOiI4MDZkNDY1MS0wZWE3LTRlNGYtYjMyNS0xZTQzYzBjMDNmNTciLCJpYXQiOjE3NDk4MzUzMzMsImV4cCI6MTc0OTgzNTYzM30.96o62Su0xFvQgiE5by5oMuGWHnwtrVeOmgZON9NVH9o';

const ws = new WebSocket(url, {
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