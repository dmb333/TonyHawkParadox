/* ==========================================================================
   The Tony Hawk Paradox - launch site
   Scroll drives a 1080 (three full spins). Chapters render in from the
   star field. The skater lands on a halfpipe and the signup rises from it.

   Stack: Three.js (scene) + GSAP ScrollTrigger (scroll timeline) + Lenis
   (smooth scroll). See index.html for the Formspree ID swap point.
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

gsap.registerPlugin(ScrollTrigger);

/* ---------- environment flags ---------- */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = window.matchMedia('(max-width: 768px)').matches || navigator.maxTouchPoints > 1;

if (reducedMotion) document.documentElement.classList.add('reduced-motion');

/* Performance budget knobs. Mobile gets fewer particles across the board. */
const BUDGET = {
  plexusNodes: isMobile ? 30 : 70,
  burstCount:  isMobile ? 160 : 320,
  pixelRatio:  Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2)
};

const TOTAL_SPIN = Math.PI * 6; // 1080 degrees
const LANDING_START = 0.86;     // scroll fraction where the descent begins

/* Skyline background parallax. Tied to overall scroll progress (not the
   landing-only ease), so the city grows closer across the whole page. */
const SKYLINE_SCALE_MAX = 0.16;  // final scale at 100% scroll (1 + this)
const SKYLINE_LIFT_MAX = 26;     // px the background lifts at 100% scroll

/* ---------- WebGL availability check ---------- */

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

const hasWebGL = webglAvailable();
if (!hasWebGL) document.documentElement.classList.add('no-webgl');

/* ==========================================================================
   Smooth scroll (Lenis) synced to ScrollTrigger.
   Skipped on mobile (native touch scroll feels better and costs nothing)
   and under reduced motion.
   ========================================================================== */

let lenis = null;
if (!reducedMotion && !isMobile && typeof Lenis !== 'undefined') {
  lenis = new Lenis({ duration: 1.1, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ==========================================================================
   Three.js scene
   ========================================================================== */

let scene, camera, renderer;
let rig, skaterGroup, boardGroup;
let halfpipe, burst, burstData, burstActive = false, burstAge = 0;
let shakeTime = 0;
const SHAKE_DUR = 0.5;   // seconds the landing shake lasts
let plexus;
let scrollProgress = 0, lastProgress = 0, scrollSpeed = 0;
let landed = false;

const BLUE = new THREE.Color('#2b8cff');
const BLUE_DEEP = new THREE.Color('#1a6dff');
const BODY_DARK = new THREE.Color('#070d1c');

const disposables = []; // geometries and materials to clean up on teardown
function track(obj) { disposables.push(obj); return obj; }

/* Shared skater materials. Declared here, before the scene builds, since
   buildSkaterRig() (called only if loadSkater() genuinely fails) needs
   them to already exist. */
const bodyMat = new THREE.MeshBasicMaterial({ color: BODY_DARK });
const edgeMat = new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.95 });
track(bodyMat); track(edgeMat);

/* ---------- skater model config ----------
   Declared up here, before initScene() runs, since loadSkater() needs them.

   EDIT: DEFAULT_STYLE picks the look on load: 'edges', 'wire', or 'rim'.
   EDIT: MODEL_SCALE if the figure reads too large or small.
   EDIT: MODEL_TILT to add x-rotation if the pose sits at a wrong angle. */
const DEFAULT_STYLE = 'edges';
const MODEL_PATH = 'assets/skater.glb?v=2';
const MODEL_SCALE = 2.6;
const MODEL_TILT = 0.0;

let skaterModel = null;    // the loaded mesh group
let styleNodes = {};       // { edges: Group, wire: Group, rim: Group }
let currentStyle = DEFAULT_STYLE;

let rigHomeX = 0, rigHomeZ = 0;  // rig's spin position, read by the landing sweep

let cityNodes, cityTraces, cityNodePhases = [];

if (hasWebGL) initScene();

function initScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0.6, 8.5);

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('stage'),
    antialias: !isMobile,
    alpha: true,            // transparent: the skyline image shows through
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(BUDGET.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);   // fully transparent clear

  buildPlexus();
  createRig();        // empty rig container only -- see comment on createRig()
  buildHalfpipe();
  buildBurst();
  buildCityLights();
  addLights();
  loadSkater();       // async: swaps in the real model when it arrives,
                       // and only builds the box fallback if it genuinely fails

  positionForViewport();
  window.addEventListener('resize', onResize);

  if (reducedMotion) {
    // One static frame, mid-spin. No animation loop, no scroll driving.
    rig.rotation.y = Math.PI * 0.7;
    renderer.render(scene, camera);
  } else {
    gsap.ticker.add(renderFrame);
  }
}

/* ---------- starfield: three parallax layers ---------- */

/* ==========================================================================
   Skater
   Primary: the GLTF model at assets/skater.glb, rendered in one of three
   treatments. If the model fails to load for any reason, the hand-built box
   figure below is used instead so the page never ends up empty.
   Config constants for this section are declared near the top of the file.
   ========================================================================== */

