import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

// ============================================================================
// 1. HẰNG SỐ CẤU HÌNH VẬT LÝ & TỐI ƯU PHẦN CỨNG (INTEL HD 520)
// ============================================================================
const ISLAND_RADIUS = 250;
const MAX_ALTITUDE = 65;
const GROUND_CRASH_Y = 1.5;

// Kích thước Cổng Bắt Buộc (2 thanh dọc tạo mặt phẳng chữ nhật rộng cảm giác ~2m)
const RECT_GATE_WIDTH = 7.6;   // Khoảng cách thông thủy giữa 2 thanh đứng
const RECT_GATE_HEIGHT = 13.0; // Chiều cao mặt phẳng chữ nhật
const RECT_HALF_W = RECT_GATE_WIDTH * 0.5;
const RECT_HALF_H = RECT_GATE_HEIGHT * 0.5;

// Kích thước Cổng Ring Bonus (+2 điểm Táo, không bắt buộc)
const BONUS_RING_RADIUS = 4.6;

// Tần suất MediaPipe: 50ms/lần (20 FPS), Lerp factor = 0.15 ở 60 FPS
const MP_INTERVAL_MS = 50;
const LERP_FACTOR = 0.15;

// Ngưỡng Máy Trạng Thái Vật Lý 3 Chế Độ
const GLIDE_SINK_RATE = -1.65;
const DIVE_SINK_RATE = GLIDE_SINK_RATE * 7.0;  // Rơi nhanh gấp 7 lần (-11.55)
const FLAP_UPWARD_IMPULSE = 11.8;
const FLAP_COOLDOWN_MS = 300;
const FLAP_VELOCITY_THRESHOLD = 0.036;
const DIVE_HOLD_THRESHOLD_MS = 350;
const DIVE_PITCH_RAD = -35 * (Math.PI / 180);

// ============================================================================
// 2. BIẾN TRẠNG THÁI TOÀN CỤC
// ============================================================================
const STATE = {
  GLIDE: 'GLIDE',
  FLAP: 'FLAP',
  DIVE: 'DIVE'
};

let currentFlightState = STATE.GLIDE;
let isGameRunning = false;
let isGameOver = false;
let score = 0;
let highScore = 0;
let currentGateNumber = 1;
let courseAnchorHeading = 0;

try {
  highScore = parseInt(localStorage.getItem('pose_slalom_high_score') || '0', 10);
} catch (e) {
  highScore = 0;
}

let targetRoll = 0;
let smoothRoll = 0;
let targetPitch = 0;
let smoothPitch = 0;
let targetVy = GLIDE_SINK_RATE;
let smoothVy = GLIDE_SINK_RATE;
let targetSpeed = 23;
let smoothSpeed = 23;

let lastMpTimestamp = 0;
let prevWristY = null;
let lastUpperZoneTime = 0;
let lastFlapTime = 0;
let flapStateHoldUntil = 0;
let lowWristAccumMs = 0;
let handsUpRestartAccumMs = 0;
let popupTimeout = null;

// ============================================================================
// 3. DOM ELEMENTS
// ============================================================================
const videoEl = document.getElementById('webcam');
const poseCanvas = document.getElementById('pose-canvas');
const poseCtx = poseCanvas.getContext('2d');
const scoreTextEl = document.getElementById('score-text');
const bestTextEl = document.getElementById('best-text');
const gateProgressTextEl = document.getElementById('gate-progress-text');
const stateBadgeEl = document.getElementById('state-badge');
const altValueEl = document.getElementById('alt-value');
const altBarFillEl = document.getElementById('altitude-bar-fill');
const compassArrowEl = document.getElementById('compass-arrow');
const compassDistEl = document.getElementById('compass-dist');
const scorePopupEl = document.getElementById('score-popup');
const diveWarningBanner = document.getElementById('dive-warning-banner');
const startModal = document.getElementById('start-modal');
const gameoverModal = document.getElementById('gameover-modal');
const btnStart = document.getElementById('btn-start');
const btnRestart = document.getElementById('btn-restart');
const loadingStatus = document.getElementById('loading-status');
const finalScoreMsg = document.getElementById('final-score-msg');
const handsUpProgressBar = document.getElementById('hands-up-progress-bar');

bestTextEl.textContent = `🏆 Kỷ lục: ${highScore}`;

function showScorePopup(text, bgColor) {
  scorePopupEl.textContent = text;
  scorePopupEl.style.background = bgColor;
  scorePopupEl.style.opacity = '1';
  scorePopupEl.style.transform = 'translate(-50%, -60%) scale(1.08)';
  if (popupTimeout) clearTimeout(popupTimeout);
  popupTimeout = setTimeout(() => {
    scorePopupEl.style.opacity = '0';
    scorePopupEl.style.transform = 'translate(-50%, -50%) scale(0.95)';
  }, 950);
}

