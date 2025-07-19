
// k6 load test with two-stage execution: registration then chat creation
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// CONFIG
const API_BASE_URL   = __ENV.API_BASE_URL   || 'https://whisp-dev.api.whispchat.com';
const USER_PREFIX    = __ENV.USER_PREFIX    || 'user';
const PASSWORD       = __ENV.PASSWORD       || 'password123';
const TOTAL_USERS    = +(__ENV.TOTAL_USERS)    || 5000;
const MAX_CHAT_PEERS = +(__ENV.MAX_CHAT_PEERS) || 100;

// METRICS
export let registrationErrors = new Counter('registration_error_count');
export let chatCreationErrors = new Counter('chat_creation_error_count');

// Shared storage for user credentials across stages
const userCredentials = new SharedArray('user_creds', function () {
  return new Array(TOTAL_USERS).fill(null).map((_, i) => ({
    username: `${USER_PREFIX}${i + 1}`,
    userId: null,
    jwt: null
  }));
});

export let options = {
  scenarios: {
    // Stage 1: User Registration
    user_registration: {
      executor: 'ramping-vus',
      stages: [
        { duration: '3m', target: TOTAL_USERS },  // Ramp up for registration
        { duration: '3m', target: TOTAL_USERS },  // Hold for registration completion
        { duration: '1m', target: 0 },           // Ramp down
      ],
      exec: 'registerUsers',
      startTime: '0s',
    },

    // Stage 2: Chat Creation (starts after registration completes)
    chat_creation: {
      executor: 'ramping-vus',
      stages: [
        { duration: '3m', target: TOTAL_USERS },  // Ramp up for chat creation
        { duration: '3m', target: TOTAL_USERS },  // Hold for chat creation
        { duration: '1m', target: 0 },            // Ramp down
      ],
      exec: 'createChats',
      startTime: '7m', // Start after registration stage completes
    }
  }
};

// Stage 1: User Registration Function
export function registerUsers() {
  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  console.log(`VU${vu}: Starting registration for ${username}`);

  // Register user
  const payload = {
    username,
    firstName: 'test',
    surName: 'user',
    email: `${username}@example.com`,
    password: PASSWORD
  };

  let reg = http.post(
      `${API_BASE_URL}/api/user/registerUser`,
      JSON.stringify(payload),
      { headers: { 'Content-Type': 'application/json' } }
  );

  check(reg, { 'register ok': r => r.status === 201 });

  if (reg.status !== 201) {
    console.error(`VU${vu} register error ${reg.status} body: ${reg.body}`);
    registrationErrors.add(1);
    sleep(0.5);
    return;
  }

  // Login user
  let login = http.post(
      `${API_BASE_URL}/api/user/signin`,
      JSON.stringify({ username, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } }
  );

  check(login, { 'login ok': r => r.status === 200 });

  if (login.status !== 200) {
    console.error(`VU${vu} login error ${login.status} body: ${login.body}`);
    registrationErrors.add(1);
    sleep(0.5);
    return;
  }

  const loginData = login.json();
  const jwt = login.headers['Authorization'] || login.headers['authorization'];
  const userId = loginData.id || loginData.userId;

  // Store credentials for Stage 2 (in practice, you'd use external storage like Redis)
  // For k6, we'll use a workaround with environment variables or external file
  console.log(`VU${vu}: Registration successful - UserID: ${userId}`);

  sleep(1);
}

// Stage 2: Chat Creation Function  
export function createChats() {
  const vu = __VU;
  const username = `${USER_PREFIX}${vu}`;

  console.log(`VU${vu}: Starting chat creation for ${username}`);

  // Re-login to get fresh JWT (since we can't easily share state between scenarios)
  let login = http.post(
      `${API_BASE_URL}/api/user/signin`,
      JSON.stringify({ username, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } }
  );

  check(login, { 'login re-auth ok': r => r.status === 200 });

  if (login.status !== 200) {
    console.error(`VU${vu} re-login error ${login.status} body: ${login.body}`);
    chatCreationErrors.add(1);
    return;
  }

  const loginData = login.json();
  const jwt = login.headers['Authorization'] || login.headers['authorization'];
  const userId = loginData.id || loginData.userId;

  // Create random chats
  let chatIds = [];
  const chatsToCreate = Math.min(MAX_CHAT_PEERS, TOTAL_USERS - 1);

  for (let i = 0; i < chatsToCreate; i++) {
    // Pick a random other user
    let otherUserNum;
    do {
      otherUserNum = Math.floor(Math.random() * TOTAL_USERS) + 1;
    } while (otherUserNum === vu); // Don't chat with yourself

    const otherUsername = `${USER_PREFIX}${otherUserNum}`;

    let chatResponse = http.post(
        `${API_BASE_URL}/api/chat/createChat`,
        JSON.stringify({
          chatName: `Chat-${vu}-${otherUserNum}`,
          userNames: [username, otherUsername]
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': jwt
          }
        }
    );

    check(chatResponse, { 'create chat ok': r => r.status === 201 });

    if (chatResponse.status === 201) {
      const chatId = chatResponse.json('chatId');
      chatIds.push(chatId);
      console.log(`VU${vu}: Chat ${i+1}/${chatsToCreate} created with ${otherUsername} => ${chatId}`);
      sleep(0.5)
    } else {
      console.error(`VU${vu}: CreateChat with ${otherUsername} error ${chatResponse.status} body: ${chatResponse.body}`);
      chatCreationErrors.add(1);
    }

    // Small delay to avoid overwhelming the API
    sleep(0.5);
  }

  console.log(`VU${vu}: Chat creation completed. Created ${chatIds.length} chats.`);
  sleep(1);
}