/* Material set for the three treatments */
/* ---------- plexus network ----------
   Kept dim: the skyline image already carries circuit traces, so this only
   adds a subtle 3D layer of depth around the skater rather than competing. */

function buildPlexus() {
  const n = BUDGET.plexusNodes;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const r = 7 + Math.random() * 5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    nodes.push(new THREE.Vector3(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta) * 0.7,
      -Math.abs(r * Math.cos(phi)) - 3
    ));
  }

  const linePositions = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (nodes[i].distanceTo(nodes[j]) < 3.4) {
        linePositions.push(nodes[i].x, nodes[i].y, nodes[i].z);
        linePositions.push(nodes[j].x, nodes[j].y, nodes[j].z);
      }
    }
  }

  plexus = new THREE.Group();

  const lineGeo = track(new THREE.BufferGeometry());
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePositions), 3));
  plexus.add(new THREE.LineSegments(lineGeo, track(new THREE.LineBasicMaterial({
    color: BLUE_DEEP, transparent: true, opacity: 0.10, depthWrite: false
  }))));

  const nodeGeo = track(new THREE.BufferGeometry().setFromPoints(nodes));
  plexus.add(new THREE.Points(nodeGeo, track(new THREE.PointsMaterial({
    color: BLUE, size: 0.08, transparent: true, opacity: 0.35,
    sizeAttenuation: true, depthWrite: false
  }))));

  scene.add(plexus);
}

function makeStyleMaterials() {
  return {
    // solid dark body with bright blue edge lines drawn over it
    edgesBody: track(new THREE.MeshBasicMaterial({ color: BODY_DARK })),
    edgesLine: track(new THREE.LineBasicMaterial({
      color: BLUE, transparent: true, opacity: 0.9
    })),
    // see-through wireframe
    wire: track(new THREE.MeshBasicMaterial({
      color: BLUE, wireframe: true, transparent: true, opacity: 0.55
    })),
    // solid dark body lit from behind so the silhouette catches a blue rim
    rim: track(new THREE.MeshStandardMaterial({
      color: 0x0a1024, roughness: 0.45, metalness: 0.3,
      emissive: BLUE_DEEP, emissiveIntensity: 0.12
    }))
  };
}

function buildSkaterFromModel(geometry) {
  const mats = makeStyleMaterials();
  const container = new THREE.Group();

  /* style 1: glowing edges over a dark body */
  const gEdges = new THREE.Group();
  gEdges.add(new THREE.Mesh(geometry, mats.edgesBody));
  // threshold angle keeps only meaningful edges, not every triangle seam
  const edgeGeo = track(new THREE.EdgesGeometry(geometry, 24));
  gEdges.add(new THREE.LineSegments(edgeGeo, mats.edgesLine));

  /* style 2: wireframe */
  const gWire = new THREE.Group();
  gWire.add(new THREE.Mesh(geometry, mats.wire));

  /* style 3: dark solid with a blue rim light */
  const gRim = new THREE.Group();
  gRim.add(new THREE.Mesh(geometry, mats.rim));

  styleNodes = { edges: gEdges, wire: gWire, rim: gRim };
  container.add(gEdges, gWire, gRim);
  setSkaterStyle(currentStyle);
  return container;
}

function setSkaterStyle(style) {
  currentStyle = style;
  Object.entries(styleNodes).forEach(([key, node]) => {
    if (node) node.visible = (key === style);
  });
}

/* Lighting. Only the rim style needs it, but it is cheap to leave in. */
function addLights() {
  // key light from behind and above, which is what creates the rim
  const back = new THREE.DirectionalLight(0x4d9bff, 3.2);
  back.position.set(-3, 4, -5);
  scene.add(back);

  // weak fill so the front is not pure black
  const fill = new THREE.DirectionalLight(0x2b8cff, 0.5);
  fill.position.set(2, 1, 4);
  scene.add(fill);

  scene.add(new THREE.AmbientLight(0x0a1430, 0.6));
}

function loadSkater() {
  const loader = new GLTFLoader();

  loader.load(
    MODEL_PATH,
    (gltf) => {
      // pull the first mesh geometry out of the loaded scene
      let geo = null;
      gltf.scene.traverse((child) => {
        if (!geo && child.isMesh) geo = child.geometry;
      });

      if (!geo) {
        console.warn('Skater model has no mesh, using box fallback.');
        buildSkaterRig();
        return;
      }

      // center the geometry and sit it on its own origin
      geo.center();
      geo.computeVertexNormals();
      track(geo);

      skaterModel = buildSkaterFromModel(geo);
      skaterModel.scale.setScalar(MODEL_SCALE);
      skaterModel.rotation.x = MODEL_TILT;

      // swap out the placeholder box figure
      if (skaterGroup) {
        rig.remove(skaterGroup);
        rig.remove(boardGroup);
      }
      rig.add(skaterModel);
    },
    undefined,
    (err) => {
      console.warn('Skater model failed to load, using box fallback.', err);
      buildSkaterRig();   // only built now, as a genuine fallback
    }
  );
}