// ============================================================================
// 4. KHỞI TẠO THREE.JS (TỐI ƯU HÓA INTEL HD 520)
// ============================================================================
const container = document.getElementById('three-canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7ec8e3);
scene.fog = new THREE.Fog(0x7ec8e3, 180, 460);

const camera = new THREE.PerspectiveCamera(
  60,
  container.clientWidth / container.clientHeight,
  0.5,
  500
);

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(1);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = false;
container.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff4d6, 0.9);
dirLight.position.set(120, 220, 100);
scene.add(dirLight);

function createLambertMat(colorHex, extra = {}) {
  return new THREE.MeshLambertMaterial({
    color: colorHex,
    flatShading: true,
    ...extra
  });
}

// ============================================================================
// 5. XÂY DỰNG BẢN ĐỒ ĐẢO TRÒN (BÁN KÍNH 250) & MẶT BIỂN LOW-POLY
// ============================================================================
function buildWorldEnvironment() {
  const seaGeo = new THREE.CylinderGeometry(700, 700, 1, 24);
  const seaMat = createLambertMat(0x0284c7);
  const seaMesh = new THREE.Mesh(seaGeo, seaMat);
  seaMesh.position.y = -0.4;
  scene.add(seaMesh);

  const islandGeo = new THREE.CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS + 12, 3.0, 32, 6);
  const posAttr = islandGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    if (vy > 0) {
      const distFromCenter = Math.hypot(vx, vz);
      const edgeFactor = Math.max(0, 1 - distFromCenter / ISLAND_RADIUS);
      const wave = (Math.sin(vx * 0.045) + Math.cos(vz * 0.045)) * 0.35 * edgeFactor;
      posAttr.setY(i, 0.6 + wave);
    }
  }
  islandGeo.computeVertexNormals();
  const islandMat = createLambertMat(0x4ade80);
  const islandMesh = new THREE.Mesh(islandGeo, islandMat);
  islandMesh.position.y = -0.3;
  scene.add(islandMesh);

  const sandGeo = new THREE.CylinderGeometry(ISLAND_RADIUS + 8, ISLAND_RADIUS + 18, 1.2, 32);
  const sandMat = createLambertMat(0xfde047);
  const sandMesh = new THREE.Mesh(sandGeo, sandMat);
  sandMesh.position.y = -0.25;
  scene.add(sandMesh);

  const trunkGeo = new THREE.CylinderGeometry(0.6, 0.9, 3.5, 5);
  const trunkMat = createLambertMat(0x78350f);
  const leavesGeo = new THREE.ConeGeometry(3.2, 7.5, 6);
  const leavesMat1 = createLambertMat(0x15803d);
  const leavesMat2 = createLambertMat(0x166534);
  const rockGeo = new THREE.DodecahedronGeometry(2.4, 0);
  const rockMat = createLambertMat(0x64748b);

  for (let i = 0; i < 65; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (ISLAND_RADIUS - 18);
    const tx = Math.cos(angle) * r;
    const tz = Math.sin(angle) * r;
    const treeGroup = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 1.75;
    const crown = new THREE.Mesh(leavesGeo, i % 2 === 0 ? leavesMat1 : leavesMat2);
    crown.position.y = 6.2;
    const scale = 0.8 + Math.random() * 0.7;
    treeGroup.add(trunk, crown);
    treeGroup.scale.set(scale, scale, scale);
    treeGroup.position.set(tx, 0.2, tz);
    scene.add(treeGroup);
  }

  for (let i = 0; i < 40; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (ISLAND_RADIUS - 12);
    const rx = Math.cos(angle) * r;
    const rz = Math.sin(angle) * r;
    const rock = new THREE.Mesh(rockGeo, rockMat);
    const s = 0.6 + Math.random() * 1.3;
    rock.scale.set(s, s * 0.7, s);
    rock.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    rock.position.set(rx, 0.8, rz);
    scene.add(rock);
  }
}

buildWorldEnvironment();

// ============================================================================
// 6. CỔNG BẮT BUỘC (2 THANH DỌC TẠO MẶT PHẲNG CHỮ NHẬT) & CỔNG RING BONUS (+2 🍎)
// ============================================================================

// --- A. CỔNG BẮT BUỘC (MANDATORY RECTANGULAR GATE) ---
const mandatoryGate = {
  group: new THREE.Group(),
  pillar: null
};

// 2 Thanh trụ dọc hai bên (Màu trắng-đỏ slalom nổi bật)
const poleGeo = new THREE.CylinderGeometry(0.42, 0.42, RECT_GATE_HEIGHT, 8);
const poleMat = createLambertMat(0x38bdf8);
const poleCapGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
const poleCapMat = createLambertMat(0xfde047);

const leftPole = new THREE.Mesh(poleGeo, poleMat);
leftPole.position.set(-RECT_HALF_W, 0, 0);
const leftCap = new THREE.Mesh(poleCapGeo, poleCapMat);
leftCap.position.set(-RECT_HALF_W, RECT_HALF_H + 0.5, 0);

