// k6 init script: register users and create chats for load tests
//
// Key changes vs. old script:
// - Uses x-api-key for /api/user/registerUser and /api/user/signin
// - Uses Bearer JWT in Authorization header for authenticated endpoints
//
// Env vars:
//   API_BASE_URL   (default: https://whisp-dev.api.whispchat.com)
//   API_KEY        (required for register/signin; default: empty -> script will fail fast)
//   USER_PREFIX    (default: user)
//   PASSWORD       (default: password123)
//   TOTAL_USERS    (default: 5000)
//   MAX_CHAT_PEERS (default: 100)

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Counter } from 'k6/metrics';

// CONFIG
const API_BASE_URL   = __ENV.API_BASE_URL   || 'https://whisp-dev.api.whispchat.com';
const API_KEY        = __ENV.API_KEY        || '8Nj2zKISsZOf0U2IIh2tdpEvvRQVEmVP';
const USER_PREFIX    = __ENV.USER_PREFIX    || 'user';
const PASSWORD       = __ENV.PASSWORD       || 'password123';
const TOTAL_USERS    = +(__ENV.TOTAL_USERS)    || 1250;
const MAX_CHAT_PEERS = +(__ENV.MAX_CHAT_PEERS) || 100;

if (!API_KEY) {
  fail('Missing required env var: API_KEY (x-api-key used for register/signin)');
}

// METRICS
export const registrationErrors = new Counter('registration_error_count');
export const chatCreationErrors = new Counter('chat_creation_error_count');

function asBearer(token) {
  if (!token) return token;
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
}

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

export const options = {
  scenarios: {
    // Stage 1: User Registration
    // user_registration: {
    //   executor: 'ramping-vus',
    //   stages: [
    //     { duration: '3m', target: TOTAL_USERS }, // ramp up
    //     { duration: '3m', target: TOTAL_USERS }, // hold (we guard to only do work once per VU)
    //     { duration: '1m', target: 0 },           // ramp down
    //   ],
    //   exec: 'registerUsers',
    //   startTime: '0s',
    //   gracefulStop: '30s',
    // },

    // Stage 2: Chat Creation
    chat_creation: {
      executor: 'ramping-vus',
      stages: [
        { duration: '4m', target: TOTAL_USERS },
        { duration: '5m', target: TOTAL_USERS },
        { duration: '1m', target: 0 },
      ],
      exec: 'createChats',
      startTime: '10m',
      gracefulStop: '30s',
    },
  },
};

// Stage 1: Register + verify signin (once per VU)
export function registerUsers() {
  if (__ITER > 0) {
    // Prevent repeated registrations during the "hold" stage.
    sleep(10);
    return;
  }

  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  const registerPayload = {
    username,
    firstName: 'test',
    surName: 'user',
    email: `${username}@example.com`,
    password: PASSWORD,
  };

  // Register user (API may return 400 if user already exists; allow repeatable runs)
  const reg = http.post(
    `${API_BASE_URL}/api/user/registerUser`,
    JSON.stringify(registerPayload),
    { headers: jsonHeaders({ 'x-api-key': API_KEY }) }
  );

  const regOk = check(reg, {
    'register status is 201 or 400': (r) => r.status === 201 || r.status === 400,
  });

  if (!regOk) {
    console.error(`VU${vu} register error ${reg.status} body: ${reg.body}`);
    registrationErrors.add(1);
    sleep(1.5);
    return;
  }

  // Sign in user (must include x-api-key)
  const login = http.post(
    `${API_BASE_URL}/api/user/signin`,
    JSON.stringify({ username, password: PASSWORD }),
    { headers: jsonHeaders({ 'x-api-key': API_KEY }) }
  );

  const loginOk = check(login, {
    'login ok (200)': (r) => r.status === 200,
    'login returns Authorization header': (r) => !!(r.headers['Authorization'] || r.headers['authorization']),
  });

  if (!loginOk) {
    console.error(`VU${vu} login error ${login.status} body: ${login.body}`);
    registrationErrors.add(1);
    sleep(1.5);
    return;
  }

  const loginData = login.json();
  const jwtHdr = login.headers['Authorization'] || login.headers['authorization'];
  const userId = loginData?.id || loginData?.userId;

  if (!userId || !jwtHdr) {
    console.error(`VU${vu} login missing userId/jwt. body: ${login.body}`);
    registrationErrors.add(1);
    sleep(1.5);
    return;
  }

  console.log(`VU${vu}: registered+signed-in ok userId=${userId}`);
  sleep(1);
}

// Stage 2: Create chats (once per VU)
export function createChats() {
  //if (__ITER > 0) {
    // Prevent repeated chat creation during the "hold" stage.
    //sleep(10);
    //return;
  //}

  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  // Re-login to get fresh JWT (we do not share state between scenarios safely)
  const login = http.post(
    `${API_BASE_URL}/api/user/signin`,
    JSON.stringify({ username, password: PASSWORD }),
    { headers: jsonHeaders({ 'x-api-key': API_KEY }) }
  );

  const loginOk = check(login, { 'login re-auth ok (200)': (r) => r.status === 200 });
  if (!loginOk) {
    console.error(`VU${vu} re-login error ${login.status} body: ${login.body}`);
    chatCreationErrors.add(1);
    return;
  }

  const loginData = login.json();
  const jwtHdr = login.headers['Authorization'] || login.headers['authorization'];
  const jwt = asBearer(jwtHdr);

  if (!jwt || !loginData) {
    console.error(`VU${vu} re-login missing jwt/body. body: ${login.body}`);
    chatCreationErrors.add(1);
    return;
  }

  // Create chats with random peers
  const chatsToCreate = Math.min(MAX_CHAT_PEERS, Math.max(0, TOTAL_USERS - 1));
  let created = 0;

  for (let i = 0; i < chatsToCreate; i++) {
    let otherUserNum;
    do {
      otherUserNum = Math.floor(Math.random() * TOTAL_USERS) + 1;
    } while (otherUserNum === vu);

    const otherUsername = `${USER_PREFIX}${otherUserNum}`;
    const payload = { chatName: `Chat-${vu}-${otherUserNum}`, userNames: [username, otherUsername] };

    const chatResponse = http.post(
      `${API_BASE_URL}/api/chat/createChat`,
      JSON.stringify(payload),
      { headers: jsonHeaders({ Authorization: jwt }) }
    );

    const ok = check(chatResponse, { 'create chat ok (201)': (r) => r.status === 201 });

    if (ok) {
      created++;
      // optional: chatResponse.json('chatId')
    } else {
      console.error(`VU${vu}: CreateChat error ${chatResponse.status} body: ${chatResponse.body}`);
      chatCreationErrors.add(1);
    }

    // Small delay to avoid thundering herd / rate spikes
    sleep(1.5);
  }

  console.log(`VU${vu}: chat creation completed. Created ${created}/${chatsToCreate} chats.`);
  sleep(1);
}
