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
const MAX_CHAT_PEERS = +(__ENV.MAX_CHAT_PEERS) || 100;

// METRICS
export let wsErrors    = new Counter('ws_error_count');
export let stompErrors = new Counter('stomp_error_count');
export let msgRTT      = new Trend('chat_message_rtt_ms');

// CACHE CREDENTIALS
let userCreds = {};

export let options = {
  stages: [
    { duration: '1m', target: TOTAL_USERS },
    { duration: '3m', target: TOTAL_USERS },
    { duration: '1m', target:    0 },
  ],
};

export default function () {
  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  // 1) Register/login once
  if (!userCreds[vu]) {
    const payload = { username, firstName: 'random', surName: 'random', email: `${username}@example.com`, password: PASSWORD };
    // register
    let reg = http.post(`${API_BASE_URL}/api/user/registerUser`, JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    check(reg, { 'register ok': r => r.status === 201 });
    if (reg.status !== 201) {
      console.error(`VU${vu} register error ${reg.status} body: ${reg.json()}`);
      return;
    }
    // login
    let login = http.post(`${API_BASE_URL}/api/user/signin`, JSON.stringify({ username, password: PASSWORD }), { headers: { 'Content-Type': 'application/json' } });
    check(login, { 'login ok': r => r.status === 200 });
    if (login.status !== 200) {
      console.error(`VU${vu} register error ${login.status} body: ${login.body}`);
      return;
    }
    const ld  = login.json();
    const jwt = login.headers['Authorization'] || login.headers['authorization'];
    const uid = ld.id || ld.userId;
    userCreds[vu] = { userId: uid, jwt };
  }

  const { userId, jwt } = userCreds[vu];
  let chatIds = [];

  for (let i = vu + 1; i <= TOTAL_USERS && chatIds.length < MAX_CHAT_PEERS; i++) {
    let other = `${USER_PREFIX}${Math.floor(Math.random() * (TOTAL_USERS - 1)) + 1}`;
    let c = http.post(
        `${API_BASE_URL}/api/chat/createChat`,
        JSON.stringify({ chatName: "test Name", userNames: [`${USER_PREFIX}${vu}`, other] }),
        { headers: { 'Content-Type': 'application/json',
            'Authorization': jwt } }
    );
    check(c, { 'create chat ok': r => r.status === 201 })
    if (c.status === 201) {
      const cid = c.json('chatId');
      chatIds.push(cid);
      console.log(`VU${vu}: chat created with ${other} => ${cid}`);
    } else {
      console.error(`VU${vu}: CreateChat ${other} error ${c.status} body: ${c.body}`);
    }
    sleep(5);
  }
  sleep(1);
}