const rightPole = new THREE.Mesh(poleGeo, poleMat);
rightPole.position.set(RECT_HALF_W, 0, 0);
const rightCap = new THREE.Mesh(poleCapGeo, poleCapMat);
rightCap.position.set(RECT_HALF_W, RECT_HALF_H + 0.5, 0);

// 2 Thanh viền mảnh trên & dưới khép kín khung chữ nhật
const crossBarGeo = new THREE.BoxGeometry(RECT_GATE_WIDTH + 0.8, 0.28, 0.28);
const crossBarMat = createLambertMat(0x7dd3fc);
const topBar = new THREE.Mesh(crossBarGeo, crossBarMat);
topBar.position.set(0, RECT_HALF_H, 0);
const bottomBar = new THREE.Mesh(crossBarGeo, crossBarMat);
bottomBar.position.set(0, -RECT_HALF_H, 0);

// Mặt phẳng năng lượng hình chữ nhật bán trong suốt ở giữa 2 thanh
const rectPlaneGeo = new THREE.PlaneGeometry(RECT_GATE_WIDTH, RECT_GATE_HEIGHT);
const rectPlaneMat = new THREE.MeshLambertMaterial({
  color: 0x00f2fe,
  transparent: true,
  opacity: 0.28,
  side: THREE.DoubleSide,
  depthWrite: false,
  flatShading: true
});
const rectPlaneMesh = new THREE.Mesh(rectPlaneGeo, rectPlaneMat);

mandatoryGate.group.add(leftPole, rightPole, leftCap, rightCap, topBar, bottomBar, rectPlaneMesh);
scene.add(mandatoryGate.group);

// Cột sáng dẫn đường từ xa cho Cổng Bắt Buộc
const gateBeaconGeo = new THREE.CylinderGeometry(1.1, 1.1, 180, 8, 1, true);
const gateBeaconMat = new THREE.MeshLambertMaterial({
  color: 0x38bdf8,
  transparent: true,
  opacity: 0.18,
  side: THREE.DoubleSide,
  depthWrite: false,
  flatShading: true
});
mandatoryGate.pillar = new THREE.Mesh(gateBeaconGeo, gateBeaconMat);
scene.add(mandatoryGate.pillar);

// --- B. CỔNG RING BONUS (OPTIONAL RING +2 🍎) ---
const bonusRing = {
  group: new THREE.Group(),
  appleEmblem: new THREE.Group(),
  active: true
};

const torusGeo = new THREE.TorusGeometry(BONUS_RING_RADIUS, 0.5, 8, 22);
const torusMat = createLambertMat(0xfbbf24); // Vàng kim rực rỡ
const torusMesh = new THREE.Mesh(torusGeo, torusMat);
bonusRing.group.add(torusMesh);

// Biểu tượng Quả Táo đỏ lơ lửng ngay giữa tâm Cổng Ring để báo hiệu +2 Táo
const appleBody = new THREE.Mesh(
  new THREE.DodecahedronGeometry(1.35, 0),
  createLambertMat(0xef4444)
);
const appleLeaf = new THREE.Mesh(
  new THREE.BoxGeometry(0.45, 0.7, 0.25),
  createLambertMat(0x22c55e)
);
appleLeaf.position.set(0.15, 1.4, 0);
appleLeaf.rotation.z = -0.35;
bonusRing.appleEmblem.add(appleBody, appleLeaf);
bonusRing.group.add(bonusRing.appleEmblem);
scene.add(bonusRing.group);