/* ---------- fallback figure: hand-built boxes, used only if the model
     does not load. Kept so the page always renders something. ---------- */

function glowPart(geometry, position, rotation) {
  track(geometry);
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, bodyMat);
  const edges = new THREE.LineSegments(track(new THREE.EdgesGeometry(geometry)), edgeMat);
  group.add(mesh, edges);
  if (position) group.position.copy(position);
  if (rotation) group.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
  return group;
}

/* Builds a box "bone" between two joints. Keeps the pose data readable. */
function limb(a, b, thickness, depth) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.BoxGeometry(thickness, len, depth || thickness);
  const part = glowPart(geo);
  part.position.copy(a).add(b).multiplyScalar(0.5);
  part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return part;
}

/* Empty rig container, added to the scene immediately during init so that
   positionForViewport() and every frame of renderFrame() always have a
   rig to act on. Deliberately does NOT build the box figure -- that only
   happens inside buildSkaterRig(), called from loadSkater()'s error path,
   so the box figure never flashes on screen while the real model is
   loading normally (which is the common case). */
function createRig() {
  rig = new THREE.Group();
  rig.rotation.z = 0.3;   // airborne tilt, eased out at the landing
  scene.add(rig);
}

function buildSkaterRig() {
  boardGroup = new THREE.Group();
  skaterGroup = new THREE.Group();

  /* board */
  boardGroup.add(glowPart(new THREE.BoxGeometry(2.05, 0.07, 0.52), new THREE.Vector3(0, 0, 0)));
  // kicked nose and tail
  boardGroup.add(glowPart(new THREE.BoxGeometry(0.3, 0.07, 0.5),
    new THREE.Vector3(1.14, 0.05, 0), { z: -0.35 }));
  boardGroup.add(glowPart(new THREE.BoxGeometry(0.3, 0.07, 0.5),
    new THREE.Vector3(-1.14, 0.05, 0), { z: 0.35 }));
  // trucks
  boardGroup.add(glowPart(new THREE.BoxGeometry(0.08, 0.13, 0.4), new THREE.Vector3(0.68, -0.1, 0)));
  boardGroup.add(glowPart(new THREE.BoxGeometry(0.08, 0.13, 0.4), new THREE.Vector3(-0.68, -0.1, 0)));
  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.07, 10);
  [[0.68, 0.22], [0.68, -0.22], [-0.68, 0.22], [-0.68, -0.22]].forEach(([x, z]) => {
    boardGroup.add(glowPart(wheelGeo.clone(), new THREE.Vector3(x, -0.18, z), { x: Math.PI / 2 }));
  });

  /* skater pose: crouched frontside grab. Joint positions are hand tuned. */
  const J = {
    footL:     new THREE.Vector3(-0.42, 0.14, 0.04),
    footR:     new THREE.Vector3(0.46, 0.14, -0.04),
    kneeL:     new THREE.Vector3(-0.52, 0.64, 0.22),
    kneeR:     new THREE.Vector3(0.54, 0.62, 0.16),
    hipL:      new THREE.Vector3(-0.15, 0.98, 0),
    hipR:      new THREE.Vector3(0.15, 0.98, 0),
    hipC:      new THREE.Vector3(0, 1.0, 0),
    chest:     new THREE.Vector3(0.12, 1.56, 0.02),
    shoulderL: new THREE.Vector3(-0.13, 1.5, 0.02),
    shoulderR: new THREE.Vector3(0.36, 1.48, 0.02),
    elbowR:    new THREE.Vector3(0.68, 1.1, 0.16),
    handR:     new THREE.Vector3(0.92, 0.34, 0.12),  // reaches down, grabs near the nose
    elbowL:    new THREE.Vector3(-0.5, 1.74, 0.1),
    handL:     new THREE.Vector3(-1.0, 2.06, 0.18),  // thrown out for balance
    head:      new THREE.Vector3(0.2, 1.85, 0.02)
  };

  // feet planted on the deck
  skaterGroup.add(glowPart(new THREE.BoxGeometry(0.34, 0.1, 0.17), J.footL, { y: 0.15 }));
  skaterGroup.add(glowPart(new THREE.BoxGeometry(0.34, 0.1, 0.17), J.footR, { y: -0.1 }));

  // legs
  skaterGroup.add(limb(J.footL, J.kneeL, 0.14));
  skaterGroup.add(limb(J.kneeL, J.hipL, 0.15));
  skaterGroup.add(limb(J.footR, J.kneeR, 0.14));
  skaterGroup.add(limb(J.kneeR, J.hipR, 0.15));

  // torso: one wider box from hips to chest
  const torso = limb(J.hipC, J.chest, 0.42, 0.24);
  skaterGroup.add(torso);

  // arms
  skaterGroup.add(limb(J.shoulderR, J.elbowR, 0.11));
  skaterGroup.add(limb(J.elbowR, J.handR, 0.1));
  skaterGroup.add(limb(J.shoulderL, J.elbowL, 0.11));
  skaterGroup.add(limb(J.elbowL, J.handL, 0.1));

  // hands
  skaterGroup.add(glowPart(new THREE.BoxGeometry(0.13, 0.13, 0.13), J.handR));
  skaterGroup.add(glowPart(new THREE.BoxGeometry(0.13, 0.13, 0.13), J.handL));

  // head: low detail icosahedron reads nicely in wireframe
  skaterGroup.add(glowPart(new THREE.IcosahedronGeometry(0.19, 0), J.head));

  rig.add(boardGroup, skaterGroup);
}

