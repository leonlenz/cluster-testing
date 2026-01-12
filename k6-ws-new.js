// k6 websocket script: login -> getTicket -> connect STOMP -> getChats -> send messages
//
// Key changes vs. old script:
// - Uses x-api-key for /api/user/signin
// - Uses Bearer JWT for all authenticated HTTP endpoints
// - Retrieves websocket ticket via /api/user/getTicket and appends as ?ticket=... to the wsConnect URL
// - Sends Authorization in both WS handshake headers and STOMP CONNECT headers
//
// Env vars:
//   API_BASE_URL       (default: https://whisp-dev.api.whispchat.com)
//   WS_URL             (default: wss://whisp-dev.api.whispchat.com/api/wsConnect)
//   API_KEY            (required for signin; default: empty -> script will fail fast)
//   USER_PREFIX        (default: user)
//   PASSWORD           (default: password123)
//   TOTAL_USERS        (default: 5000)
//   SEND_INTERVAL_MS   (default: 6000)
//   SESSION_TIME_MS    (default: 600000)  // how long each VU keeps a WS connection open
//   CHAT_REFRESH_MS    (default: 30000)   // refresh chat list periodically (0 disables)

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// CONFIG
const API_BASE_URL     = __ENV.API_BASE_URL     || 'https://whisp-dev.api.whispchat.com';
const WS_URL           = __ENV.WS_URL           || 'wss://whisp-dev.api.whispchat.com/api/wsConnect';
const API_KEY          = __ENV.API_KEY          || '';
const USER_PREFIX      = __ENV.USER_PREFIX      || 'user';
const PASSWORD         = __ENV.PASSWORD         || 'password123';
const TOTAL_USERS      = +(__ENV.TOTAL_USERS)      || 1250;
const SEND_INTERVAL_MS = +(__ENV.SEND_INTERVAL_MS) || 10000;
const SESSION_TIME_MS  = +(__ENV.SESSION_TIME_MS)  || 600000;
const CHAT_REFRESH_MS  = +(__ENV.CHAT_REFRESH_MS)  || 30000;

if (!API_KEY) {
  fail('Missing required env var: API_KEY (x-api-key used for signin)');
}

// METRICS
export const wsErrors            = new Counter('ws_error_count');
export const stompErrors         = new Counter('stomp_error_count');
export const msgRTT              = new Trend('chat_message_rtt_ms');
export const messagesReceived    = new Counter('messages_received_total');
export const messagesSent        = new Counter('messages_sent_total');
export const getChatReq          = new Counter('get_chat_req_total');
export const undeliveredMessages = new Counter('undelivered_messages_total');

// Per-VU cached creds
const userCreds = {};
// For teardown stats
const globalPending = {};

// OPTIONS
export const options = {
  stages: [
    { duration: '1m', target: TOTAL_USERS },
    { duration: '3m', target: TOTAL_USERS },
    { duration: '3m', target: 0 },
  ],
  gracefulStop: '30s',
};

function asBearer(token) {
  if (!token) return token;
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
}

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

function stompFrame(command, headers, body) {
  let frame = `${command}\n`;
  if (headers) {
    for (const k in headers) frame += `${k}:${headers[k]}\n`;
  }
  frame += '\n';
  if (body) frame += body;
  frame += '\0';
  return frame;
}

function parseStompFrame(raw) {
  if (!raw) return null;
  // Heartbeats are typically '\n'
  if (raw === '\n') return { command: 'HEARTBEAT' };

  let s = raw;
  if (s.endsWith('\0')) s = s.slice(0, -1);

  const splitIdx = s.indexOf('\n\n');
  const head = splitIdx >= 0 ? s.slice(0, splitIdx) : s;
  const body = splitIdx >= 0 ? s.slice(splitIdx + 2) : '';

  const lines = head.split('\n');
  const command = lines[0] || '';
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 1);
    headers[k] = v;
  }

  return { command, headers, body };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function buildWsUrlWithTicket(base, ticket) {
  if (base.includes('?')) return `${base}&ticket=${encodeURIComponent(ticket)}`;
  return `${base}?ticket=${encodeURIComponent(ticket)}`;
}

function loginAndGetJwtAndUserId(username) {
  const login = http.post(
    `${API_BASE_URL}/api/user/signin`,
    JSON.stringify({ username, password: PASSWORD }),
    { headers: jsonHeaders({ 'x-api-key': API_KEY }) }
  );

  const ok = check(login, {
    'login ok (200)': (r) => r.status === 200,
    'login has Authorization header': (r) => !!(r.headers['Authorization'] || r.headers['authorization']),
  });

  if (!ok) return null;

  const body = login.json();
  const jwtHdr = login.headers['Authorization'] || login.headers['authorization'];
  const userId = body?.id || body?.userId;

  if (!jwtHdr || !userId) return null;

  return { userId, jwt: asBearer(jwtHdr) };
}

function getTicket(jwt) {
  const res = http.get(`${API_BASE_URL}/api/user/getTicket`, {
    headers: { Authorization: jwt },
  });
  const ok = check(res, { 'getTicket ok (200)': (r) => r.status === 200 });
  if (!ok) return null;

  const body = res.json();
  return body?.ticket || null;
}

