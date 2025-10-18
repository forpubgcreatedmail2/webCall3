/* ============================================================
   Dial — main.js (WhatsApp-style chat switching + calls)
   Replaces previous frontend logic: per-contact chat, call overlay,
   and messages stored per peer.
   ============================================================ */

let isCalling = false;
const pendingIce = {};

let ws = null;
let pc = null;
let userId = null;
let localStream = null;
let remoteStream = null;
let peerId = null;
let myFriends = [];
let myRequests = [];
let latestServerUsers = {};
let reconnectAttempts = 0;
const RECONNECT_MAX = 4;
let wsConnectedOnce = false;
let currentFacingMode = "user";

/* Chat state */
const chatHistory = {}; // chatHistory[peerId] = [{from, text, ts}]
let activeChat = null;

/* UI elements */
const currentUserEl = document.getElementById("currentUser");
const currentPeerEl = document.getElementById("currentPeer");
const msgInput = document.getElementById("msgInput");
const messagesDiv = document.getElementById("messages");
const onlineCount = document.getElementById("onlineCount");
const wsStatusEl = document.getElementById("wsStatus");

const loginModal = document.getElementById("loginModal");
const signupModal = document.getElementById("signupModal");
const userListEl = document.getElementById("userList");
const chatPanel = document.getElementById("chatPanel");
const contactsPanel = document.getElementById("contactsPanel");
const chatTitle = document.getElementById("chatTitle");
const chatSubtitle = document.getElementById("chatSubtitle");
const backToContacts = document.getElementById("backToContacts");
const chatCallBtn = document.getElementById("chatCallBtn");

const ringOverlay = document.getElementById("ringOverlay");
const ringFrom = document.getElementById("ringFrom");
const acceptBtn = document.getElementById("acceptBtn");
const rejectBtn = document.getElementById("rejectBtn");

const callOverlay = document.getElementById("callOverlay");
const callPeerName = document.getElementById("callPeerName");
const callState = document.getElementById("callState");
const endCallBtn = document.getElementById("endCallBtn");
const remoteVideo = document.getElementById("remoteVideo");
const localVideo = document.getElementById("localVideo");
const switchCameraBtn = document.getElementById("switchCameraBtn");
const muteBtn = document.getElementById("muteBtn");
const videoBtn = document.getElementById("videoBtn");
const callTimerEl = document.getElementById("callTimer");

const toastEl = document.getElementById("toast");

/* ===== Helpers ===== */
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 2400);
}

function setWsStatus(text, color) {
  wsStatusEl.textContent = text;
  document.getElementById("wsDot").style.background = color || "var(--muted)";
}

/* ===== WebSocket connect ===== */
function connectWS(force = false) {
  const token = localStorage.getItem("dial_token");
  if (!token || !userId) {
    showToast("Please log in first");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  if (!force && reconnectAttempts >= RECONNECT_MAX) {
    setWsStatus("Reconnect disabled", "#fb7185");
    return;
  }

  reconnectAttempts++;
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  setWsStatus("Connecting…", "#f59e0b");

  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: "register", from: userId, token: localStorage.getItem("dial_token") }));
    setWsStatus("Connected", "#10b981");
    console.log("WS connected for", userId);
  };

  ws.onclose = () => {
    setWsStatus("Disconnected", "#9ca3af");
    ws = null;
    cleanupOnDisconnect();
    if (reconnectAttempts < RECONNECT_MAX) setTimeout(connectWS, 1500);
  };

  ws.onerror = (e) => {
    console.warn("WS error", e);
    setWsStatus("Error", "#fb7185");
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWSMessage(msg);
    } catch (e) {
      console.warn("Invalid WS message", ev.data);
    }
  };
}