/* ---------- halfpipe: swept U cross-section rendered as a glowing grid ---------- */

function buildHalfpipe() {
  halfpipe = new THREE.Group();

  /* Fisheye halfpipe, matching the book cover.

     The cover is a fisheye photo taken from inside the bowl. The signature of
     that lens is the coping ARC: it sweeps low through the middle of the frame
     and bows upward at both edges, and the bowl fills the entire lower half.

     A normal lens cannot produce that shape, so rather than distorting the
     whole render (which would warp the signup panel and skyline too), the
     curvature is built into the ramp geometry itself. Same look, no collateral
     damage to the HTML overlay.

     EDIT: BOW controls the fisheye arc (0 = a straight, ordinary ramp).
     R is the transition radius, DEPTH is how far the ramp runs across frame. */
  const FLAT = 1.0;    // half-width of the flat bottom
  const R = 7.0;       // transition radius: deep bowl
  const VERT = 1.6;    // vertical wall up to the coping
  const DEPTH = 40;    // long: runs off both edges of the frame
  const BOW = 5.5;     // fisheye arc: how far the coping lifts at the ends
  const SEG = 24;      // curve resolution across the U
  const SLICES = isMobile ? 14 : 26;   // resolution along the arc

  /* U cross-section (x, y), before the bow is applied */
  const section = [];
  section.push(new THREE.Vector2(-FLAT - R, R + VERT));
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * (Math.PI / 2);
    section.push(new THREE.Vector2(-FLAT - Math.cos(a) * R, R - Math.sin(a) * R));
  }
  for (let i = SEG; i >= 0; i--) {
    const a = (i / SEG) * (Math.PI / 2);
    section.push(new THREE.Vector2(FLAT + Math.cos(a) * R, R - Math.sin(a) * R));
  }
  section.push(new THREE.Vector2(FLAT + R, R + VERT));

  /* The fisheye bow: parabolic lift along the ramp's length. Zero at the
     center of frame, rising to BOW at both ends. This is the arc you see on
     the cover. */
  const bowAt = (z) => {
    const u = z / (DEPTH / 2);   // -1 at one end, +1 at the other
    return BOW * u * u;
  };

  const gridLines = [];

  // rails running along the length, following the arc
  for (const p of section) {
    for (let s = 0; s < SLICES; s++) {
      const z0 = -DEPTH / 2 + (s / SLICES) * DEPTH;
      const z1 = -DEPTH / 2 + ((s + 1) / SLICES) * DEPTH;
      gridLines.push(p.x, p.y + bowAt(z0), z0,
                     p.x, p.y + bowAt(z1), z1);
    }
  }
  // cross-section ribs at intervals
  for (let s = 0; s <= SLICES; s++) {
    const z = -DEPTH / 2 + (s / SLICES) * DEPTH;
    const lift = bowAt(z);
    for (let i = 0; i < section.length - 1; i++) {
      gridLines.push(section[i].x,     section[i].y + lift,     z,
                     section[i + 1].x, section[i + 1].y + lift, z);
    }
  }

  const gridGeo = track(new THREE.BufferGeometry());
  gridGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gridLines), 3));
  halfpipe.add(new THREE.LineSegments(gridGeo, track(new THREE.LineBasicMaterial({
    color: BLUE_DEEP, transparent: true, opacity: 0.32, depthWrite: false
  }))));

  /* Coping: the two bright rails along the top edges. On the cover these are
     the brightest thing in the lower frame and they carry the whole arc, so
     they are near-white and fully opaque. */
  const copingLines = [];
  const L = section[0], Rt = section[section.length - 1];
  for (let s = 0; s < SLICES; s++) {
    const z0 = -DEPTH / 2 + (s / SLICES) * DEPTH;
    const z1 = -DEPTH / 2 + ((s + 1) / SLICES) * DEPTH;
    const b0 = bowAt(z0), b1 = bowAt(z1);
    copingLines.push(L.x,  L.y + b0,  z0,  L.x,  L.y + b1,  z1);
    copingLines.push(Rt.x, Rt.y + b0, z0,  Rt.x, Rt.y + b1, z1);
  }
  const copingGeo = track(new THREE.BufferGeometry());
  copingGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(copingLines), 3));
  halfpipe.add(new THREE.LineSegments(copingGeo, track(new THREE.LineBasicMaterial({
    color: 0xbcdcff, transparent: true, opacity: 1.0
  }))));

  /* Deck surface: opaque, so the skyline photo does not show through the bowl.
     Built as a quad strip following the arc. */
  const verts = [];
  for (let s = 0; s < SLICES; s++) {
    const z0 = -DEPTH / 2 + (s / SLICES) * DEPTH;
    const z1 = -DEPTH / 2 + ((s + 1) / SLICES) * DEPTH;
    const b0 = bowAt(z0), b1 = bowAt(z1);
    for (let i = 0; i < section.length - 1; i++) {
      const a = section[i], b = section[i + 1];
      // two triangles per quad
      verts.push(a.x, a.y + b0, z0,  b.x, b.y + b0, z0,  a.x, a.y + b1, z1);
      verts.push(b.x, b.y + b0, z0,  b.x, b.y + b1, z1,  a.x, a.y + b1, z1);
    }
  }
  const surfGeo = track(new THREE.BufferGeometry());
  surfGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  surfGeo.computeVertexNormals();
  halfpipe.add(new THREE.Mesh(surfGeo, track(new THREE.MeshBasicMaterial({
    color: 0x050b1c, side: THREE.DoubleSide
  }))));

  halfpipe.position.y = -34;   // parked offscreen until the descent
  scene.add(halfpipe);
}