function getChats(jwt) {
  const res = http.get(`${API_BASE_URL}/api/chat/getChats`, {
    headers: { Authorization: jwt },
  });
  getChatReq.add(1);

  const ok = check(res, { 'getChats ok (200)': (r) => r.status === 200 });
  if (!ok) return [];

  const body = res.json();
  if (!body || !Array.isArray(body.chats)) return [];
  return body.chats.map((c) => c.chatId).filter((x) => !!x);
}

export default function () {
  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  // Ensure creds (login) per VU
  if (!userCreds[vu]) {
    const creds = loginAndGetJwtAndUserId(username);
    if (!creds) {
      wsErrors.add(1);
      console.error(`VU${vu}: signin failed for ${username}`);
      return;
    }
    userCreds[vu] = creds;
  }

  const { userId, jwt } = userCreds[vu];

  // Ticket is intentionally fetched per connection attempt (ticket TTLs are often short)
  const ticket = getTicket(jwt);
  if (!ticket) {
    wsErrors.add(1);
    console.error(`VU${vu}: getTicket failed`);
    return;
  }

  const url = buildWsUrlWithTicket(WS_URL, ticket);
  const pending = {};
  globalPending[vu] = pending;

  const res = ws.connect(url, { headers: { Authorization: jwt } }, (socket) => {
    let state = 'CONNECTING';
    let chatIds = [];

    // STOMP CONNECT and SUBSCRIBE frames
    const connect = stompFrame('CONNECT', {
      'accept-version': '1.2',
      'heart-beat': '10000,10000',
      // Most servers expect exactly this header key/value format
      'Authorization': jwt,
    });

    const subscribe = stompFrame('SUBSCRIBE', {
      id: `sub-${vu}`,
      destination: `/user/${userId}/queue/messages`,
    });

    function refreshChats() {
      chatIds = getChats(jwt);
    }

    socket.on('open', () => {
      socket.send(connect);
      // Close after SESSION_TIME_MS so iterations do not create unbounded connections
      socket.setTimeout(SESSION_TIME_MS, () => socket.close());
    });

    socket.on('message', (msg) => {
      const raw = msg.toString();
      const frame = parseStompFrame(raw);
      if (!frame) return;

      if (frame.command === 'CONNECTED') {
        state = 'CHATTING';
        socket.send(subscribe);

        // initial chat list
        refreshChats();

        // optional periodic refresh
        if (CHAT_REFRESH_MS > 0) {
          socket.setInterval(() => refreshChats(), CHAT_REFRESH_MS);
        }
        return;
      }

      if (frame.command === 'ERROR') {
        stompErrors.add(1);
        console.error(`VU${vu}: STOMP ERROR frame: ${frame.body || raw}`);
        return;
      }

      if (frame.command !== 'MESSAGE') return;

      const body = safeJson(frame.body);
      if (!body) return;

      messagesReceived.add(1);

      // Try to compute RTT for our pings (only if message originates from this VU)
      const msgText = body.message || body.content || '';
      const senderId = body.senderId || body.senderID || body.fromUserId;

      // Expect message format ping:<nonce>
      if (typeof msgText === 'string') {
        const m = msgText.match(/^ping:(\d+)$/);
        if (m && `${senderId}` === `${userId}`) {
          const nonce = m[1];
          const start = pending[nonce];
          if (start !== undefined) {
            msgRTT.add(Date.now() - start);
            delete pending[nonce];
          }
        }
      }
    });

    socket.on('error', (e) => {
      wsErrors.add(1);
      console.error(`VU${vu}: WS error: ${e && e.error ? e.error() : e}`);
    });

    socket.on('close', () => {
      // no-op: teardown aggregates pending
    });

    // Send loop
    socket.setInterval(() => {
      if (state !== 'CHATTING') return;
      if (!chatIds.length) return;

      const cid = chatIds[Math.floor(Math.random() * chatIds.length)];
      const ts = Date.now();
      const nonce = `${ts}`;

      pending[nonce] = ts;

      const payloadObj = {
        type: 'SEND_MSG',
        senderId: userId,
        chatId: cid,
        message: `ping:${nonce}`,
        timeStamp: new Date(ts).toISOString(),
      };

      const body = JSON.stringify(payloadObj);
      const frame = stompFrame('SEND', {
        destination: '/api/chat',
        'content-type': 'application/json',
      }, body);

      socket.send(frame);
      messagesSent.add(1);
    }, SEND_INTERVAL_MS);
  });

  check(res, { 'WS handshake status is 101': (r) => r && r.status === 101 });

  // Keep the VU alive a bit so ramp-down has time to drain
  sleep(1);
}

export function teardown() {
  let total = 0;
  for (const vu in globalPending) {
    total += Object.keys(globalPending[vu]).length;
  }
  undeliveredMessages.add(total);
  console.log(`Total undelivered ping messages (no echo observed): ${total}`);
}
