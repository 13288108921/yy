'use strict';

/* ============================================================
 * 可调参数与文案（改这里即可）
 * ============================================================ */
const CONFIG = {
  hintText: '触碰时光，唤醒大唐的下午',
  finaleText: '这幅承载着大唐气象的珍宝，正静静陈列于辽宁省博物馆的展柜中，向世人诉说着盛唐的繁华与诗意。',

  particleStep: 4,        // 像素采样步长（越小粒子越多越细腻）
  maxParticles: 140000,   // 粒子数量上限（超出会按比例抽稀）
  bgThreshold: 34,        // 背景剔除阈值（0-255，越小剔除越狠；0=不剔除）

  progressSpeed: 2.2,     // 仕女聚合/散开速度
  swaySpeed: 4.0,         // 裙摆摆动启停速度
  assembleDuration: 2.8,  // 全图拼合时长（秒）
  zoomDuration: 2.4,      // 长卷前的推近时长（秒）
  panDuration: 10.0,      // 长卷横移时长（秒）
  panHeightFrac: 0.80,    // 长卷阶段画作高度占屏幕比例
  revealHeightFrac: 0.92, // 交互阶段画作高度占屏幕比例（宽度优先时会缩小）
};

/* 六位仕女：rect 为在画作中的横向归一化区间 [x0, x1] */
const LADIES = [
  { rect: [0.050, 0.190], name: '拈花仕女',
    desc: '她拈一枝繁花，低眉顾盼，丰腴雍容，正是周昉笔下"丰厚为体"的盛唐气象。' },
  { rect: [0.195, 0.315], name: '红衣女童',
    desc: '画中年纪最小的女孩，身着红衫，手捧锦盒，为这闲适的午后添了一分灵动。' },
  { rect: [0.400, 0.565], name: '簪花仕女',
    desc: '头戴硕大牡丹，手执红花，立于长卷正中。她是全卷的视觉中心，仪态万方。' },
  { rect: [0.550, 0.690], name: '执扇仕女',
    desc: '轻执团扇，扇掩芳容，眼波流转之间，是盛唐吹来最温柔的一缕风。' },
  { rect: [0.700, 0.840], name: '素衣仕女',
    desc: '白纱罗裙，广袖当风，素雅的衣纹与丰润的体态相映，静美如画。' },
  { rect: [0.860, 1.000], name: '戏犬仕女',
    desc: '红衣紫裳，曳地及膝。她手持长杆与小狗相戏，华贵之中尽是闲情。' },
];

/* ============================================================
 * 基础状态
 * ============================================================ */
const PHASE = { REVEAL: 0, ASSEMBLE: 1, PAN: 2, END: 3 };
let phase = PHASE.REVEAL;

let activeRegion = -1;   // 当前聚合的仕女
let hoverRegion = -1;    // 当前悬停（裙摆摆动）的仕女
let sway = 0, swayTarget = 0;
let uAll = 0, uFade = 1;
let assembleT = 0, panT = 0;
let timeScale = 1;
const visited = new Array(6).fill(false);
const prog = [0, 0, 0, 0, 0, 0];

let ASPECT = 2684 / 692; // 画作宽高比，图片加载后更新
let s1 = 1;              // 交互阶段缩放
let camAspect = 1;

const W = () => window.innerWidth;
const H = () => window.innerHeight;

const canvas = document.getElementById('scene');
const hotspotsEl = document.getElementById('hotspots');
const tooltipEl = document.getElementById('tooltip');
const hintEl = document.getElementById('hint');
const finaleEl = document.getElementById('finale');
const finaleTextEl = document.getElementById('finale-text');

hintEl.textContent = CONFIG.hintText;
finaleTextEl.textContent = CONFIG.finaleText;

/* ============================================================
 * Three.js 场景
 * ============================================================ */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 5;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const group = new THREE.Group();
scene.add(group);

function makeSpriteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const material = new THREE.ShaderMaterial({
  uniforms: {
    uProgress: { value: prog },
    uAll: { value: 0 },
    uHoverRegion: { value: -1 },
    uSway: { value: 0 },
    uTime: { value: 0 },
    uSize: { value: 2.4 },
    uFade: { value: 1 },
    uMap: { value: makeSpriteTexture() },
  },
  vertexShader: `
    attribute vec3 aScatter;
    attribute vec3 aColor;
    attribute float aRegion;

    uniform float uProgress[6];
    uniform float uAll;
    uniform float uHoverRegion;
    uniform float uSway;
    uniform float uTime;
    uniform float uSize;
    uniform float uFade;

    varying vec3 vColor;

    void main() {
      float p = 0.0;
      if (aRegion > -0.5) {
        for (int i = 0; i < 6; i++) {
          if (int(aRegion + 0.5) == i) p = uProgress[i];
        }
      }
      float t = max(p, uAll);

      vec3 pos = mix(aScatter, position, t);

      float drift = 1.0 - t;
      pos.x += drift * 0.05 * sin(uTime * 0.35 + aScatter.y * 6.0 + aScatter.x * 2.0);
      pos.y += drift * 0.05 * cos(uTime * 0.27 + aScatter.x * 4.0);

      if (aRegion > -0.5 && abs(aRegion - uHoverRegion) < 0.5) {
        float w = clamp(-position.y * 2.4, 0.0, 1.0);
        w *= w;
        pos.x += uSway * 0.03 * w * sin(uTime * 2.4 + position.y * 30.0 + position.x * 7.0);
      }

      vColor = aColor * (0.13 + 0.87 * t) * uFade;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      gl_PointSize = uSize * (0.65 + 0.55 * t);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D uMap;
    varying vec3 vColor;

    void main() {
      vec4 tex = texture2D(uMap, gl_PointCoord);
      if (tex.a < 0.04) discard;
      gl_FragColor = vec4(vColor, tex.a);
    }
  `,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});

/* ============================================================
 * 像素采样：读画作颜色，生成粒子目标位置
 * ============================================================ */
function regionBgColor(data, w, h, rect) {
  let r = 0, g = 0, b = 0, n = 0;
  const x0 = Math.floor(rect[0] * w);
  const x1 = Math.min(w - 1, Math.ceil(rect[1] * w));
  const step = 6;
  const inset = 5;
  const acc = (x, y) => {
    const i = (y * w + x) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  };
  for (let x = x0; x < x1; x += step) { acc(x, inset); acc(x, h - 1 - inset); }
  for (let y = 0; y < h; y += step) { acc(Math.min(x1, x0 + inset), y); acc(x1 - inset, y); }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function buildParticles(img) {
  ASPECT = img.width / img.height;
  const w = img.width, h = img.height;

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);

  let data = null;
  try {
    data = cx.getImageData(0, 0, w, h).data;
  } catch (e) {
    console.warn('无法读取像素，跳过背景剔除：', e);
  }

  const step = CONFIG.particleStep;
  const th = CONFIG.bgThreshold;
  const centers = LADIES.map(l => (l.rect[0] + l.rect[1]) / 2);
  const bgs = LADIES.map(l => (data ? regionBgColor(data, w, h, l.rect) : [0, 0, 0]));

  const posA = [], colA = [], scatA = [], regA = [];
  const sw = 2 * camAspect, sh = 2;

  for (let y = 0; y < h; y += step) {
    const ny = y / h;
    for (let x = 0; x < w; x += step) {
      const nx = x / w;
      const i = (y * w + x) * 4;
      const r = data ? data[i] : 255;
      const g = data ? data[i + 1] : 255;
      const b = data ? data[i + 2] : 255;

      let ri = 0, bd = Infinity;
      for (let k = 0; k < 6; k++) {
        const d = Math.abs(nx - centers[k]);
        if (d < bd) { bd = d; ri = k; }
      }

      if (data && th > 0) {
        const bg = bgs[ri];
        const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
        if (dr * dr + dg * dg + db * db < th * th) continue;
      }

      posA.push((nx - 0.5) * ASPECT, 0.5 - ny, 0);
      colA.push(r / 255, g / 255, b / 255);
      scatA.push((Math.random() - 0.5) * (sw + 0.8), (Math.random() - 0.5) * (sh + 0.8), 0);
      regA.push(ri);
    }
  }

  let count = regA.length;
  if (count > CONFIG.maxParticles) {
    const keep = CONFIG.maxParticles / count;
    const f = [], c = [], s = [], g2 = [];
    for (let i = 0; i < count; i++) {
      if (Math.random() < keep) {
        f.push(posA[i * 3], posA[i * 3 + 1], posA[i * 3 + 2]);
        c.push(colA[i * 3], colA[i * 3 + 1], colA[i * 3 + 2]);
        s.push(scatA[i * 3], scatA[i * 3 + 1], scatA[i * 3 + 2]);
        g2.push(regA[i]);
      }
    }
    posA.length = 0; colA.length = 0; scatA.length = 0; regA.length = 0;
    posA.push(...f); colA.push(...c); scatA.push(...s); regA.push(...g2);
    count = regA.length;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colA, 3));
  geo.setAttribute('aScatter', new THREE.Float32BufferAttribute(scatA, 3));
  geo.setAttribute('aRegion', new THREE.Float32BufferAttribute(regA, 1));

  group.add(new THREE.Points(geo, material));
  console.log('粒子数量：', count);
}

