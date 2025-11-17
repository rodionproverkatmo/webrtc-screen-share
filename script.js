// ВАЖНО:
// 1. Зайдите в консоль Firebase, создайте проект и включите Firestore (режим теста).
// 2. Вставьте свои параметры firebaseConfig ниже вместо заполнителей.
// 3. Залейте index.html, style.css, script.js на HTTPS-хостинг (например, GitHub Pages).
// 4. Откройте страницу на двух устройствах, используйте один и тот же код комнаты.

import {
    initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
    getFirestore,
    doc,
    setDoc,
    getDoc,
    updateDoc,
    onSnapshot,
    collection,
    addDoc,
    getDocs,
    serverTimestamp,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// --------- ВСТАВЬТЕ СЮДА СВОЮ КОНФИГУРАЦИЮ FIREBASE ---------
const firebaseConfig = {
  apiKey: "AIzaSyArUNeTp3jYhAnVdVys3zEhaM5LlqKaF3o",
  authDomain: "rodiktalk.firebaseapp.com",
  projectId: "rodiktalk",
  storageBucket: "rodiktalk.firebasestorage.app",
  messagingSenderId: "403937670998",
  appId: "1:403937670998:web:d51542b6c79c7c49ccc8f7"
};
// -------------------------------------------------------------

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// HTML-элементы
const roomInput = document.getElementById("roomInput");
const connectBtn = document.getElementById("connectBtn");
const micBtn = document.getElementById("micBtn");
const screenBtn = document.getElementById("screenBtn");
const statusText = document.getElementById("statusText");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

// WebRTC
const iceConfig = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
};

let pc = null;
let localStream = null;
let screenStream = null;
let usingScreen = false;

let videoSender = null; // RTCRtpSender для видео
let audioSender = null; // RTCRtpSender для аудио (экрана/микрофона)

let roomId = null;
let isCaller = false;

// Firestore ресурсы
let roomDocRef = null;
let callerCandidatesColl = null;
let calleeCandidatesColl = null;
let unsubRoomSnapshot = null;
let unsubCallerCandidates = null;
let unsubCalleeCandidates = null;

// --- Утилиты ---
function setStatus(msg) {
    statusText.textContent = msg;
    console.log("[STATUS]", msg);
}

function handleError(err, friendlyMsg) {
    console.error(err);
    setStatus(friendlyMsg || ("Ошибка: " + err.message));
}

// --- WebRTC инициализация ---
async function initLocalStream() {
    if (localStream) return;
    try {
        // На iOS Safari безопаснее запрашивать и видео, и аудио
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            },
            video: false // можно поставить true, если не будет мешать
        });
        localVideo.srcObject = localStream;
        setStatus("Микрофон включён. Готово к подключению.");
    } catch (e) {
        console.error("getUserMedia error:", e.name, e.message);
        handleError(e, "Не удалось получить доступ к микрофону. Проверьте настройки и соединение (HTTPS/localhost).");
        throw e;
    }
}

function createPeerConnection() {
    pc = new RTCPeerConnection(iceConfig);

    pc.onicecandidate = async (event) => {
        if (!event.candidate || !roomDocRef) return;
        try {
            const candidateData = event.candidate.toJSON();
            const targetColl = isCaller ? callerCandidatesColl : calleeCandidatesColl;
            await addDoc(targetColl, candidateData);
        } catch (e) {
            console.error("Ошибка добавления ICE кандидата:", e);
        }
    };

    pc.ontrack = (event) => {
        if (!remoteVideo.srcObject) {
            remoteVideo.srcObject = event.streams[0];
        } else {
            const remoteStream = remoteVideo.srcObject;
            for (const track of event.streams[0].getTracks()) {
                if (!remoteStream.getTracks().includes(track)) {
                    remoteStream.addTrack(track);
                }
            }
        }
    };

    pc.onconnectionstatechange = () => {
        console.log("connectionState:", pc.connectionState);
        if (pc.connectionState === "connected") {
            setStatus("Соединено. Можно разговаривать.");
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            setStatus("Соединение потеряно или не удалось установить.");
        }
    };

    // Добавляем аудио-треки
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
        audioSender = pc.addTrack(track, localStream);
    });
    }
}