// Hàm sinh Cổng Bắt Buộc tiếp theo + Cổng Ring Bonus nằm trên chặng bay
function spawnNextStage(originX, originZ, baseHeading) {
  // Đảm bảo cổng mới luôn nằm gọn trong bán kính đảo an toàn (< 195 đơn vị)
  let nextHeading = baseHeading + (Math.random() - 0.5) * 1.1;
  const distToMandatory = 68 + Math.random() * 14;

  let nextGateX = originX + Math.sin(nextHeading) * distToMandatory;
  let nextGateZ = originZ - Math.cos(nextHeading) * distToMandatory;

  // Nếu vị trí dự kiến gần rìa đảo, bẻ góc hướng về tâm đảo
  if (Math.hypot(nextGateX, nextGateZ) > ISLAND_RADIUS - 55) {
    const angleToCenter = Math.atan2(-originX, originZ);
    nextHeading = angleToCenter + (Math.random() - 0.5) * 0.6;
    nextGateX = originX + Math.sin(nextHeading) * distToMandatory;
    nextGateZ = originZ - Math.cos(nextHeading) * distToMandatory;
  }

  courseAnchorHeading = nextHeading;
  const nextGateY = 14 + Math.random() * 22;

  mandatoryGate.group.position.set(nextGateX, nextGateY, nextGateZ);
  // Xoay mặt phẳng chữ nhật vuông góc với hướng bay tới
  mandatoryGate.group.rotation.y = -nextHeading;
  mandatoryGate.pillar.position.set(nextGateX, 90, nextGateZ);

  // Đặt Cổng Ring Bonus ở khoảng giữa chặng (45% - 55% quãng đường), lệch nhẹ trái/phải và độ cao
  const ringDist = distToMandatory * 0.5;
  const sideOffset = (Math.random() < 0.5 ? -1 : 1) * (5.5 + Math.random() * 5.0);
  const perpX = Math.cos(nextHeading);
  const perpZ = Math.sin(nextHeading);

  const ringX = originX + Math.sin(nextHeading) * ringDist + perpX * sideOffset;
  const ringZ = originZ - Math.cos(nextHeading) * ringDist + perpZ * sideOffset;
  const ringY = THREE.MathUtils.clamp(nextGateY + (Math.random() - 0.5) * 14, 10, 42);

  bonusRing.group.position.set(ringX, ringY, ringZ);
  bonusRing.group.rotation.y = -nextHeading;
  bonusRing.active = true;
  bonusRing.group.visible = true;
}

// ============================================================================
// 7. TẠO NHÂN VẬT CHIM 3D (THU GỌN SCALE 0.72 CHO CẢM GIÁC CỔNG RỘNG ~2M)
// ============================================================================
const birdWorldGroup = new THREE.Group();
const birdVisualGroup = new THREE.Group();
birdVisualGroup.scale.set(0.72, 0.72, 0.72);
birdWorldGroup.add(birdVisualGroup);
scene.add(birdWorldGroup);

const bodyMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.8, 1.3, 3.2),
  createLambertMat(0xf59e0b)
);
birdVisualGroup.add(bodyMesh);

const breastMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 0.9, 1.8),
  createLambertMat(0xef4444)
);
breastMesh.position.set(0, -0.25, -0.9);
birdVisualGroup.add(breastMesh);

const headMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.4, 1.3, 1.5),
  createLambertMat(0x0284c7)
);
headMesh.position.set(0, 0.85, -1.6);
birdVisualGroup.add(headMesh);

const beakGeo = new THREE.ConeGeometry(0.45, 1.4, 4);
beakGeo.rotateX(-Math.PI / 2);
const beakMesh = new THREE.Mesh(beakGeo, createLambertMat(0xfde047));
beakMesh.position.set(0, 0.75, -2.9);
birdVisualGroup.add(beakMesh);

const tailMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 0.3, 1.8),
  createLambertMat(0xa855f7)
);
tailMesh.position.set(0, 0.2, 2.2);
tailMesh.rotation.x = 0.25;
birdVisualGroup.add(tailMesh);

const leftWingPivot = new THREE.Group();
leftWingPivot.position.set(-0.9, 0.3, -0.2);
const rightWingPivot = new THREE.Group();
rightWingPivot.position.set(0.9, 0.3, -0.2);

const wingMainGeo = new THREE.BoxGeometry(3.8, 0.22, 1.7);
const wingTipGeo = new THREE.BoxGeometry(1.6, 0.18, 1.3);
const wingMainMat = createLambertMat(0x10b981);
const wingTipMat = createLambertMat(0x38bdf8);

const leftWingMain = new THREE.Mesh(wingMainGeo, wingMainMat);
leftWingMain.position.set(-1.9, 0, 0);
const leftWingTip = new THREE.Mesh(wingTipGeo, wingTipMat);
leftWingTip.position.set(-4.3, 0, 0.1);
leftWingPivot.add(leftWingMain, leftWingTip);

const rightWingMain = new THREE.Mesh(wingMainGeo, wingMainMat);
rightWingMain.position.set(1.9, 0, 0);
const rightWingTip = new THREE.Mesh(wingTipGeo, wingTipMat);
rightWingTip.position.set(4.3, 0, 0.1);
rightWingPivot.add(rightWingMain, rightWingTip);

birdVisualGroup.add(leftWingPivot, rightWingPivot);

let birdHeading = 0;

// Object Pool cho hạt nổ khi qua cổng
const PARTICLE_COUNT = 24;
const particles = [];
const particleGeo = new THREE.DodecahedronGeometry(0.55, 0);
const particleMatRed = createLambertMat(0xef4444);
const particleMatGold = createLambertMat(0xfde047);

for (let i = 0; i < PARTICLE_COUNT; i++) {
  const mesh = new THREE.Mesh(
    particleGeo,
    i % 2 === 0 ? particleMatRed : particleMatGold
  );
  mesh.visible = false;
  scene.add(mesh);
  particles.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0 });
}

