// k6 load test with detailed STOMP debug and state-machine for k6 websocket
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// CONFIG
const API_BASE_URL   = __ENV.API_BASE_URL   || 'https://whisp-dev.api.whispchat.com';
const WS_URL         = __ENV.WS_URL         || 'wss://whisp-dev.api.whispchat.com/api/wsConnect';
const USER_PREFIX    = __ENV.USER_PREFIX    || 'user';
const PASSWORD       = __ENV.PASSWORD       || 'password123';
const TOTAL_USERS    = +(__ENV.TOTAL_USERS)    || 5000;

// METRICS
export let wsErrors    = new Counter('ws_error_count');
export let stompErrors = new Counter('stomp_error_count');
export let msgRTT      = new Trend('chat_message_rtt_ms');
export let messagesReceived = new Counter('messages_received_total');
export let messagesSent = new Counter('messages_sent_total');
export let getChatReq = new Counter('get_chat_req');
export let undeliveredMessages = new Counter('undelivered_messages');

// CACHE CREDENTIALS
let userCreds = {};

const globalPendingPings = {};

export let options = {
  stages: [
    { duration: '1m', target: TOTAL_USERS },
    { duration: '3m', target: TOTAL_USERS },
    { duration: '3m', target:    0 },
  ],
};

export default function () {
  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  // 1) login once
  if (!userCreds[vu]) {
    let login = http.post(`${API_BASE_URL}/api/user/signin`, JSON.stringify({ username, password: PASSWORD }), { headers: { 'Content-Type': 'application/json' } });
    check(login, { 'login ok': r => r.status === 200 });
    if (login.status !== 200) {
      console.error(`VU${vu} register error ${login.status} body: ${login.json()}`);
      return;
    }
    const ld  = login.json();
    const jwt = login.headers['Authorization'] || login.headers['authorization'];
    const uid = ld.id || ld.userId;
    userCreds[vu] = { userId: uid, jwt };
  }

  const { userId, jwt } = userCreds[vu];

  // 2) WebSocket + STOMP state machine
  let wsRes = ws.connect(WS_URL, { headers: { Authorization: `Bearer ${jwt}` } }, socket => {
    //console.log(`VU${vu}: WS connected`);
    const connectFrame =
      'CONNECT\n' +
      'accept-version:1.2\n' +
      `Authorization:Bearer ${jwt}\n\n\0`;
    const subFrame =
      'SUBSCRIBE\n' +
      `id:sub-${vu}\n` +
      `destination:/user/${userId}/queue/messages\n\n\0`;

    let chatIds = [];
    let state = 'CONNECTING';

    socket.on('open', () => {
      //console.log(`VU${vu}: WS open, sending CONNECT`);
      socket.send(connectFrame);
    });

    const pendingPings = {};

    globalPendingPings[vu] = pendingPings;

    socket.on('message', msg => {
      const text = msg.toString();
      if (state === 'CHATTING') {
        const match = text.match(/"ping:(\d+)"/);
        if (match) {
          messagesReceived.add(1);
          const nonce = match[1];            // the digits only

          const start = pendingPings[nonce]; // timestamp when we sent it
          if (start !== undefined) {
            // Compute and record RTT
            const rtt = Date.now() - start;
            msgRTT.add(rtt);
            delete pendingPings[nonce];      // clean up
            console.log(`VU${vu}: Pong ${nonce} RTT=${rtt}ms`);
          }
          else {
            console.log(`Message received from other user`);
          }
        }
      }
      else if (state === 'CONNECTING') {
        if (text.startsWith('CONNECTED')) {
          console.log(`VU${vu}: STOMP CONNECTED`);
          socket.send(subFrame);
          //console.log(`VU${vu}: SENT SUBSCRIBE`);
          state = 'CHATTING';
          // Get existing chats instead of creating new ones
          let getChatsResponse = http.get(
            `${API_BASE_URL}/api/chat/getChats`,
            { headers: { 'Content-Type': 'application/json', 'Authorization': jwt } }
          );
          getChatReq.add(1);
          check(getChatsResponse, { 'get chats ok': r => r.status === 200 });
          if (getChatsResponse.status === 200) {
            const chatsData = getChatsResponse.json();
            if (chatsData.chats && Array.isArray(chatsData.chats)) {
              chatsData.chats.forEach(chat => {
                chatIds.push(chat.chatId);
              });
              //console.log(`VU${vu}: Retrieved ${chatIds.length} existing chats: [${chatIds.join(', ')}]`);
            } else {
              console.warn(`VU${vu}: No chats found in response`);
            }
          } else {
            console.error(`VU${vu}: GetChats error ${getChatsResponse.status} body: ${getChatsResponse.body}`);
          }
        } else {
          console.error(`VU${vu}: CONNECT error: ${text}`);
          stompErrors.add(1);
        }
      }
      // In CHAT state, incoming MESSAGE frames are ignored for brevity
    });

    socket.on('error', e => {
      console.error(`VU${vu}: WS error: ${e.error()}`);
      wsErrors.add(1);
    });
    socket.on('close', () => console.warn(`VU${vu}: WS closed`));

    // chat ping loop with logging
    socket.setInterval(() => {
      if (state !== 'CHATTING') {
        //console.log(`VU${vu}: Ping skipped, state=${state}`);
        return;
      }
      if (!chatIds.length) {
        //console.log(`VU${vu}: No chatIds yet`);
        return;
      }
      const cid  = chatIds[Math.floor(Math.random() * chatIds.length)];

      const ts = Date.now();
      const nonce = `${ts}`;

      pendingPings[nonce] = ts;

      const messageObject = {type: 'SEND_MSG', senderId: userId, chatId: cid, message: `ping:${nonce}`, timeStamp: new Date().toISOString()};
      const frame =
        'SEND\n' +
        'destination:/api/chat\n' +
        'content-type:application/json\n\n' +
        JSON.stringify(messageObject) +
        '\0';
      console.log(`VU${vu}: Sending ping to ${cid}, nonce=${nonce}`);
      socket.send(frame);
      messagesSent.add(1);
    }, 6000);
  });

  check(wsRes, { 'WS handshake 101': r => r && r.status === 101 });
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