// --- Работа с комнатой ---
async function createOrJoinRoom(id) {
    roomId = id.trim();
    if (!roomId) {
        setStatus("Введите код комнаты.");
        return;
    }

    connectBtn.disabled = true;
    roomInput.disabled = true;
    setStatus("Инициализация микрофона...");

    try {
        await initLocalStream();
    } catch (e) {
        connectBtn.disabled = false;
        roomInput.disabled = false;
        return;
    }

    createPeerConnection();

    roomDocRef = doc(db, "webrtc_rooms", roomId);
    const roomSnapshot = await getDoc(roomDocRef);

    callerCandidatesColl = collection(roomDocRef, "callerCandidates");
    calleeCandidatesColl = collection(roomDocRef, "calleeCandidates");

    if (!roomSnapshot.exists()) {
        // Создаём комнату и становимся вызывающей стороной
        isCaller = true;
        setStatus("Комната не найдена. Создаём комнату и ждём второго участника...");

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);

        await setDoc(roomDocRef, {
            createdAt: serverTimestamp(),
            offer: {
                type: offer.type,
                sdp: offer.sdp
            }
        });

        subscribeRoomChangesForCaller();
        subscribeCalleeCandidates();
    } else {
        // Присоединяемся как принимающая сторона
        isCaller = false;
        setStatus("Комната найдена. Подключаемся...");

        const roomData = roomSnapshot.data();
        if (!roomData.offer) {
            setStatus("Комната существует, но не содержит оффера. Попробуйте другой код.");
            connectBtn.disabled = false;
            roomInput.disabled = false;
            return;
        }

        const offer = roomData.offer;
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await updateDoc(roomDocRef, {
            answer: {
                type: answer.type,
                sdp: answer.sdp
            },
            joinedAt: serverTimestamp()
        });

        subscribeCallerCandidates();
        subscribeRoomChangesForCallee();
    }

    micBtn.disabled = false;
    screenBtn.disabled = false;
}

// --- Подписки Firestore ---
// Для вызывающего: ждём answer
function subscribeRoomChangesForCaller() {
    unsubRoomSnapshot = onSnapshot(roomDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (!pc.currentRemoteDescription && data?.answer) {
            const answer = new RTCSessionDescription(data.answer);
            await pc.setRemoteDescription(answer);
            setStatus("Второй участник подключился. Соединение устанавливается...");
        }
    });
}

// Для принимающего: можно слушать изменения для статуса, при желании
function subscribeRoomChangesForCallee() {
    unsubRoomSnapshot = onSnapshot(roomDocRef, (snapshot) => {
        const data = snapshot.data();
        if (data?.offer && !pc.currentRemoteDescription) {
            pc.setRemoteDescription(new RTCSessionDescription(data.offer)).catch(console.error);
        }
    });
}

function subscribeCallerCandidates() {
    unsubCallerCandidates = onSnapshot(callerCandidatesColl, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const candidate = new RTCIceCandidate(change.doc.data());
                pc.addIceCandidate(candidate).catch(console.error);
            }
        });
    });
}

function subscribeCalleeCandidates() {
    unsubCalleeCandidates = onSnapshot(calleeCandidatesColl, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const candidate = new RTCIceCandidate(change.doc.data());
                pc.addIceCandidate(candidate).catch(console.error);
            }
        });
    });
}

// --- Микрофон ---
micBtn.addEventListener("click", () => {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) return;
    const enabled = audioTracks[0].enabled;
    audioTracks.forEach((t) => (t.enabled = !enabled));

    if (enabled) {
        micBtn.textContent = "Включить микрофон";
        setStatus("Микрофон выключен.");
    } else {
        micBtn.textContent = "Выключить микрофон";
        setStatus("Микрофон включен.");
    }
});

