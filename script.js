/* ============================================================
   Connection / status elements
   ============================================================ */
const connectBtn = document.getElementById('connectBtn');
const wsAddrInput = document.getElementById('wsAddr');
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const txtStatus = document.getElementById('txtStatus');

const gimbal = document.getElementById('gimbal');
const plate = document.getElementById('plate');
const tabUpper = document.getElementById('tabUpper');
const tabLower = document.getElementById('tabLower');
const rollVal = document.getElementById('rollVal');
const pitchVal = document.getElementById('pitchVal');
const yawVal = document.getElementById('yawVal');
const elbowVal = document.getElementById('elbowVal');
const stepCountEl = document.getElementById('stepCount');
const cadenceEl = document.getElementById('cadence');
const sampleRateEl = document.getElementById('sampleRate');
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');

let polling = false;
let pollTimer = null;
let activeSeg = 'upper';

/* global pause (sidebar "Pause All Display") */
let isGlobalPaused = false;
/* per-panel pause for the 2D limb view only */
let isLimb2dPaused = false;

/* offsets used only for the 2D stick-figure view ("Reset All Offsets") */
let offset2dU = 0;
let offset2dElbow = 0;

// history buffers for the gait chart
const HISTORY = 300;
let histUpperRoll = new Array(HISTORY).fill(0);
let histLowerRoll = new Array(HISTORY).fill(0);
let histElbow = new Array(HISTORY).fill(0);

// latest full sample, kept so tab-switching / resets can redraw instantly
let latest = { uRoll:0, uPitch:0, uYaw:0, lRoll:0, lPitch:0, lYaw:0, elbow:0 };

// step / swing detection (peak detection on upper-arm roll)
let stepCount = 0;
let risingEdge = false;
const PEAK_THRESHOLD = 8; // degrees, adjust to sensitivity needed
let swingTimestamps = [];

// sample-rate tracking
let sampleTimes = [];