/* ===== WS message handling ===== */
function handleWSMessage(msg) {
  const { type } = msg;

  if (type === "online_list") {
    latestServerUsers = msg.users;
    renderUserList(msg.users);
    return;
  }

  if (type === "my_profile") {
    myFriends = msg.profile.friends || [];
    myRequests = msg.profile.requests || [];
    renderUserList(latestServerUsers);
    return;
  }

  if (type === "friend_request") {
    if (!myRequests.includes(msg.from)) myRequests.push(msg.from);
    showToast("Friend request from " + msg.from);
    renderUserList(latestServerUsers);
    return;
  }

  if (type === "friend_request_sent") {
    showToast("Friend request sent to " + msg.to);
    renderUserList(latestServerUsers);
    return;
  }

  if (type === "friend_accept") {
    showToast("Friend request accepted with " + (msg.with || msg.from));
    if (!myFriends.includes(msg.with)) myFriends.push(msg.with);
    renderUserList(latestServerUsers);
    return;
  }

if (type === "friend_removed") {
  showToast(`${msg.by} removed you from friends`);
  myFriends = myFriends.filter(f => f !== msg.by);
  renderUserList(latestServerUsers);
  return;
}


  if (type === "error") {
    if (msg.message && msg.message.toLowerCase().includes("auth")) {
      showToast("Auth failed — login again");
      logoutLocal();
      return;
    }
    showToast("Server error: " + (msg.message || "unknown"));
    return;
  }

  // WebRTC signals
  if (type === "offer") return onIncomingOffer(msg.from, msg.data);
  if (type === "answer") return onAnswer(msg.from, msg.data);
  if (type === "ice-candidate") return onCandidate(msg.from, msg.data);
  if (type === "hangup") return stopCall();

  // Chat messages
  if (type === "message") {
    const from = msg.from;
    const text = msg.data?.text || "";
    pushMessage(from, { from, text, ts: Date.now() });
    // if chat open with sender, render; otherwise show toast/new badge
    if (activeChat === from) renderMessagesFor(activeChat);
    else showToast("New message from " + from);
  }
}

