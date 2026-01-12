/* whisp-e2e.js
 *
 * End-to-end validation for Whisp REST + STOMP (Node.js).
 *
 * WARNING: This script creates and deletes users and chats.
 * Run only against a test/staging environment.
 */

'use strict';

const { Client: StompClient } = require('@stomp/stompjs');
const SockJS = require('sockjs-client');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

const BASE_URL = "https://whisp-demo.api.whispchat.com"; //mustGetEnv('WHISP_BASE_URL');
const API_KEY = "8Nj2zKISsZOf0U2IIh2tdpEvvRQVEmVP"; //mustGetEnv('WHISP_API_KEY');
const PASSWORD = process.env.WHISP_PASSWORD || 'ChangeMe!12345';
const RUN_NEGATIVE = (process.env.WHISP_RUN_NEGATIVE || 'false').toLowerCase() === 'true';

// Timeouts
const HTTP_TIMEOUT_MS = 20_000;
const WS_CONNECT_TIMEOUT_MS = 20_000;
const WS_MESSAGE_TIMEOUT_MS = 20_000;

function mustGetEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Missing required env var: ${name}`);
        process.exit(2);
    }
    return v;
}

function nowIso() {
    return new Date().toISOString();
}

function randSuffix() {
    return Math.random().toString(36).slice(2, 5);
}

function authHeader(jwt) {
    if (!jwt) return undefined;
    return jwt.toLowerCase().startsWith('bearer ') ? jwt : `Bearer ${jwt}`;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(path, { method = 'GET', headers = {}, body, expectStatuses = [200] } = {}) {
    const url = `${BASE_URL}${path}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    const reqHeaders = {
        'Content-Type': 'application/json',
        ...headers,
    };

    let reqBody = undefined;
    if (body !== undefined) reqBody = JSON.stringify(body);

    let res;
    try {
        res = await fetch(url, { method, headers: reqHeaders, body: reqBody, signal: controller.signal });
    } catch (e) {
        clearTimeout(t);
        throw new Error(`HTTP ${method} ${path} failed: ${e.message}`);
    } finally {
        clearTimeout(t);
    }

    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    const parsed = contentType.includes('application/json') && text ? safeJson(text) : (text || null);

    if (!expectStatuses.includes(res.status)) {
        const authHdr = res.headers.get('authorization');
        throw new Error(
            [
                `Unexpected status for ${method} ${path}: ${res.status}`,
                `Response body: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
                authHdr ? `Response authorization header: ${authHdr}` : null,
            ].filter(Boolean).join('\n')
        );
    }

    return { status: res.status, headers: res.headers, body: parsed };
}

function safeJson(s) {
    try { return JSON.parse(s); } catch { return s; }
}

function assert(cond, msg) {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function logStep(title) {
    console.log(`\n=== ${title} ===`);
}

async function main() {
    console.log(`Whisp E2E starting: ${nowIso()}`);
    console.log(`BASE_URL: ${BASE_URL}`);
    console.log(`NEGATIVE TESTS: ${RUN_NEGATIVE}`);

    // Create two distinct users to validate real multi-user flows
    const sender = mkUser('sender');
    const receiver = mkUser('receiver');

    // --- Negative REST probes (optional)
    if (RUN_NEGATIVE) {
        logStep('NEGATIVE: getUser without JWT should 401');
        await fetchJson('/api/user/getUser', { method: 'GET', expectStatuses: [401] });

        logStep('NEGATIVE: getUser with invalid JWT should 401');
        await fetchJson('/api/user/getUser', {
            method: 'GET',
            headers: { Authorization: 'Bearer invalid.jwt.token' },
            expectStatuses: [401],
        });
    }

    // --- Register users
    logStep('Register sender');
    await registerUser(sender);

    logStep('Register receiver');
    await registerUser(receiver);

    // --- Sign in users
    logStep('Sign in sender');
    await signIn(sender);

    logStep('Sign in receiver');
    await signIn(receiver);

    // --- Change username (exercise endpoint)
    logStep('Change receiver username (exercises /api/user/changeUsername)');
    const newReceiverUsername = `receiver_${randSuffix()}`;
    await changeUsername(receiver, newReceiverUsername);

    // --- Get current user
    logStep('Get sender current user (/api/user/getUser)');
    await getCurrentUser(sender);

    logStep('Get receiver current user (/api/user/getUser)');
    await getCurrentUser(receiver);

    // --- Refresh JWT (exercise endpoint)
    logStep('Refresh sender JWT (/api/auth/refresh)');
    await refreshJwt(sender);

    // --- Create chat with both users
    logStep('Create chat (/api/chat/createChat)');
    const chatId = await createChat(sender, `whisp-e2e-chat-${randSuffix()}`, [sender.username, receiver.username]);

    // --- List chats
    logStep('List chats sender (/api/chat/getChats)');
    await listChats(sender);

    logStep('List chats receiver (/api/chat/getChats)');
    await listChats(receiver);

    // --- Get users in chat
    logStep('Get users in chat (/api/chat/getUsers/{chatId})');
    await getUsersInChat(sender, chatId);

    // --- Get websocket tickets
    logStep('Get websocket ticket sender (/api/user/getTicket)');
    await getTicket(sender);

    logStep('Get websocket ticket receiver (/api/user/getTicket)');
    await getTicket(receiver);

    // --- Connect STOMP clients (two separate clients)
    logStep('Connect STOMP receiver + subscribe');
    const receiverWs = await connectStomp(receiver, chatId);

    logStep('Connect STOMP sender');
    const senderWs = await connectStomp(sender, chatId);

    await sleep(5000);

    // --- Send message via STOMP, assert receiver got it
    logStep('STOMP: sender sends SEND_MSG, receiver must receive');
    const sendPayload = {
        type: 'SEND_MSG',
        senderId: sender.userId,
        message: `hello-from-sender-${randSuffix()}`,
        timeStamp: nowIso(),
        chatId,
    };

    const recvMsgPromise = receiverWs.waitFor((m) => m.type === 'SEND_MSG' && m.chatId === chatId);
    senderWs.publish('/api/chat', sendPayload);

    const receivedSend = await recvMsgPromise;
    assert(receivedSend.message === sendPayload.message, 'Receiver should get the same message content');
    assert(!!receivedSend.messageId, 'Receiver SEND_MSG should include messageId');
    const messageId = receivedSend.messageId;

    // --- Fetch messages via REST and validate the message exists
    logStep('Get messages (/api/messages/getMessages/{chatId}) and validate content');
    const messages = await getMessages(receiver, chatId);
    assert(
        Array.isArray(messages) && messages.some((m) => m.messageId === messageId || m.content === sendPayload.message),
        'Message should be present in /getMessages payload (by messageId or content)'
    );

    // --- Change chat name
    logStep('Change chat name (/api/chat/changeName)');
    await changeChatName(sender, chatId, `whisp-e2e-renamed-${randSuffix()}`);

    // --- Receiver leaves chat (removeUser)
    logStep('Receiver leaves chat (/api/chat/removeUser)');
    await removeUser(receiver, chatId, receiver.userId);

    // --- Sender adds receiver back (addUser)
    logStep('Sender adds receiver back (/api/chat/addUser)');
    await addUser(sender, chatId, receiver.username);

    // --- Get users in chat again
    logStep('Get users in chat again (/api/chat/getUsers/{chatId})');
    await getUsersInChat(sender, chatId);

    // --- Logout endpoints
    logStep('Logout sender (/api/auth/logout)');
    await logout(sender);

    logStep('LogoutAll receiver (/api/auth/logoutAll)');
    await logoutAll(receiver);

    // --- Delete chat
    logStep('Delete chat (/api/chat/deleteChat?chatId=...)');
    await deleteChat(sender, chatId);

    // --- Cleanup: disconnect websockets
    logStep('Disconnect STOMP clients');
    await senderWs.disconnect();
    await receiverWs.disconnect();

    // --- Delete users
    logStep('Delete sender (/api/user/deleteUser)');
    await deleteUser(sender);

    logStep('Delete receiver (/api/user/deleteUser)');
    await deleteUser(receiver);

    console.log(`\nWhisp E2E finished successfully: ${nowIso()}`);
}

function mkUser(label) {
    const username = `${label}_${randSuffix()}`;
    return {
        label,
        username,
        firstName: label,
        surName: 'Test',
        email: `${username}@example.com`,
        password: PASSWORD,
        userId: null,
        jwt: null,
        refreshToken: null,
        ticket: null,
    };
}

async function registerUser(u) {
    const res = await fetchJson('/api/user/registerUser', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: {
            username: u.username,
            firstName: u.firstName,
            surName: u.surName,
            email: u.email,
            password: u.password,
        },
        expectStatuses: [201, 400],
    });

    // If 400, user may already exist. This is still acceptable for repeatable runs.
    if (res.status === 201) {
        console.log(`Registered ${u.label}: ${u.username}`);
    } else {
        console.log(`Register returned 400 for ${u.label} (continuing): ${u.username}`);
        console.log(`body ${res.body}`);
    }
}

async function signIn(u) {
    console.log(`using username ${u.username} password ${u.password}`);
    const res = await fetchJson('/api/user/signin', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: { username: u.username, password: u.password },
        expectStatuses: [200],
    });

    const jwtHdr = res.headers.get('authorization');
    assert(jwtHdr, 'Signin response must include Authorization header with JWT');
    const body = res.body;

    assert(body && body.id && body.refreshToken, 'Signin body must include id and refreshToken');
    u.userId = body.id;
    u.refreshToken = body.refreshToken;
    u.jwt = jwtHdr;

    console.log(`Signed in ${u.label}: userId=${u.userId}`);
}

async function changeUsername(u, newUsername) {
    const res = await fetchJson('/api/user/changeUsername', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        body: { newUsername },
        expectStatuses: [200],
    });

    const newJwt = res.headers.get('authorization');
    assert(newJwt, 'changeUsername should return new JWT in Authorization header');
    u.jwt = newJwt;
    u.username = newUsername;

    console.log(`Changed username for ${u.label} to: ${u.username}`);
}

async function getCurrentUser(u) {
    const res = await fetchJson('/api/user/getUser', {
        method: 'GET',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    assert(res.body && res.body.id, 'getUser should return user object with id');
    return res.body;
}

async function refreshJwt(u) {
    const res = await fetchJson('/api/auth/refresh', {
        method: 'POST',
        headers: { Authorization: authHeader(u.refreshToken) },
        body: { expiredJwt: u.jwt },
        expectStatuses: [200],
    });

    const newJwt = res.headers.get('authorization');
    assert(newJwt, 'refresh should return new JWT in Authorization header');
    u.jwt = newJwt;

    console.log(`Refreshed JWT for ${u.label}`);
}

async function createChat(u, chatName, userNames) {
    const res = await fetchJson('/api/chat/createChat', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        body: { chatName, userNames },
        expectStatuses: [201],
    });

    assert(res.body && res.body.chatId, 'createChat must return chatId');
    console.log(`Created chat: chatId=${res.body.chatId}`);
    return res.body.chatId;
}

async function listChats(u) {
    const res = await fetchJson('/api/chat/getChats', {
        method: 'GET',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    assert(res.body && Array.isArray(res.body.chats), 'getChats must return {chats: []}');
    console.log(`${u.label} chats: ${res.body.chats.length}`);
    return res.body.chats;
}

async function getUsersInChat(u, chatId) {
    const res = await fetchJson(`/api/chat/getUsers/${encodeURIComponent(chatId)}`, {
        method: 'GET',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    assert(res.body && Array.isArray(res.body.users), 'getUsers must return {users: []}');
    console.log(`Users in chat ${chatId}: ${res.body.users.length}`);
    return res.body.users;
}

async function getMessages(u, chatId) {
    const res = await fetchJson(`/api/messages/getMessages/${encodeURIComponent(chatId)}`, {
        method: 'GET',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    assert(res.body && Array.isArray(res.body.messages), 'getMessages must return {messages: []}');
    console.log(`Messages in chat ${chatId}: ${res.body.messages.length}`);
    return res.body.messages;
}

async function addUser(u, chatId, newUsername) {
    const res = await fetchJson('/api/chat/addUser', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        body: { chatId, newUsername },
        expectStatuses: [200],
    });
    console.log(`Added user ${newUsername} to chat ${chatId}`);
    return res.body;
}

async function removeUser(u, chatId, removeUserId) {
    const res = await fetchJson('/api/chat/removeUser', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        body: { chatId, removeUser: removeUserId },
        expectStatuses: [200],
    });
    console.log(`${u.label} left chat ${chatId}`);
    return res.body;
}

async function changeChatName(u, chatId, newChatName) {
    const res = await fetchJson('/api/chat/changeName', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        body: { chatId, newChatName },
        expectStatuses: [200],
    });
    console.log(`Changed chat name for ${chatId} -> ${newChatName}`);
    return res.body;
}

async function deleteChat(u, chatId) {
    const res = await fetchJson(`/api/chat/deleteChat?chatId=${encodeURIComponent(chatId)}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    console.log(`Deleted chat ${chatId}`);
    return res.body;
}

async function logout(u) {
    const res = await fetchJson('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        body: { refreshToken: u.refreshToken },
        expectStatuses: [200],
    });
    console.log(`Logged out ${u.label}`);
    return res.body;
}

async function logoutAll(u) {
    const res = await fetchJson('/api/auth/logoutAll', {
        method: 'POST',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    console.log(`Logged out all sessions for ${u.label}`);
    return res.body;
}

async function deleteUser(u) {
    const res = await fetchJson('/api/user/deleteUser', {
        method: 'DELETE',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    console.log(`Deleted user ${u.label}: ${u.username}`);
    return res.body;
}

/**
 * STOMP connect helper.
 * - Uses SockJS endpoint: `${BASE_URL}/api/wsConnect?ticket=...`
 * - Sends Authorization via STOMP CONNECT headers.
 */
async function connectStomp(u, chatId) {
    const wsUrl = `${BASE_URL}/api/wsConnect?ticket=${u.ticket}`;
    const connectHeaders = { Authorization: authHeader(u.jwt) };

    const inbox = [];
    let connected = false;

    const client = new StompClient({
        webSocketFactory: () => new SockJS(wsUrl),
        connectHeaders,
        reconnectDelay: 0,
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,
        onConnect: () => {
            connected = true;

            const dest = `/user/${u.userId}/queue/messages`;
            client.subscribe(dest, (frame) => {
                const body = safeJson(frame.body);
                inbox.push(body);
            });
        },
        onStompError: (frame) => {
            console.error(`[stomp ${u.label}] STOMP error:`, frame.headers['message'], frame.body);
        },
        onWebSocketError: (err) => {
            // This triggers on auth/ticket problems or connectivity issues.
            // console.error(`[stomp ${u.label}] WS error:`, err?.message || err);
        },
    });

    // Ticket required per docs
    assert(u.ticket, `Missing websocket ticket for ${u.label} (call getTicket first)`);

    client.activate();

    // Wait for connect or timeout
    const start = Date.now();
    while (!connected) {
        if (Date.now() - start > WS_CONNECT_TIMEOUT_MS) {
            client.deactivate();
            throw new Error(`STOMP connect timeout for ${u.label}`);
        }
        await sleep(50);
    }

    console.log(`STOMP connected: ${u.label}`);

    return {
        publish: (destination, bodyObj) => client.publish({ destination, body: JSON.stringify(bodyObj) }),
        waitFor: (predicate) => waitForMessage(inbox, predicate, u.label),
        disconnect: async () => client.deactivate(),
    };
}

async function getTicket(u) {
    const res = await fetchJson('/api/user/getTicket', {
        method: 'GET',
        headers: { Authorization: authHeader(u.jwt) },
        expectStatuses: [200],
    });
    assert(res.body && res.body.ticket, 'getTicket must return {ticket: "..."}');
    u.ticket = res.body.ticket;
    return u.ticket;
}

function waitForMessage(inbox, predicate, label) {
    const started = Date.now();

    return new Promise((resolve, reject) => {
        const t = setInterval(() => {
            try {
                for (const msg of inbox) {
                    if (predicate(msg)) {
                        clearInterval(t);
                        resolve(msg);
                        return;
                    }
                }
                if (Date.now() - started > WS_MESSAGE_TIMEOUT_MS) {
                    clearInterval(t);
                    reject(new Error(`Timed out waiting for message for ${label}`));
                }
            } catch (e) {
                clearInterval(t);
                reject(e);
            }
        }, 50);
    });
}

// Run
main().catch((e) => {
    console.error('\nE2E FAILED:\n', e && e.stack ? e.stack : e);
    process.exit(1);
});