function spawnParticleExplosion(pos) {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = particles[i];
    p.mesh.position.copy(pos);
    p.mesh.scale.set(1, 1, 1);
    p.mesh.visible = true;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    const speed = 8 + Math.random() * 16;
    p.vx = Math.sin(phi) * Math.cos(theta) * speed;
    p.vy = Math.cos(phi) * speed + 4;
    p.vz = Math.sin(phi) * Math.sin(theta) * speed;
    p.life = 0.55;
  }
}

function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = particles[i];
    if (p.life > 0) {
      p.life -= dt;
      p.vy -= 22 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const s = Math.max(0.01, p.life * 1.8);
      p.mesh.scale.set(s, s, s);
      if (p.life <= 0) p.mesh.visible = false;
    }
  }
}

// ============================================================================
// 8. KHỞI TẠO MEDIAPIPE POSE LANDMARKER (LITE + GPU + 320x240)
// ============================================================================
let poseLandmarker = null;

async function initMediaPipeAndCamera() {
  try {
    btnStart.disabled = true;
    loadingStatus.textContent = 'Đang tải MediaPipe PoseLandmarker Lite (GPU)...';

    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numPoses: 1
    });

    loadingStatus.textContent = 'Đang mở luồng Webcam 320x240...';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } },
      audio: false
    });

    videoEl.srcObject = stream;
    await new Promise((resolve) => {
      videoEl.onloadedmetadata = () => {
        videoEl.play();
        resolve();
      };
    });

    startModal.style.display = 'none';
    resetAndStartGame();
  } catch (err) {
    console.error(err);
    btnStart.disabled = false;
    loadingStatus.textContent = 'Lỗi Camera/GPU: ' + err.message;
  }
}

// ============================================================================
// 9. VẼ KHUNG XƯƠNG 6 KHỚP & MÁY TRẠNG THÁI VẬT LÝ 3 CHẾ ĐỘ (20 FPS)
// ============================================================================
function drawUpperBodySkeleton(landmarks) {
  poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
  if (!landmarks) return;

  const w = poseCanvas.width;
  const h = poseCanvas.height;
  const connections = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];

  poseCtx.strokeStyle = '#00bfff';
  poseCtx.lineWidth = 4;
  poseCtx.lineCap = 'round';
  for (const [a, b] of connections) {
    const ptA = landmarks[a];
    const ptB = landmarks[b];
    if (ptA && ptB) {
      poseCtx.beginPath();
      poseCtx.moveTo(ptA.x * w, ptA.y * h);
      poseCtx.lineTo(ptB.x * w, ptB.y * h);
      poseCtx.stroke();
    }
  }

  const jointIndices = [11, 12, 13, 14, 15, 16];
  poseCtx.fillStyle = '#ffd700';
  poseCtx.strokeStyle = '#1e293b';
  poseCtx.lineWidth = 2;
  for (const idx of jointIndices) {
    const pt = landmarks[idx];
    if (pt) {
      poseCtx.beginPath();
      poseCtx.arc(pt.x * w, pt.y * h, 6, 0, Math.PI * 2);
      poseCtx.fill();
      poseCtx.stroke();
    }
  }
}