function resizeCanvas(){
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * ratio;
  canvas.height = h * ratio;
  ctx.setTransform(ratio,0,0,ratio,0,0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function drawChart(){
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0,0,w,h);

  ctx.strokeStyle = '#dceaf3';
  ctx.lineWidth = 1;
  for(let i=0;i<=4;i++){
    const y = (h/4)*i;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
  }

  const range = 90; // +/- degrees mapped to chart height
  const mid = h/2;

  function plot(arr, color){
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    arr.forEach((v,i)=>{
      const x = (i/(HISTORY-1))*w;
      const y = mid - (v/range)*mid;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  }
  plot(histUpperRoll, '#0284c7');
  plot(histLowerRoll, '#0f9e8e');
  plot(histElbow, '#c8930a');
}

function pushHistory(uRoll, lRoll, elbow){
  histUpperRoll.push(uRoll); histUpperRoll.shift();
  histLowerRoll.push(lRoll); histLowerRoll.shift();
  histElbow.push(elbow); histElbow.shift();
}

function detectSwing(roll){
  if(roll > PEAK_THRESHOLD && !risingEdge){
    risingEdge = true;
  } else if(roll < PEAK_THRESHOLD * 0.4 && risingEdge){
    risingEdge = false;
    stepCount++;
    const now = performance.now();
    swingTimestamps.push(now);
    swingTimestamps = swingTimestamps.filter(t => now - t < 15000); // last 15s window
    stepCountEl.textContent = stepCount;
    const cadence = Math.round((swingTimestamps.length / 15) * 60);
    cadenceEl.textContent = cadence;
  }
}

function updateSampleRate(){
  const now = performance.now();
  sampleTimes.push(now);
  sampleTimes = sampleTimes.filter(t => now - t < 2000);
  const hz = (sampleTimes.length / 2).toFixed(0);
  sampleRateEl.textContent = hz + ' Hz';
}

function updateSegmentDisplay(){
  const seg = activeSeg === 'upper'
    ? { roll: latest.uRoll, pitch: latest.uPitch, yaw: latest.uYaw }
    : { roll: latest.lRoll, pitch: latest.lPitch, yaw: latest.lYaw };

  rollVal.textContent = seg.roll.toFixed(1) + '°';
  pitchVal.textContent = seg.pitch.toFixed(1) + '°';
  yawVal.textContent = seg.yaw.toFixed(1) + '°';

  gimbal.style.transform = `rotateX(${seg.pitch}deg) rotateY(${seg.yaw}deg) rotateZ(${seg.roll}deg)`;
  plate.className = 'plate ' + activeSeg;
}

tabUpper.addEventListener('click', () => {
  activeSeg = 'upper';
  tabUpper.classList.add('active'); tabLower.classList.remove('active');
  updateSegmentDisplay();
});
tabLower.addEventListener('click', () => {
  activeSeg = 'lower';
  tabLower.classList.add('active'); tabUpper.classList.remove('active');
  updateSegmentDisplay();
});

/* ============================================================
   2D stick-figure limb view (upper arm + forearm)
   ============================================================ */
const canvasLimb = document.getElementById('canvas-limb');
const ctxLimb = canvasLimb.getContext('2d');
const txtLimbU = document.getElementById('txt-limb-u');
const txtLimbL = document.getElementById('txt-limb-l');
const ledLimb = document.getElementById('led-limb');
const btnResetLimb2d = document.getElementById('btnResetLimb2d');
const btnPauseLimb2d = document.getElementById('btnPauseLimb2d');

function normalizeAngle(angle){
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  return angle;
}

function drawLimb2d(){
  ctxLimb.clearRect(0, 0, canvasLimb.width, canvasLimb.height);

  const angleU = normalizeAngle(latest.uPitch - offset2dU);
  const angleL = normalizeAngle(latest.elbow - offset2dElbow);

  const pivotX = canvasLimb.width / 2;
  const pivotY = 40;
  const upperLen = 65;
  const lowerLen = 60;

  const radU = (angleU + 90) * (Math.PI / 180);
  const jointX = pivotX + upperLen * Math.cos(radU);
  const jointY = pivotY + upperLen * Math.sin(radU);

  const radL = (angleU + angleL + 90) * (Math.PI / 180);
  const endX = jointX + lowerLen * Math.cos(radL);
  const endY = jointY + lowerLen * Math.sin(radL);

  ctxLimb.fillStyle = '#94a9b8';
  ctxLimb.beginPath();
  ctxLimb.arc(pivotX, pivotY, 8, 0, Math.PI * 2);
  ctxLimb.fill();

  ctxLimb.strokeStyle = '#0284c7';
  ctxLimb.lineWidth = 10;
  ctxLimb.lineCap = 'round';
  ctxLimb.beginPath();
  ctxLimb.moveTo(pivotX, pivotY);
  ctxLimb.lineTo(jointX, jointY);
  ctxLimb.stroke();

  ctxLimb.fillStyle = '#b8c9d6';
  ctxLimb.beginPath();
  ctxLimb.arc(jointX, jointY, 6, 0, Math.PI * 2);
  ctxLimb.fill();

  ctxLimb.strokeStyle = '#0f9e8e';
  ctxLimb.lineWidth = 8;
  ctxLimb.beginPath();
  ctxLimb.moveTo(jointX, jointY);
  ctxLimb.lineTo(endX, endY);
  ctxLimb.stroke();

  ctxLimb.fillStyle = '#0f9e8e';
  ctxLimb.beginPath();
  ctxLimb.arc(endX, endY, 5, 0, Math.PI * 2);
  ctxLimb.fill();

  txtLimbU.textContent = `${angleU.toFixed(1)}°`;
  txtLimbL.textContent = `${angleL.toFixed(1)}°`;
}

function updateLimb2dPauseUI(){
  if (isLimb2dPaused || isGlobalPaused) {
    btnPauseLimb2d.classList.add('active');
    btnPauseLimb2d.textContent = ' Resume';
    ledLimb.classList.add('led-paused');
  } else {
    btnPauseLimb2d.classList.remove('active');
    btnPauseLimb2d.textContent = ' Pause';
    ledLimb.classList.remove('led-paused');
  }
}

btnResetLimb2d.addEventListener('click', () => {
  offset2dU = latest.uPitch;
  offset2dElbow = latest.elbow;
  drawLimb2d();
});

btnPauseLimb2d.addEventListener('click', () => {
  isLimb2dPaused = !isLimb2dPaused;
  updateLimb2dPauseUI();
});

/* ============================================================
   Sidebar: Reset All Offsets / Pause All Display
   ============================================================ */
document.getElementById('btnResetAll').addEventListener('click', () => {
  offset2dU = latest.uPitch;
  offset2dElbow = latest.elbow;
  drawLimb2d();
});

document.getElementById('btnPauseAll').addEventListener('click', () => {
  isGlobalPaused = !isGlobalPaused;
  const btn = document.getElementById('btnPauseAll');
  btn.classList.toggle('active', isGlobalPaused);
  btn.textContent = isGlobalPaused ? 'Resume All Display' : ' Pause All Display';

  txtStatus.textContent = isGlobalPaused ? 'PAUSED' : 'RUNNING';
  txtStatus.className = isGlobalPaused ? 'badge badge-pause' : 'badge badge-run';

  updateLimb2dPauseUI();
});

/* ============================================================
   Sample handling / HTTP polling (unchanged transport)
   ============================================================ */
function handleSample(data){
  latest = data;

  if (isGlobalPaused) return;

  elbowVal.textContent = data.elbow.toFixed(1) + '°';
  updateSegmentDisplay();
  pushHistory(data.uRoll, data.lRoll, data.elbow);
  detectSwing(data.uRoll);
  updateSampleRate();
  drawChart();

  if (!isLimb2dPaused) drawLimb2d();
}

const POLL_INTERVAL_MS = 40; // ~25 requests/sec

async function pollOnce(addr){
  try{
    const res = await fetch(addr, { cache: 'no-store' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(['uRoll','uPitch','uYaw','lRoll','lPitch','lYaw','elbow'].every(k => k in data)){
      if(!dot.classList.contains('on')){
        dot.classList.add('on');
        statusText.textContent = 'connected';
        statusText.className = 'badge badge-on';
      }
      handleSample(data);
    }
  }catch(err){
    dot.classList.remove('on');
    statusText.textContent = 'retrying...';
    statusText.className = 'badge badge-off';
  }
}

function startPolling(){
  const addr = wsAddrInput.value.trim();
  if(!addr){ alert('ESP32-এর ঠিকানা দিন (যেমন http://192.168.4.1/data)'); return; }

  polling = true;
  connectBtn.textContent = 'Disconnect';
  wsAddrInput.disabled = true;
  statusText.textContent = 'connecting...';
  statusText.className = 'badge badge-off';

  const tick = async () => {
    if(!polling) return;
    await pollOnce(addr);
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}

function stopPolling(){
  polling = false;
  if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; }
  dot.classList.remove('on');
  statusText.textContent = 'disconnected';
  statusText.className = 'badge badge-off';
  connectBtn.textContent = 'Connect';
  wsAddrInput.disabled = false;
}

connectBtn.addEventListener('click', () => {
  if(polling){ stopPolling(); } else { startPolling(); }
});

drawChart();
drawLimb2d();
