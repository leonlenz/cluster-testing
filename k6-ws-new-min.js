// k6 websocket load test (minimal changes from old ws-script.js)
// Changes made to match the new API behavior (per whisp-e2e.js):
//  - /api/user/signin requires header: x-api-key
//  - Authenticated HTTP endpoints require: Authorization: Bearer <jwt>
//  - WebSocket requires a ticket from: GET /api/user/getTicket
//  - Ticket must be appended to wsConnect URL: .../api/wsConnect?ticket=...

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// CONFIG
const API_BASE_URL = __ENV.API_BASE_URL || 'https://whisp-dev.api.whispchat.com';
const WS_URL       = __ENV.WS_URL       || 'wss://whisp-dev.api.whispchat.com/api/wsConnect';
const API_KEY      = __ENV.API_KEY      || '8Nj2zKISsZOf0U2IIh2tdpEvvRQVEmVP';
const USER_PREFIX  = __ENV.USER_PREFIX  || 'user';
const PASSWORD     = __ENV.PASSWORD     || 'password123';
const TOTAL_USERS  = +(__ENV.TOTAL_USERS) || 1250;

if (!API_KEY) {
  fail('Missing required env var: API_KEY (used as x-api-key for /api/user/signin)');
}

// METRICS (unchanged)
export let wsErrors    = new Counter('ws_error_count');
export let stompErrors = new Counter('stomp_error_count');
export let msgRTT      = new Trend('chat_message_rtt_ms');
export let messagesReceived = new Counter('messages_received_total');
export let messagesSent = new Counter('messages_sent_total');
export let getChatReq = new Counter('get_chat_req');
export let undeliveredMessages = new Counter('undelivered_messages');

// CACHE CREDENTIALS (unchanged idea)
let userCreds = {};
const globalPendingPings = {};

export let options = {
  stages: [
    { duration: '1m', target: TOTAL_USERS },
    { duration: '3m', target: TOTAL_USERS },
    { duration: '3m', target: 0 },
  ],
};

// Same helper semantics as whisp-e2e.js
function authHeader(jwt) {
  if (!jwt) return undefined;
  const s = String(jwt);
  return s.toLowerCase().startsWith('bearer ') ? s : `Bearer ${s}`;
}

function buildWsUrlWithTicket(baseUrl, ticket) {
  if (baseUrl.includes('?')) return `${baseUrl}&ticket=${encodeURIComponent(ticket)}`;
  return `${baseUrl}?ticket=${encodeURIComponent(ticket)}`;
}