// --- Демонстрация экрана ---
screenBtn.addEventListener("click", async () => {
    if (!pc) return;

    if (!usingScreen) {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
            setStatus("Ваш браузер не поддерживает демонстрацию экрана.");
            return;
        }

        try {
            // Получаем экран (видео + системный/вкладочный звук, если доступен)
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });

            usingScreen = true;
            screenBtn.textContent = "Остановить демонстрацию экрана";
            setStatus("Экран транслируется.");

            // Показываем экран локально
            localVideo.srcObject = screenStream;

            const screenVideoTrack = screenStream.getVideoTracks()[0] || null;
            const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

            // === ВИДЕО ===
            if (screenVideoTrack) {
                if (!videoSender) {
                    // Раньше видео не отправляли — добавляем новый sender
                    videoSender = pc.addTrack(screenVideoTrack, screenStream);
                } else {
                    // Уже есть отправитель видео — просто заменяем трек
                    await videoSender.replaceTrack(screenVideoTrack);
                }
            }

            // === АУДИО ЭКРАНА ===
            if (screenAudioTrack) {
                if (!audioSender) {
                    audioSender = pc.addTrack(screenAudioTrack, screenStream);
                } else {
                    await audioSender.replaceTrack(screenAudioTrack);
                }
            }

            // Когда пользователь руками останавливает шаринг через системный диалог
            screenStream.getVideoTracks()[0].addEventListener("ended", () => {
                stopScreenShare();
            });

        } catch (e) {
            handleError(e, "Не удалось начать демонстрацию экрана.");
        }
    } else {
        stopScreenShare();
    }
});

async function stopScreenShare() {
    if (!usingScreen) return;

    usingScreen = false;
    screenBtn.textContent = "Начать демонстрацию экрана";
    setStatus("Демонстрация экрана остановлена.");

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }

    // Возвращаем локальный микрофон в виде отправляемого аудио
    const micTrack = localStream?.getAudioTracks()[0] || null;

    if (audioSender && micTrack) {
        try {
            await audioSender.replaceTrack(micTrack);
        } catch (e) {
            console.warn("Не удалось вернуть аудио микрофона:", e);
        }
    }

    // Видео убираем (мы не используем камеру по умолчанию)
    if (videoSender) {
        try {
            await videoSender.replaceTrack(null);
        } catch (e) {
            console.warn("Не удалось отключить видеотрек:", e);
        }
    }

    // Снова показываем локальный поток микрофона (аудио) / пустое видео
    localVideo.srcObject = localStream || null;
}



// --- Подключение ---
connectBtn.addEventListener("click", async () => {
    try {
        await createOrJoinRoom(roomInput.value);
    } catch (e) {
        handleError(e, "Ошибка при создании/подключении к комнате.");
        connectBtn.disabled = false;
        roomInput.disabled = false;
    }
});

// --- Очистка (при закрытии вкладки) ---
window.addEventListener("beforeunload", async () => {
    if (unsubRoomSnapshot) unsubRoomSnapshot();
    if (unsubCallerCandidates) unsubCallerCandidates();
    if (unsubCalleeCandidates) unsubCalleeCandidates();

    if (roomDocRef && callerCandidatesColl && calleeCandidatesColl) {
        try {
            const deleteSubcollection = async (collRef) => {
                const qSnap = await getDocs(collRef);
                const deletions = qSnap.docs.map((d) => deleteDoc(d.ref));
                await Promise.all(deletions);
            };
            await deleteSubcollection(callerCandidatesColl);
            await deleteSubcollection(calleeCandidatesColl);
            await deleteDoc(roomDocRef);
        } catch (e) {
            console.warn("Ошибка очистки комнаты:", e);
        }
    }

    if (pc) {
        pc.getSenders().forEach((s) => {
            if (s.track) s.track.stop();
        });
        pc.close();
        pc = null;
    }

    if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
    }

    if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
    }
});