/* ---------- landing particle burst ---------- */

/* ---------- city circuit lights ----------
   The skyline is a flat photo, so lights cannot attach to specific buildings.
   Instead, glowing nodes are scattered in 3D across the lower frame at roughly
   rooftop height, with thin traces linking nearby ones, giving the skyline a
   circuit-board texture. They drift slowly and pulse. */

function buildCityLights() {
  const n = isMobile ? 24 : 46;
  const pts = [];
  for (let i = 0; i < n; i++) {
    // spread wide across x, low in y (over the rooftops), pushed back in z
    pts.push(new THREE.Vector3(
      (Math.random() - 0.5) * 34,
      -3.5 - Math.random() * 3.5,
      -8 - Math.random() * 6
    ));
    cityNodePhases.push(Math.random() * Math.PI * 2);
  }

  // nodes
  const nodeGeo = track(new THREE.BufferGeometry().setFromPoints(pts));
  cityNodes = new THREE.Points(nodeGeo, track(new THREE.PointsMaterial({
    color: 0x8fc4ff, size: 0.16, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, depthWrite: false
  })));
  scene.add(cityNodes);

  // traces between nearby nodes, drawn as right-angle steps for a circuit feel
  const lines = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pts[i].distanceTo(pts[j]) < 6) {
        // L-shaped connector: horizontal then vertical
        const mid = new THREE.Vector3(pts[j].x, pts[i].y, (pts[i].z + pts[j].z) / 2);
        lines.push(pts[i].x, pts[i].y, pts[i].z, mid.x, mid.y, mid.z);
        lines.push(mid.x, mid.y, mid.z, pts[j].x, pts[j].y, pts[j].z);
      }
    }
  }
  const traceGeo = track(new THREE.BufferGeometry());
  traceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3));
  cityTraces = new THREE.LineSegments(traceGeo, track(new THREE.LineBasicMaterial({
    color: BLUE_DEEP, transparent: true, opacity: 0.25, depthWrite: false
  })));
  scene.add(cityTraces);
}

function buildBurst() {
  const n = BUDGET.burstCount;
  const positions = new Float32Array(n * 3);
  burstData = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    // wider, faster spread so the blast fills the frame at the new camera distance
    const speed = 0.12 + Math.random() * 0.42;
    burstData.push({
      vx: Math.cos(a) * speed,
      vy: Math.random() * 0.42 + 0.08,
      vz: Math.sin(a) * speed * 0.7
    });
  }
  const geo = track(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = track(new THREE.PointsMaterial({
    color: 0xbcdcff, size: 0.22, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, depthWrite: false
  }));
  burst = new THREE.Points(geo, mat);
  scene.add(burst);
}

function fireBurst() {
  if (!hasWebGL || reducedMotion) return;
  const pos = burst.geometry.attributes.position.array;
  const origin = new THREE.Vector3();
  rig.getWorldPosition(origin);
  for (let i = 0; i < burstData.length; i++) {
    pos[i * 3] = origin.x;
    pos[i * 3 + 1] = origin.y - 0.3;
    pos[i * 3 + 2] = origin.z;
  }
  burst.geometry.attributes.position.needsUpdate = true;
  burst.material.opacity = 1;
  burstActive = true;
  burstAge = 0;
  shakeTime = SHAKE_DUR;   // kick off the screen shake
}

/* ---------- layout for viewport ---------- */

function positionForViewport() {
  // Desktop: text column left, skater offset right. Mobile: skater centered behind panels.
  const wide = window.innerWidth > 900;
  rigHomeX = wide ? 2.4 : 0;
  rigHomeZ = wide ? 0 : -1.2;
  rig.position.x = rigHomeX;
  rig.position.z = rigHomeZ;
  // halfpipe stays centered: the skater sweeps back to it on the landing
  halfpipe.position.x = 0;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  positionForViewport();
  if (reducedMotion) renderer.render(scene, camera);
}