export default function () {
  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  // 1) login once (now includes x-api-key)
  if (!userCreds[vu]) {
    let login = http.post(
      `${API_BASE_URL}/api/user/signin`,
      JSON.stringify({ username, password: PASSWORD }),
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
        },
      }
    );

    check(login, { 'login ok': (r) => r.status === 200 });
    if (login.status !== 200) {
      console.error(`VU${vu} login error ${login.status} body: ${login.body}`);
      return;
    }

    const ld  = login.json();
    const jwt = login.headers['Authorization'] || login.headers['authorization'];
    const uid = ld.id || ld.userId;

    if (!jwt || !uid) {
      console.error(`VU${vu} login missing jwt/userId. jwtHeader=${jwt} body: ${login.body}`);
      return;
    }

    userCreds[vu] = { userId: uid, jwt };
  }

  const { userId, jwt } = userCreds[vu];
  const bearerJwt = authHeader(jwt);

  // 1.5) get websocket ticket (new)
  const ticketRes = http.get(`${API_BASE_URL}/api/user/getTicket`, {
    headers: { Authorization: bearerJwt },
  });
  check(ticketRes, { 'getTicket ok': (r) => r.status === 200 });

  if (ticketRes.status !== 200) {
    console.error(`VU${vu}: getTicket error ${ticketRes.status} body: ${ticketRes.body}`);
    return;
  }

  const ticketBody = ticketRes.json();
  const ticket = ticketBody && ticketBody.ticket;

  if (!ticket) {
    console.error(`VU${vu}: getTicket missing ticket in body: ${ticketRes.body}`);
    return;
  }

  const wsUrl = buildWsUrlWithTicket(WS_URL, ticket);

  // 2) WebSocket + STOMP state machine (unchanged structure)
  let wsRes = ws.connect(wsUrl, { headers: { Authorization: bearerJwt } }, (socket) => {
    const connectFrame =
      'CONNECT\n' +
      'accept-version:1.2\n' +
      `Authorization:${bearerJwt}\n\n\0`;

    const subFrame =
      'SUBSCRIBE\n' +
      `id:sub-${vu}\n` +
      `destination:/user/${userId}/queue/messages\n\n\0`;

    let chatIds = [];
    let state = 'CONNECTING';

    socket.on('open', () => {
      socket.send(connectFrame);
    });

    const pendingPings = {};
    globalPendingPings[vu] = pendingPings;

    socket.on('message', (msg) => {
      const text = msg.toString();

      if (state === 'CHATTING') {
        // Keep existing "ping:<nonce>" RTT mechanism
        const match = text.match(/"ping:(\d+)"/);
        if (match) {
          messagesReceived.add(1);
          const nonce = match[1];

          const start = pendingPings[nonce];
          if (start !== undefined) {
            const rtt = Date.now() - start;
            msgRTT.add(rtt);
            delete pendingPings[nonce];
            //console.log(`VU${vu}: Pong ${nonce} RTT=${rtt}ms`);
          }
        }
        return;
      }

      // CONNECTING state
      if (text.startsWith('CONNECTED')) {
        //console.log(`VU${vu}: STOMP CONNECTED`);
        socket.send(subFrame);
        state = 'CHATTING';

        // Get existing chats (now uses Bearer auth)
        let getChatsResponse = http.get(`${API_BASE_URL}/api/chat/getChats`, {
          headers: { 'Content-Type': 'application/json', Authorization: bearerJwt },
        });

        getChatReq.add(1);
        check(getChatsResponse, { 'get chats ok': (r) => r.status === 200 });

        if (getChatsResponse.status === 200) {
          const chatsData = getChatsResponse.json();
          if (chatsData && chatsData.chats && Array.isArray(chatsData.chats)) {
            chatsData.chats.forEach((chat) => {
              if (chat && chat.chatId) chatIds.push(chat.chatId);
            });
          } else {
            console.warn(`VU${vu}: No chats found in response`);
          }
        } else {
          console.error(`VU${vu}: GetChats error ${getChatsResponse.status} body: ${getChatsResponse.body}`);
        }
      } else {
        // For a real STOMP ERROR frame we'd need parsing, but keeping old approach for simplicity
        // (This is consistent with your request to minimize changes.)
        //console.error(`VU${vu}: CONNECT error: ${text}`);
        stompErrors.add(1);
      }
    });

    socket.on('error', (e) => {
      console.error(`VU${vu}: WS error: ${e.error()}`);
      wsErrors.add(1);
    });

    socket.on('close', () => {
      //console.warn(`VU${vu}: WS closed`);
    });

    // chat ping loop (unchanged)
    socket.setInterval(() => {
      if (state !== 'CHATTING') return;
      if (!chatIds.length) return;

      const cid = chatIds[Math.floor(Math.random() * chatIds.length)];
      const ts = Date.now();
      const nonce = `${ts}`;

      pendingPings[nonce] = ts;

      const messageObject = {
        type: 'SEND_MSG',
        senderId: userId,
        chatId: cid,
        message: `ping:${nonce}`,
        timeStamp: new Date().toISOString(),
      };

      const frame =
        'SEND\n' +
        'destination:/api/chat\n' +
        'content-type:application/json\n\n' +
        JSON.stringify(messageObject) +
        '\0';

      socket.send(frame);
      messagesSent.add(1);
    }, 6000);
  });

  check(wsRes, { 'WS handshake 101': (r) => r && r.status === 101 });
  sleep(1);
}

export function teardown() {
  let totalUndelivered = 0;
  for (let vu in globalPendingPings) {
    totalUndelivered += Object.keys(globalPendingPings[vu]).length;
  }
  console.log(`Total undelivered pings: ${totalUndelivered}`);
  undeliveredMessages.add(totalUndelivered);
}