function processPoseControl(landmarks, nowMs, dtMs) {
  if (!landmarks) return;

  const lShoulder = landmarks[11];
  const rShoulder = landmarks[12];
  const lWrist = landmarks[15];
  const rWrist = landmarks[16];
  if (!lShoulder || !rShoulder || !lWrist || !rWrist) return;

  const shoulderY = (lShoulder.y + rShoulder.y) * 0.5;
  const wristY = (lWrist.y + rWrist.y) * 0.5;

  if (isGameOver) {
    if (lWrist.y < shoulderY - 0.15 && rWrist.y < shoulderY - 0.15) {
      handsUpRestartAccumMs += dtMs;
      const pct = Math.min(100, (handsUpRestartAccumMs / 2000) * 100);
      handsUpProgressBar.style.width = `${pct}%`;
      if (handsUpRestartAccumMs >= 2000) {
        handsUpRestartAccumMs = 0;
        handsUpProgressBar.style.width = '0%';
        resetAndStartGame();
      }
    } else {
      handsUpRestartAccumMs = Math.max(0, handsUpRestartAccumMs - dtMs * 1.5);
      handsUpProgressBar.style.width = `${(handsUpRestartAccumMs / 2000) * 100}%`;
    }
    prevWristY = wristY;
    return;
  }

  // Góc nghiêng hai cổ tay trong không gian đã lật gương
  const leftScreenX = 1.0 - lWrist.x;
  const rightScreenX = 1.0 - rWrist.x;
  const dx = Math.max(0.08, Math.abs(rightScreenX - leftScreenX));
  const dy = rWrist.y - lWrist.y;
  const tiltAngle = Math.atan2(dy, dx);
  targetRoll = THREE.MathUtils.clamp(tiltAngle * 1.3, -0.82, 0.82);

  const deltaWristY = prevWristY !== null ? wristY - prevWristY : 0;
  prevWristY = wristY;

  if (wristY < shoulderY + 0.08) {
    lastUpperZoneTime = nowMs;
  }

  const startedFromUpperZone = (nowMs - lastUpperZoneTime) <= 240;
  const canFlapCooldown = (nowMs - lastFlapTime) >= FLAP_COOLDOWN_MS;

  // TRẠNG THÁI 2: VẪY CÁNH (FLAP)
  if (startedFromUpperZone && deltaWristY > FLAP_VELOCITY_THRESHOLD && canFlapCooldown) {
    lastFlapTime = nowMs;
    flapStateHoldUntil = nowMs + 280;
    lowWristAccumMs = 0;

    currentFlightState = STATE.FLAP;
    targetVy = FLAP_UPWARD_IMPULSE;
    smoothVy = FLAP_UPWARD_IMPULSE;
    targetPitch = 0.28;
    targetSpeed = 26;
    updateStateUI(STATE.FLAP);
    return;
  }

  if (nowMs < flapStateHoldUntil) {
    currentFlightState = STATE.FLAP;
    return;
  }

  // TRẠNG THÁI 3: HẠ TAY RƠI NHANH (FREEFALL / DIVE)
  if (wristY > shoulderY + 0.15) {
    lowWristAccumMs += dtMs;
    if (lowWristAccumMs > DIVE_HOLD_THRESHOLD_MS) {
      currentFlightState = STATE.DIVE;
      targetVy = DIVE_SINK_RATE;
      targetPitch = DIVE_PITCH_RAD;
      targetSpeed = 31;
      targetRoll *= 0.45;
      updateStateUI(STATE.DIVE);
      return;
    }
  } else {
    lowWristAccumMs = 0;
  }

  // TRẠNG THÁI 1: LƯỢN (GLIDE)
  if (wristY <= shoulderY + 0.12 || currentFlightState !== STATE.DIVE) {
    currentFlightState = STATE.GLIDE;
    targetVy = GLIDE_SINK_RATE;
    targetPitch = 0.0;
    targetSpeed = 23;
    updateStateUI(STATE.GLIDE);
  }
}

function updateStateUI(state) {
  stateBadgeEl.className = '';
  if (state === STATE.GLIDE) {
    stateBadgeEl.classList.add('state-glide');
    stateBadgeEl.textContent = '[ĐANG LƯỢN - GLIDE]';
    diveWarningBanner.style.display = 'none';
  } else if (state === STATE.FLAP) {
    stateBadgeEl.classList.add('state-flap');
    stateBadgeEl.textContent = '[VẪY CÁNH - FLAP]';
    diveWarningBanner.style.display = 'none';
  } else if (state === STATE.DIVE) {
    stateBadgeEl.classList.add('state-dive');
    stateBadgeEl.textContent = '[HẠ TAY RƠI NHANH - DIVE!]';
    diveWarningBanner.style.display = 'block';
  }
}

// ============================================================================
// 10. QUẢN LÝ TRẠNG THÁI GAME
// ============================================================================
function resetAndStartGame() {
  score = 0;
  currentGateNumber = 1;
  scoreTextEl.textContent = `🍎 Điểm: ${score}`;
  gateProgressTextEl.textContent = `⛩️ Cổng bắt buộc: #${currentGateNumber}`;
  isGameOver = false;
  isGameRunning = true;
  gameoverModal.style.display = 'none';
  diveWarningBanner.style.display = 'none';

  birdWorldGroup.position.set(0, 25, 0);
  birdHeading = 0;

  targetRoll = 0;
  smoothRoll = 0;
  targetPitch = 0;
  smoothPitch = 0;
  targetVy = GLIDE_SINK_RATE;
  smoothVy = GLIDE_SINK_RATE;
  targetSpeed = 23;
  smoothSpeed = 23;
  lowWristAccumMs = 0;

  currentFlightState = STATE.GLIDE;
  updateStateUI(STATE.GLIDE);

  // Sinh Cổng Bắt Buộc #1 thẳng phía trước mặt chim và 1 Cổng Ring Bonus
  spawnNextStage(0, 0, 0);
}

function triggerGameOver() {
  isGameRunning = false;
  isGameOver = true;
  diveWarningBanner.style.display = 'none';

  if (score > highScore) {
    highScore = score;
    try {
      localStorage.setItem('pose_slalom_high_score', String(highScore));
    } catch (e) {}
    bestTextEl.textContent = `🏆 Kỷ lục: ${highScore}`;
  }

  finalScoreMsg.textContent = `Tổng điểm: ${score} 🍎 (Qua ${currentGateNumber - 1} cổng chính) | Kỷ lục: ${highScore} 🍎`;
  gameoverModal.style.display = 'flex';
}

btnStart.addEventListener('click', initMediaPipeAndCamera);
btnRestart.addEventListener('click', resetAndStartGame);