/* ---------- per-frame update ---------- */

const clock = new THREE.Clock();

function renderFrame() {
  const t = clock.getElapsedTime();

  // scroll speed drives the trail; decay it every frame
  scrollSpeed += (Math.abs(scrollProgress - lastProgress) * 60 - scrollSpeed) * 0.12;
  lastProgress = scrollProgress;

  /* spin: three full rotations mapped linearly to scroll */
  rig.rotation.y = scrollProgress * TOTAL_SPIN;

  /* landing phase.
     The skater sweeps from its offset spin position back to center, drops
     onto the halfpipe coping, and comes to rest directly above the signup
     panel. LAND_Y is the resting height: raise it to sit higher on screen,
     lower it to sit closer to the panel. */
  const LAND_Y = 1.35;

  const lp = Math.max(0, (scrollProgress - LANDING_START) / (1 - LANDING_START));
  const ease = lp * lp * (3 - 2 * lp); // smoothstep

  // sweep back to center x as the descent progresses
  rig.position.x = rigHomeX * (1 - ease);
  rig.position.z = rigHomeZ * (1 - ease * 0.5);   // read from home, not self

  /* Halfpipe rises into frame. */
  const HALFPIPE_Y = -11.0;
  halfpipe.position.y = -34 + ease * (34 + HALFPIPE_Y);

  /* Camera: this is what actually makes the ramp read as a bowl.
     Level with the ramp, a curved U collapses into a flat V. So on the
     landing the camera drops and tilts down INTO the bowl, the way the book
     cover looks into the halfpipe from inside it.

     EDIT: CAM_END_Y / CAM_END_Z / CAM_PITCH tune the final viewpoint. */
  const CAM_START_Y = 0.6,  CAM_START_Z = 8.5;
  const CAM_END_Y   = 1.5,  CAM_END_Z   = 8.0;
  const CAM_PITCH   = -0.64;   // ~36 degrees down, looking into the bowl

  /* Widen the lens only on the landing. A wide FOV up top would distort the
     hero; here it is what lets the bowl wrap past both edges of the frame. */
  const FOV_START = 50, FOV_END = 70;
  const fov = FOV_START + (FOV_END - FOV_START) * ease;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  camera.position.x = 0;   // reset before shake so it does not accumulate
  camera.position.y = CAM_START_Y + (CAM_END_Y - CAM_START_Y) * ease;
  camera.position.z = CAM_START_Z + (CAM_END_Z - CAM_START_Z) * ease;
  camera.rotation.x = CAM_PITCH * ease;

  /* Landing screen shake: decays over SHAKE_DUR. Added on top of the camera
     position so it rattles the whole view on impact. */
  if (shakeTime > 0) {
    shakeTime -= 0.016;
    const mag = Math.max(0, shakeTime / SHAKE_DUR) * 0.35;
    camera.position.x += (Math.random() - 0.5) * mag;
    camera.position.y += (Math.random() - 0.5) * mag;
    camera.rotation.z = (Math.random() - 0.5) * mag * 0.15;
  } else {
    camera.rotation.z = 0;
  }

  /* The signup panel is HTML and fixed on screen, but the camera pitches down
     during the landing, which would push the skater up out of frame. Ride the
     skater down with the camera so it stays sitting on top of the panel. */
  const camComp = ease * 2.4;
  rig.position.y = Math.sin(t * 1.4) * 0.06 * (1 - ease) + ease * LAND_Y - camComp;

  // idle float fades out, then settle at LAND_Y above the panel

  rig.rotation.z = 0.3 * (1 - ease);                       // level out to land
  rig.rotation.x = Math.sin(t * 0.9) * 0.04 * (1 - ease);



  /* plexus slow rotation */
  plexus.rotation.y = t * 0.015 + scrollProgress * 0.4;

  /* city lights pulse gently and drift with the background parallax */
  if (cityNodes) {
    cityNodes.material.opacity = 0.6 + Math.sin(t * 1.3) * 0.25;
    cityNodes.position.x = Math.sin(t * 0.05) * 0.4;
    if (cityTraces) {
      cityTraces.material.opacity = 0.18 + Math.sin(t * 0.9 + 1) * 0.1;
      cityTraces.position.x = cityNodes.position.x;
    }
  }


  /* landing burst */
  if (burstActive) {
    burstAge += 0.016;
    const pos = burst.geometry.attributes.position.array;
    for (let i = 0; i < burstData.length; i++) {
      pos[i * 3]     += burstData[i].vx;
      pos[i * 3 + 1] += burstData[i].vy;
      pos[i * 3 + 2] += burstData[i].vz;
      burstData[i].vy -= 0.004; // gravity
    }
    burst.geometry.attributes.position.needsUpdate = true;
    burst.material.opacity = Math.max(0, 1 - burstAge / 1.4);
    if (burstAge > 1.5) burstActive = false;
  }

  renderer.render(scene, camera);
}