/* ============================================================
 * 热区 DOM 与交互
 * ============================================================ */
const hotspotEls = LADIES.map((l, i) => {
  const d = document.createElement('div');
  d.className = 'hotspot';
  d.style.left = (l.rect[0] * 100) + '%';
  d.style.width = ((l.rect[1] - l.rect[0]) * 100) + '%';
  d.setAttribute('aria-label', LADIES[i].name);

  d.addEventListener('mouseenter', () => enterLady(i));
  d.addEventListener('mouseleave', leaveLady);
  d.addEventListener('touchstart', (e) => { e.preventDefault(); enterLady(i); }, { passive: false });

  hotspotsEl.appendChild(d);
  return d;
});

hotspotsEl.addEventListener('mouseleave', () => { activeRegion = -1; leaveLady(); });
window.addEventListener('touchstart', (e) => {
  if (phase === PHASE.REVEAL && !hotspotsEl.contains(e.target)) {
    activeRegion = -1; leaveLady();
  }
});

function enterLady(i) {
  if (phase !== PHASE.REVEAL) return;
  activeRegion = i;
  hoverRegion = i;
  swayTarget = 1;
  material.uniforms.uHoverRegion.value = i;
  showTooltip(i);
}

function leaveLady() {
  hoverRegion = -1;
  swayTarget = 0;
  material.uniforms.uHoverRegion.value = -1;
  tooltipEl.classList.remove('show');
}

function showTooltip(i) {
  const hs = hotspotEls[i];
  tooltipEl.innerHTML = '<strong>' + LADIES[i].name + '</strong>' + LADIES[i].desc;
  tooltipEl.style.visibility = 'hidden';
  tooltipEl.classList.remove('show');
  tooltipEl.style.left = '0px';
  tooltipEl.style.top = '0px';

  const tw = tooltipEl.offsetWidth;
  const hsCenterX = hotspotsEl.offsetLeft + hs.offsetLeft + hs.offsetWidth * 0.5;
  let x = hsCenterX > W() * 0.55 ? hs.offsetLeft + hotspotsEl.offsetLeft - tw - 16
                                : hsCenterX + 16;
  let y = hotspotsEl.offsetTop + hs.offsetHeight * 0.12;
  x = Math.max(10, Math.min(x, W() - tw - 10));
  y = Math.max(10, Math.min(y, H() - tooltipEl.offsetHeight - 10));
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
  tooltipEl.style.visibility = '';
  tooltipEl.classList.add('show');
}

/* ============================================================
 * 布局与自适应
 * ============================================================ */