// ============================================================================
// 11. VÒNG LẶP GAME 60 FPS + XÉT VA CHẠM MẶT PHẲNG CHỮ NHẬT (LOCAL SPACE)
// ============================================================================
let lastFrameTime = performance.now();
const cameraOffset = new THREE.Vector3();
const cameraLookTarget = new THREE.Vector3();
const tempLocalPos = new THREE.Vector3(); // Vector cấp phát tĩnh để tránh Garbage Collector

function animate(nowMs) {
  requestAnimationFrame(animate);

  const dt = Math.min(0.05, (nowMs - lastFrameTime) / 1000);
  lastFrameTime = nowMs;

  if (poseLandmarker && videoEl.readyState >= 2 && nowMs - lastMpTimestamp >= MP_INTERVAL_MS) {
    const mpDt = nowMs - lastMpTimestamp;
    lastMpTimestamp = nowMs;
    const result = poseLandmarker.detectForVideo(videoEl, nowMs);
    const lm = result.landmarks && result.landmarks.length > 0 ? result.landmarks[0] : null;
    drawUpperBodySkeleton(lm);
    processPoseControl(lm, nowMs, mpDt);
  }

  if (isGameRunning && !isGameOver) {
    if (currentFlightState === STATE.FLAP && nowMs >= flapStateHoldUntil) {
      currentFlightState = STATE.GLIDE;
      targetVy = GLIDE_SINK_RATE;
      targetPitch = 0;
      targetSpeed = 23;
      updateStateUI(STATE.GLIDE);
    }

    smoothRoll = THREE.MathUtils.lerp(smoothRoll, targetRoll, LERP_FACTOR);
    smoothPitch = THREE.MathUtils.lerp(smoothPitch, targetPitch, LERP_FACTOR);
    smoothVy = THREE.MathUtils.lerp(smoothVy, targetVy, LERP_FACTOR);
    smoothSpeed = THREE.MathUtils.lerp(smoothSpeed, targetSpeed, LERP_FACTOR);

    birdHeading += smoothRoll * 1.65 * dt;

    const forwardX = Math.sin(birdHeading);
    const forwardZ = -Math.cos(birdHeading);

    birdWorldGroup.position.x += forwardX * smoothSpeed * dt;
    birdWorldGroup.position.z += forwardZ * smoothSpeed * dt;
    birdWorldGroup.position.y += smoothVy * dt;

    if (birdWorldGroup.position.y > MAX_ALTITUDE) {
      birdWorldGroup.position.y = MAX_ALTITUDE;
      if (smoothVy > 0) smoothVy = 0;
    }

    // Giới hạn biên đảo (Bán kính 250)
    const distFromCenter = Math.hypot(birdWorldGroup.position.x, birdWorldGroup.position.z);
    if (distFromCenter > ISLAND_RADIUS) {
      const angleToCenter = Math.atan2(-birdWorldGroup.position.x, birdWorldGroup.position.z);
      let angleDiff = angleToCenter - birdHeading;
      angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
      birdHeading += angleDiff * 4.0 * dt;
    }

    if (birdWorldGroup.position.y <= GROUND_CRASH_Y) {
      birdWorldGroup.position.y = GROUND_CRASH_Y;
      triggerGameOver();
    }

    birdWorldGroup.rotation.y = -birdHeading;
    birdVisualGroup.rotation.z = -smoothRoll;
    birdVisualGroup.rotation.x = smoothPitch;

    // Hoạt ảnh cánh chim
    if (currentFlightState === STATE.FLAP) {
      const flapWave = Math.sin(nowMs * 0.038) * 0.85;
      leftWingPivot.rotation.z = flapWave;
      rightWingPivot.rotation.z = -flapWave;
      leftWingPivot.rotation.y = 0;
      rightWingPivot.rotation.y = 0;
    } else if (currentFlightState === STATE.DIVE) {
      leftWingPivot.rotation.z = THREE.MathUtils.lerp(leftWingPivot.rotation.z, 1.25, 0.2);
      rightWingPivot.rotation.z = THREE.MathUtils.lerp(rightWingPivot.rotation.z, -1.25, 0.2);
      leftWingPivot.rotation.y = THREE.MathUtils.lerp(leftWingPivot.rotation.y, 0.55, 0.2);
      rightWingPivot.rotation.y = THREE.MathUtils.lerp(rightWingPivot.rotation.y, -0.55, 0.2);
    } else {
      const gentleBob = Math.sin(nowMs * 0.005) * 0.05;
      leftWingPivot.rotation.z = THREE.MathUtils.lerp(leftWingPivot.rotation.z, gentleBob, 0.2);
      rightWingPivot.rotation.z = THREE.MathUtils.lerp(rightWingPivot.rotation.z, -gentleBob, 0.2);
      leftWingPivot.rotation.y = THREE.MathUtils.lerp(leftWingPivot.rotation.y, 0, 0.2);
      rightWingPivot.rotation.y = THREE.MathUtils.lerp(rightWingPivot.rotation.y, 0, 0.2);
    }

    // ------------------------------------------------------------------------
    // A. KIỂM TRA QUA CỔNG RING BONUS (TÙY CHỌN -> +2 🍎)
    // ------------------------------------------------------------------------
    if (bonusRing.active) {
      bonusRing.appleEmblem.rotation.y += 2.4 * dt;
      tempLocalPos.copy(birdWorldGroup.position);
      bonusRing.group.worldToLocal(tempLocalPos);

      const radialDist = Math.hypot(tempLocalPos.x, tempLocalPos.y);
      if (radialDist <= BONUS_RING_RADIUS + 1.1 && Math.abs(tempLocalPos.z) <= 2.4) {
        bonusRing.active = false;
        bonusRing.group.visible = false;
        score += 2;
        scoreTextEl.textContent = `🍎 Điểm: ${score}`;
        spawnParticleExplosion(bonusRing.group.position);
        showScorePopup('🍎 +2 ĐIỂM BONUS RING!', 'rgba(234, 179, 8, 0.92)');
      }
    }

    // ------------------------------------------------------------------------
    // B. KIỂM TRA QUA CỔNG CHỮ NHẬT 2 THANH (BẮT BUỘC -> +1 🍎 & MỞ CỔNG MỚI)
    // ------------------------------------------------------------------------
    tempLocalPos.copy(birdWorldGroup.position);
    mandatoryGate.group.worldToLocal(tempLocalPos);

    if (
      Math.abs(tempLocalPos.x) <= RECT_HALF_W + 0.9 &&
      Math.abs(tempLocalPos.y) <= RECT_HALF_H + 0.9 &&
      Math.abs(tempLocalPos.z) <= 2.4
    ) {
      score += 1;
      currentGateNumber += 1;
      scoreTextEl.textContent = `🍎 Điểm: ${score}`;
      gateProgressTextEl.textContent = `⛩️ Cổng bắt buộc: #${currentGateNumber}`;

      const clearedPos = mandatoryGate.group.position.clone();
      spawnParticleExplosion(clearedPos);
      showScorePopup(`⛩️ QUA CỔNG #${currentGateNumber - 1} (+1 🍎)`, 'rgba(2, 132, 199, 0.92)');

      // Lập tức sinh cổng bắt buộc tiếp theo + cổng Ring bonus mới
      spawnNextStage(clearedPos.x, clearedPos.z, birdHeading);
    }

    // Cập nhật La bàn chỉ hướng tới Cổng Chữ Nhật bắt buộc hiện tại
    const gx = mandatoryGate.group.position.x - birdWorldGroup.position.x;
    const gz = mandatoryGate.group.position.z - birdWorldGroup.position.z;
    const angleToGate = Math.atan2(gx, -gz);
    const relAngle = angleToGate - birdHeading;
    compassArrowEl.style.transform = `rotate(${relAngle}rad)`;

    const distToGate = Math.round(Math.hypot(gx, gz));
    compassDistEl.textContent = `Cổng #${currentGateNumber}: ${distToGate}m`;

    // Thanh đo độ cao
    const currentAlt = birdWorldGroup.position.y;
    altValueEl.textContent = `${currentAlt.toFixed(1)}m`;
    const altPercent = THREE.MathUtils.clamp(
      ((currentAlt - GROUND_CRASH_Y) / (MAX_ALTITUDE - GROUND_CRASH_Y)) * 100,
      0,
      100
    );
    altBarFillEl.style.height = `${altPercent}%`;

    if (currentAlt < 8.5) {
      altBarFillEl.classList.add('alt-danger-blink');
      altValueEl.style.color = '#ef4444';
    } else {
      altBarFillEl.classList.remove('alt-danger-blink');
      altBarFillEl.style.backgroundColor = currentAlt > 22 ? '#22c55e' : '#38bdf8';
      altValueEl.style.color = '#38bdf8';
    }
  }

  updateParticles(dt);

  // Camera bám đuôi góc nhìn thứ 3
  const camBackDist = 14.0;
  const camUpHeight = 4.8;
  cameraOffset.set(
    birdWorldGroup.position.x - Math.sin(birdHeading) * camBackDist,
    birdWorldGroup.position.y + camUpHeight,
    birdWorldGroup.position.z + Math.cos(birdHeading) * camBackDist
  );
  camera.position.lerp(cameraOffset, 0.18);

  cameraLookTarget.set(
    birdWorldGroup.position.x + Math.sin(birdHeading) * 10,
    birdWorldGroup.position.y + 0.8,
    birdWorldGroup.position.z - Math.cos(birdHeading) * 10
  );
  camera.lookAt(cameraLookTarget);

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

requestAnimationFrame(animate);