/* ==========================================================================
   Scroll wiring: master progress, HUD, milestones
   ========================================================================== */

const hudValue = document.getElementById('hud-value');
const hudFill = document.getElementById('hud-fill');
const hudMilestone = document.getElementById('hud-milestone');
const signupPanel = document.getElementById('signup');
const flashEl = document.getElementById('flash');
const skylineEl = document.getElementById('skyline');
let lastMilestone = 0;

const LANDED_AT = 0.985; // scroll fraction that counts as touching down

if (!reducedMotion && hasWebGL) {
  ScrollTrigger.create({
    trigger: document.body,
    start: 'top top',
    end: 'bottom bottom',
    onUpdate(self) {
      scrollProgress = self.progress;

      /* Background parallax: the skyline slowly grows closer and lifts
         slightly as the visitor scrolls, reinforcing the sense of
         descending toward the city over the whole page, not just at the
         landing. Tied to overall scroll, not the landing-only "ease".
         EDIT: SKYLINE_SCALE_MAX / SKYLINE_LIFT_MAX to make this more or
         less pronounced. */
      if (skylineEl) {
        const p = self.progress;
        const scale = 1 + p * SKYLINE_SCALE_MAX;
        const lift = p * SKYLINE_LIFT_MAX;
        skylineEl.style.transform = `translateY(-${lift}px) scale(${scale})`;
      }

      const deg = Math.round(self.progress * 1080);
      hudValue.textContent = String(deg).padStart(4, '0');
      hudFill.style.width = (self.progress * 100).toFixed(1) + '%';

      // quiet milestone callouts at each full rotation
      const milestone = deg >= 1080 ? 1080 : deg >= 720 ? 720 : deg >= 360 ? 360 : 0;
      if (milestone !== lastMilestone) {
        lastMilestone = milestone;
        if (milestone > 0) {
          hudMilestone.textContent = milestone + ' LOCKED';
          hudMilestone.classList.add('show');
          clearTimeout(hudMilestone._t);
          hudMilestone._t = setTimeout(() => hudMilestone.classList.remove('show'), 1200);
        }
      }

      // landing: burst, flash, signup rises. Reverses if the visitor scrolls back up.
      if (self.progress >= LANDED_AT && !landed) {
        landed = true;
        fireBurst();
        gsap.fromTo(flashEl, { opacity: 0.9 }, { opacity: 0, duration: 0.9, ease: 'power2.out' });
        signupPanel.classList.add('risen');
      } else if (self.progress < LANDED_AT - 0.03 && landed) {
        landed = false;
        signupPanel.classList.remove('risen');
      }
    }
  });
} else {
  // reduced motion or no WebGL: signup is simply visible
  signupPanel.classList.add('risen');
}

/* ==========================================================================
   Chapter panels: render-in effect
   Wireframe-to-solid: panels arrive blurred and translucent with a dashed
   frame, then assemble. Icons draw their strokes in. A few particles
   converge as each panel forms.
   ========================================================================== */

function prepareIconStrokes(panel) {
  const shapes = panel.querySelectorAll('.icon path, .icon circle, .icon rect');
  shapes.forEach((el) => {
    let len = 100;
    try { len = el.getTotalLength(); } catch (e) { /* keep default */ }
    el.style.strokeDasharray = len;
    el.style.strokeDashoffset = len;
  });
  return shapes;
}

function spawnAssemblyDots(panel) {
  const rect = panel.getBoundingClientRect();
  const count = isMobile ? 6 : 12;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('span');
    dot.className = 'assembly-dot';
    const edge = Math.random();
    // start scattered around the panel, converge to its border
    const fromX = (Math.random() - 0.5) * rect.width * 1.6 + rect.width / 2;
    const fromY = (Math.random() - 0.5) * rect.height * 1.8 + rect.height / 2;
    const toX = edge < 0.5 ? Math.random() * rect.width : (edge < 0.75 ? 0 : rect.width);
    const toY = edge < 0.5 ? (Math.random() < 0.5 ? 0 : rect.height) : Math.random() * rect.height;
    dot.style.left = fromX + 'px';
    dot.style.top = fromY + 'px';
    panel.appendChild(dot);
    gsap.to(dot, {
      left: toX, top: toY, opacity: 0,
      duration: 0.7 + Math.random() * 0.4,
      ease: 'power2.out',
      onComplete: () => dot.remove()
    });
  }
}