function layout() {
  camAspect = W() / H();
  camera.left = -camAspect;
  camera.right = camAspect;
  camera.updateProjectionMatrix();
  renderer.setSize(W(), H());
  material.uniforms.uSize.value =
    Math.min(4.5, Math.max(1.6, 2.4 * (H() / 1000))) * Math.min(window.devicePixelRatio || 1, 2);

  s1 = Math.min((2 * camAspect) / ASPECT, CONFIG.revealHeightFrac * 2);
  group.scale.set(s1, s1, 1);

  const rectW = (ASPECT * s1) / (2 * camAspect) * W();
  const rectH = (s1 / 2) * H();
  hotspotsEl.style.left = ((W() - rectW) / 2) + 'px';
  hotspotsEl.style.top = ((H() - rectH) / 2) + 'px';
  hotspotsEl.style.width = rectW + 'px';
  hotspotsEl.style.height = rectH + 'px';
}

window.addEventListener('resize', layout);

/* ============================================================
 * 阶段切换
 * ============================================================ */
function startAssemble() {
  phase = PHASE.ASSEMBLE;
  assembleT = 0;
  activeRegion = -1;
  leaveLady();
  hotspotsEl.classList.remove('on');
  hintEl.classList.add('gone');
}

function startPan() {
  phase = PHASE.PAN;
  panT = 0;
}

function startEnd() {
  phase = PHASE.END;
  finaleEl.classList.add('show');
}

/* ============================================================
 * 动画循环
 * ============================================================ */
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

const clock = new THREE.Clock();
let uTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05) * timeScale;
  uTime += dt;
  material.uniforms.uTime.value = uTime;

  sway += (swayTarget - sway) * Math.min(1, dt * CONFIG.swaySpeed);
  material.uniforms.uSway.value = sway;

  if (phase === PHASE.REVEAL) {
    for (let i = 0; i < 6; i++) {
      const tgt = i === activeRegion ? 1 : 0;
      prog[i] += (tgt - prog[i]) * Math.min(1, dt * CONFIG.progressSpeed);
    }
    if (activeRegion >= 0 && prog[activeRegion] > 0.92) visited[activeRegion] = true;
    if (visited.every(Boolean)) startAssemble();
  } else if (phase === PHASE.ASSEMBLE) {
    assembleT += dt;
    uAll = easeOutCubic(Math.min(1, assembleT / CONFIG.assembleDuration));
    material.uniforms.uAll.value = uAll;
    if (uAll >= 1) startPan();
  } else if (phase === PHASE.PAN) {
    panT += dt;
    const s2 = CONFIG.panHeightFrac * 2;
    if (panT < CONFIG.zoomDuration) {
      const k = easeInOutCubic(panT / CONFIG.zoomDuration);
      const s = s1 + (s2 - s1) * k;
      group.scale.set(s, s, 1);
    } else {
      const off = Math.max(0, (ASPECT * s2 - 2 * camAspect) / 2);
      const k = easeInOutCubic(Math.min(1, (panT - CONFIG.zoomDuration) / CONFIG.panDuration));
      camera.position.x = off - 2 * off * k;
    }
    if (panT >= CONFIG.zoomDuration + CONFIG.panDuration) startEnd();
  } else if (phase === PHASE.END) {
    uFade += (0.45 - uFade) * Math.min(1, dt * 1.2);
    material.uniforms.uFade.value = uFade;
  }

  renderer.render(scene, camera);
}

/* ============================================================
 * 启动
 * ============================================================ */
const img = new Image();
img.onload = () => {
  ASPECT = img.width / img.height;
  layout();
  buildParticles(img);
  hotspotsEl.classList.add('on');
  animate();
};
img.src = typeof PAINTING_DATA_URL !== 'undefined' ? PAINTING_DATA_URL : 'painting.jpg';

/* 测试钩子 */
window.__zanhua = {
  get phase() { return phase; },
  visited,
  prog,
  forceAll() { visited.fill(true); },
  setTimeScale(v) { timeScale = v; },
};