/* ===== User list rendering ===== */
function renderUserList(users) {
  userListEl.innerHTML = "";
  let count = 0;
  for (const id in users) {
    if (id === userId) continue;
    const u = users[id];
    const item = document.createElement("div");
    item.className = "user-item";
    item.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center">
        <div class="dot ${u.online ? "on" : "off"}"></div>
        <div style="display:flex;flex-direction:column">
          <span class="user-name">${u.name || id}</span>
          <span class="small" style="color:var(--muted)">${u.online ? "Online" : "Offline"}</span>
        </div>
      </div>
      <div class="actions"></div>
    `;

    // click to open chat
    item.addEventListener("click", (e) => {
      // do not trigger when action button pressed
      if (e.target.closest(".actions")) return;
      openChat(id, u);
    });

    // actions: call / accept / add / pending
    const actions = item.querySelector(".actions");
    if (myFriends.includes(id)) {
  // --- Call button ---
  const btnCall = document.createElement("button");
  btnCall.className = "btn-small";
  btnCall.textContent = "📞";
  btnCall.onclick = (ev) => {
    ev.stopPropagation();
    startCallIfFriend(id);
  };
  actions.appendChild(btnCall);

  // --- Remove (Unfriend) button ---
  const btnRemove = document.createElement("button");
  btnRemove.className = "btn-small danger-btn";
  btnRemove.textContent = "❌";
  btnRemove.title = "Remove friend";
  btnRemove.onclick = (ev) => {
    ev.stopPropagation();
    if (confirm(`Remove ${id} from your friends?`)) {
      sendSig("friend_remove", id, null);
      myFriends = myFriends.filter(f => f !== id);
      renderUserList(latestServerUsers);
      showToast(`${id} removed`);
    }
  };
  actions.appendChild(btnRemove);
}
 else if (myRequests.includes(id)) {
      const b = document.createElement("button");
      b.className = "btn-small";
      b.textContent = "Accept";
      b.onclick = (ev) => {
        ev.stopPropagation();
        sendSig("friend_accept", id);
      };
      actions.appendChild(b);
    } else if (u.requests?.includes(userId)) {
      const b = document.createElement("button");
      b.className = "btn-small muted-btn";
      b.textContent = "Pending";
      actions.appendChild(b);
    } else {
      const b = document.createElement("button");
      b.className = "btn-small";
      b.textContent = "Add";
      b.onclick = (ev) => {
        ev.stopPropagation();
        sendSig("friend_request", id);
      };
      actions.appendChild(b);
    }

    if (u.online) count++;
    userListEl.appendChild(item);
  }
  onlineCount.textContent = `${count} online`;
}

/* ===== Chat management ===== */
function openChat(id, userObj = {}) {
  activeChat = id;
  currentPeerEl.textContent = id;
  chatTitle.textContent = userObj.name || id;
  chatSubtitle.textContent = userObj.online ? "Online" : "Offline";
  chatPanel.removeAttribute("aria-hidden");
  contactsPanel.style.display = window.innerWidth <= 800 ? "none" : ""; // hide on mobile
  document.getElementById("currentPeer").textContent = id;
  renderMessagesFor(id);
}

backToContacts.onclick = () => {
  activeChat = null;
  chatPanel.setAttribute("aria-hidden", "true");
  contactsPanel.style.display = "";
};

/* store and render messages */
function pushMessage(peer, msg) {
  chatHistory[peer] = chatHistory[peer] || [];
  chatHistory[peer].push(msg);
}

function renderMessagesFor(peer) {
  messagesDiv.innerHTML = "";
  const list = chatHistory[peer] || [];
  for (const m of list) {
    const div = document.createElement("div");
    div.className = (m.from === userId) ? "msg me" : "msg";
    const date = new Date(m.ts || Date.now());
    const time = ` ${("0" + date.getHours()).slice(-2)}:${("0" + date.getMinutes()).slice(-2)}`;
    div.textContent = (m.from === userId ? "Me: " : (m.from + ": ")) + m.text + time;
    messagesDiv.appendChild(div);
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

/* send message to activeChat */
document.getElementById("sendBtn").onclick = sendMessage;
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  if (!activeChat) return showToast("Open a chat first");
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert("Connect WS first");
  const text = msgInput.value.trim();
  if (!text) return;
  const to = activeChat;
  ws.send(JSON.stringify({ type: "message", from: userId, to, data: { text } }));
  pushMessage(to, { from: userId, text, ts: Date.now() });
  renderMessagesFor(to);
  msgInput.value = "";
}

/* ===== WebRTC Core (call logic) ===== */
function createPeerConnection() {
  if (pc) return;
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302"] },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate && peerId) sendSig("ice-candidate", peerId, e.candidate);
  };

  pc.ontrack = (e) => {
    if (!remoteStream) remoteStream = new MediaStream();
    e.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
    remoteVideo.srcObject = remoteStream;
  };

  pc.onconnectionstatechange = () => {
    if (pc && ["disconnected", "failed", "closed"].includes(pc.connectionState)) stopCall();
  };

  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
}

async function prepareLocalMedia() {
  if (localStream) return;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });
  localVideo.srcObject = localStream;
}

async function startCallIfFriend(to) {
  if (!myFriends.includes(to)) return alert("Only friends can be called.");
  if (isCalling) return showToast("Already calling...");
  isCalling = true;
  peerId = to;
  currentPeerEl.textContent = peerId;
  await prepareLocalMedia();
  createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSig("offer", peerId, offer);
  openCallView(peerId, "Calling…");
  chatCallBtn.classList.add("calling"); // 🔔 start glowing animation

}

async function onIncomingOffer(from, offer) {
  peerId = from;
  ringFrom.textContent = from;
  ringOverlay.classList.add("active");

  acceptBtn.onclick = async () => {
    ringOverlay.classList.remove("active");
    currentPeerEl.textContent = peerId;
    await prepareLocalMedia();
    createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await drainPendingIce(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSig("answer", from, answer);
    openCallView(peerId, "In call");
  };

  rejectBtn.onclick = () => {
    ringOverlay.classList.remove("active");
    sendSig("reject", from, null);
    peerId = null;
    showToast("Call rejected");
  };
}

async function onAnswer(from, answer) {
  if (!pc) {
    createPeerConnection();
    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  }
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
  await drainPendingIce(from);
  openCallView(from, "In call");
}

function onCandidate(from, candidate) {
  if (!from) return;
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
    pendingIce[from] = pendingIce[from] || [];
    pendingIce[from].push(candidate);
    return;
  }
  pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((e) => console.warn("ICE add failed", e));
}

async function drainPendingIce(from) {
  const list = pendingIce[from] || [];
  for (const cand of list) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {
      console.warn("drain candidate failed", e);
    }
  }
  pendingIce[from] = [];
}

/* Hangup + stop */
endCallBtn.onclick = () => stopCall(true);

function stopCall(emitHangup = false) {
  if (emitHangup && peerId && ws?.readyState === WebSocket.OPEN) sendSig("hangup", peerId, null);
  if (pc) pc.close();
  pc = null;
  isCalling = false;
  if (remoteStream) {
    remoteStream.getTracks().forEach((t) => t.stop());
    remoteStream = null;
    remoteVideo.srcObject = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
  peerId = null;
  currentPeerEl.textContent = "—";
  closeCallView();
  stopCallTimer();
chatCallBtn.classList.remove("calling");

}

/* Call timer */
let callStartTs = null;
let callTimerInterval = null;
function startCallTimer() {
  callStartTs = Date.now();
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const diff = Date.now() - callStartTs;
    const s = Math.floor(diff / 1000) % 60;
    const m = Math.floor(diff / 60000);
    callTimerEl.textContent = `${("0" + m).slice(-2)}:${("0" + s).slice(-2)}`;
  }, 1000);
}
function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  callTimerEl.textContent = "00:00";
}

/* Call overlay control */
function openCallView(peer, statusText = "") {
  callOverlay.classList.add("active");
  callPeerName.textContent = peer;
  callState.textContent = statusText;
  startCallTimer();
}

function closeCallView() {
  callOverlay.classList.remove("active");
}

/* Camera & audio controls */
switchCameraBtn.onclick = async () => {
  if (!localStream) return;
  currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });
  const newTrack = newStream.getVideoTracks()[0];
  const sender = pc?.getSenders().find((s) => s.track?.kind === "video");
  if (sender) sender.replaceTrack(newTrack);
  localVideo.srcObject = newStream;
  localStream.getTracks().forEach((t) => t.stop());
  localStream = newStream;
};

muteBtn.onclick = () => {
  if (!localStream) return showToast("No local media");
  localStream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
  muteBtn.textContent = localStream.getAudioTracks()[0].enabled ? "Mute" : "Unmute";
};

videoBtn.onclick = () => {
  if (!localStream) return showToast("No local media");
  localStream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
  videoBtn.textContent = localStream.getVideoTracks()[0].enabled ? "Video Off" : "Video On";
};

/* ===== Signaling helper ===== */
function sendSig(type, to, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, from: userId, to, data }));
  } else {
    showToast("WS not connected");
  }
}

/* ===== Auth & Auto Login ===== */
document.getElementById("toSignup").onclick = () => {
  loginModal.classList.remove("active");
  signupModal.classList.add("active");
};
document.getElementById("toLogin").onclick = () => {
  signupModal.classList.remove("active");
  loginModal.classList.add("active");
};

document.getElementById("signupBtn").onclick = async () => {
  const name = suName.value.trim(),
    mobile = suMobile.value.trim(),
    password = suPass.value.trim(),
    confirm = suConfirm.value.trim();
  if (!name || !mobile || !password || !confirm) return alert("All fields required");
  const res = await fetch("/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mobile, password, confirm })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);
  alert("Account created, please login");
  signupModal.classList.remove("active");
  loginModal.classList.add("active");
};

document.getElementById("loginBtn").onclick = async () => {
  const mobile = liMobile.value.trim(),
    password = liPass.value.trim();
  if (!mobile || !password) return alert("Fill all fields");
  const res = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile, password })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);
  localStorage.setItem("dial_token", data.token);
  localStorage.setItem("dial_userId", data.mobile);
  localStorage.setItem("dial_name", data.name || data.mobile);
  loginModal.classList.remove("active");
  showToast("Welcome " + (data.name || data.mobile));
  userId = data.mobile;
  currentUserEl.textContent = data.name || data.mobile;
  connectWS(true);
};

function logoutLocal() {
  localStorage.clear();
  location.reload();
}
document.getElementById("logoutBtn").onclick = logoutLocal;

window.addEventListener("load", () => {
  const token = localStorage.getItem("dial_token");
  const uid = localStorage.getItem("dial_userId");
  const name = localStorage.getItem("dial_name");

  if (token && uid) {
    userId = uid;
    currentUserEl.textContent = name || uid;
    loginModal.classList.remove("active");
    signupModal.classList.remove("active");
    setTimeout(() => {
      if (!wsConnectedOnce) {
        wsConnectedOnce = true;
        connectWS(true);
      }
    }, 300);
  } else {
    loginModal.classList.add("active");
  }
});

/* ===== Connect button ===== */
document.getElementById("connectBtn").onclick = () => connectWS(true);
document.getElementById("reconnectBtn").onclick = () => connectWS(true);

/* ===== chat call button (start call with activeChat) ===== */
chatCallBtn.onclick = () => {
  if (!activeChat) return showToast("Open a chat first");
  startCallIfFriend(activeChat);
};

/* ===== cleanup on disconnect ===== */
function cleanupOnDisconnect() {
  peerId = null;
  pc = null;
  isCalling = false;
  // do not clear chatHistory
  closeCallView();
}

/* ===== simple ping to keep alive (optional) ===== */
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", from: userId }));
}, 20000);


/* ===== Swap video views on tap (like WhatsApp) ===== */
const videoContainer = document.getElementById("videoContainer");

let isSwapped = false;

function toggleVideoSwap() {
  isSwapped = !isSwapped;
  if (isSwapped) videoContainer.classList.add("swap-active");
  else videoContainer.classList.remove("swap-active");
}

// Tap on local video to swap
localVideo.addEventListener("click", toggleVideoSwap);
// Tap on remote video to swap back
remoteVideo.addEventListener("click", toggleVideoSwap);