if (!reducedMotion && hasWebGL) {
  document.querySelectorAll('.panel').forEach((panel) => {
    const strokes = prepareIconStrokes(panel);

    gsap.set(panel, {
      opacity: 0, y: 60, filter: 'blur(8px)',
      borderStyle: 'dashed', borderColor: 'rgba(43,140,255,0.6)'
    });
    gsap.set(panel.querySelectorAll('h2, .teaser, .level'), { opacity: 0, y: 14 });

    ScrollTrigger.create({
      trigger: panel,
      start: 'top 78%',
      onEnter() {
        const tl = gsap.timeline();
        tl.to(panel, {
          opacity: 1, y: 0, filter: 'blur(0px)',
          duration: 0.7, ease: 'power3.out'
        })
        .to(panel, {
          borderStyle: 'solid',
          borderColor: panel.classList.contains('panel-epilogue')
            ? 'rgba(43,140,255,0.28)' : 'rgba(43,140,255,0.28)',
          duration: 0.3
        }, '-=0.25')
        .to(panel.querySelectorAll('h2, .teaser, .level'), {
          opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out'
        }, '-=0.45')
        .to(strokes, {
          strokeDashoffset: 0, duration: 0.9, stagger: 0.06, ease: 'power2.inOut'
        }, '-=0.5');
        spawnAssemblyDots(panel);
      },
      onLeaveBack() {
        gsap.to(panel, { opacity: 0, y: 60, filter: 'blur(8px)', duration: 0.4 });
        gsap.set(panel, { borderStyle: 'dashed' });
        gsap.set(panel.querySelectorAll('h2, .teaser, .level'), { opacity: 0, y: 14 });
        strokes.forEach((el) => { el.style.strokeDashoffset = el.style.strokeDasharray; });
      },
      once: false
    });
  });

  /* hero lockup: subtle rise on load */
  gsap.from('.hero-lockup > *', {
    opacity: 0, y: 24, duration: 0.9, stagger: 0.1, ease: 'power3.out', delay: 0.2
  });
}

/* ==========================================================================
   Signup form: Formspree POST with validation, honeypot, success and
   error states. Wired to the live Formspree endpoint set in index.html
   (https://formspree.io/f/mvzyzqaw). The fetch()-based POST below is
   already the equivalent of Formspree's AJAX guide, so no extra library
   is loaded — the honeypot, validation, and success/error states here
   cover the same ground @formspree/ajax would, without a second script.
   ========================================================================== */

const form = document.getElementById('signup-form');
const formMsg = document.getElementById('form-msg');
const submitBtn = document.getElementById('submit-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formMsg.className = 'form-msg';
  formMsg.textContent = '';

  const email = form.email.value.trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) {
    formMsg.classList.add('err');
    formMsg.textContent = 'That email does not look right. Check it and try again.';
    return;
  }

  // honeypot: silently drop bot submissions
  if (form._gotcha.value) {
    formMsg.classList.add('ok');
    formMsg.textContent = 'You are on the list. We will notify you at release.';
    form.reset();
    return;
  }

  submitBtn.disabled = true;
  try {
    const res = await fetch(form.action, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body: new FormData(form)
    });
    if (res.ok) {
      formMsg.classList.add('ok');
      formMsg.textContent = 'You are on the list. We will notify you at release.';
      form.reset();
    } else {
      throw new Error('Formspree returned ' + res.status);
    }
  } catch (err) {
    formMsg.classList.add('err');
    formMsg.textContent = 'Something went wrong sending that. Try again in a moment.';
  } finally {
    submitBtn.disabled = false;
  }
});

/* ==========================================================================
   Cleanup on page hide: dispose Three.js objects so nothing leaks if the
   page gets torn down inside a webview or bfcache.
   ========================================================================== */

window.addEventListener('pagehide', () => {
  if (!hasWebGL || !renderer) return;
  disposables.forEach((d) => d.dispose && d.dispose());
  renderer.dispose();
});

/* ==========================================================================
   Pull-quote modal + About-the-author panel
   Plain DOM wiring, independent of the 3D scene so it works everywhere.
   ========================================================================== */

(function () {
  // --- about-the-author panel ---
  const bioPanel = document.getElementById('bio-panel');
  const bioToggle = document.getElementById('bio-toggle');

  function openBio() {
    if (!bioPanel) return;
    bioPanel.classList.add('open');
    bioPanel.setAttribute('aria-hidden', 'false');
  }
  function closeBio() {
    if (!bioPanel) return;
    bioPanel.classList.remove('open');
    bioPanel.setAttribute('aria-hidden', 'true');
  }

  if (bioToggle) bioToggle.addEventListener('click', openBio);
  if (bioPanel) {
    bioPanel.querySelectorAll('[data-bio-close]').forEach((el) =>
      el.addEventListener('click', closeBio));
  }

  // --- FAQ panel: same open/close pattern as the bio panel ---
  const faqPanel = document.getElementById('faq-panel');
  const faqToggle = document.getElementById('faq-toggle');

  function openFaq() {
    if (!faqPanel) return;
    faqPanel.classList.add('open');
    faqPanel.setAttribute('aria-hidden', 'false');
  }
  function closeFaq() {
    if (!faqPanel) return;
    faqPanel.classList.remove('open');
    faqPanel.setAttribute('aria-hidden', 'true');
  }

  if (faqToggle) faqToggle.addEventListener('click', openFaq);
  if (faqPanel) {
    faqPanel.querySelectorAll('[data-faq-close]').forEach((el) =>
      el.addEventListener('click', closeFaq));
  }

  // escape closes whichever is open
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeBio(); closeFaq(); }
  });
})();
