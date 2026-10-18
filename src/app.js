/* Playback page: loads G-code, plans it (core.js) and plays it back in real time with Three.js. */
(function () {
  'use strict';
  const C = window.PlaybackCore;
  const $ = (id) => document.getElementById(id);
  const host = (window.orca && typeof window.orca.postMessage === 'function') ? window.orca : null;
  const send = (msg) => { if (host) host.postMessage(msg); };

  /* ------------------------------------------------------------------ preferences */
  const DEFAULT_PREFS = { speed: 10, color: 'feature', travel: false, layerOnly: false, follow: false,
                          motion: 'auto', lines: 'fat', timing: 'aligned', head: true, gantry: true, shade: 'tube', flags: {}, pauseOnLeave: true };
  let prefs = Object.assign({}, DEFAULT_PREFS);
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('orca-playback-prefs') || '{}')); } catch (e) { /* storage may be off */ }
  let prefTimer = 0;
  function savePrefs() {
    clearTimeout(prefTimer);
    prefTimer = setTimeout(() => {
      try { localStorage.setItem('orca-playback-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
      send({ cmd: 'save_prefs', prefs });
    }, 300);
  }

  /* ------------------------------------------------------------------ small UI helpers */
  function fmtTime(s, withSec) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }
  function fmtLong(s) {
    s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
  }
  let toastTimer = 0;
  function toast(text, isErr) {
    const t = $('toast'); t.textContent = text; t.className = 'overlay show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'overlay'; }, isErr ? 6000 : 2800);
  }
  function busy(text, frac) {
    const b = $('busy');
    if (text == null) { b.style.display = 'none'; return; }
    b.style.display = 'grid'; $('busyText').textContent = text;
    $('busyBar').style.width = Math.round((frac || 0) * 100) + '%';
  }
  const nextFrame = () => new Promise((r) => setTimeout(r, 0));

  /* ------------------------------------------------------------------ colours */
  const RANGE = ['#0b2c7a', '#135985', '#1c8891', '#04d60f', '#aaf200', '#fcf903', '#f5ce0a', '#d16830', '#c2523c', '#942616'];
  const hexRGB = (h) => { h = String(h || '#888').replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join('');
                          const v = parseInt(h.substring(0, 6), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
  const RANGE_RGB = RANGE.map(hexRGB);
  const FEAT_RGB = C.FEATURES.map(f => hexRGB(f[1]));
  function rampRGB(t, out) {
    t = Math.max(0, Math.min(1, t)) * (RANGE_RGB.length - 1);
    const i = Math.min(RANGE_RGB.length - 2, Math.floor(t)), f = t - i, a = RANGE_RGB[i], b = RANGE_RGB[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
  }
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /* ------------------------------------------------------------------ three.js scene */
  const canvas = $('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
  camera.up.set(0, 0, 1);
  /* Camera like OrcaSlicer's: a turntable with Z up. Left drag rotates, right drag (or Shift/Ctrl +
     left) pans, middle drag and the wheel zoom.
     - Rotation turns about the middle of the screen, at the depth of the first line straight ahead
       (or the current view centre when there is none), so the picture doesn't jump.
     - The wheel zooms toward the point under the cursor, so what you point at stays put.
     - A drag ends on pointerup, pointercancel, lost capture or window blur, and the wheel never waits
       for a drag to end, so zooming can't get stuck after a release the page didn't see. */
  const controls = (() => {
    const target = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    let mode = null, pointerId = null, lastX = 0, lastY = 0, changed = true;
    const pivot = new THREE.Vector3(), panPerPx = { v: 0 };
    let zoomPick = null;                 // {x, y, p}: cached point under a resting cursor
    const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), q = new THREE.Quaternion();
    const api = { target, enabled: true, pick: null };

    function ray(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      camera.updateMatrixWorld();          // the camera may have moved since the last frame was drawn
      const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, camera); return rc.ray;
    }
    // point on the view ray at the depth of the current target (the plane through it facing the camera)
    function onTargetPlane(rr) {
      const n = camera.getWorldDirection(tmp2);
      const denom = rr.direction.dot(n);
      const d = Math.abs(denom) > 1e-6 ? target.clone().sub(rr.origin).dot(n) / denom : target.distanceTo(camera.position);
      return rr.origin.clone().addScaledVector(rr.direction, Math.max(d, 1));
    }
    function pickAt(clientX, clientY) {
      const rr = ray(clientX, clientY);
      const hit = api.pick ? api.pick(rr) : null;
      return { hit, point: hit || null, rr };
    }
    /* The view direction is kept as two angles about the target: azimuth theta (around Z) and polar
       angle phi (0 = straight down from above). The camera's axes are built from them directly,
       never with lookAt, so straight overhead is an ordinary view: theta still says which way is up
       on screen, and the picture can't flip or flicker at the pole. */
    let theta = -2.1, phi = 0.9;
    const basis = new THREE.Matrix4(), bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3();
    function orient() {
      const st = Math.sin(theta), ct = Math.cos(theta), sp = Math.sin(phi), cp = Math.cos(phi);
      const d = Math.max(1e-6, camera.position.distanceTo(target));
      bz.set(sp * ct, sp * st, cp);                       // from the target toward the camera
      bx.set(-st, ct, 0);                                  // screen right
      by.set(-cp * ct, -cp * st, sp);                      // screen up
      camera.position.copy(target).addScaledVector(bz, d);
      basis.makeBasis(bx, by, bz); camera.quaternion.setFromRotationMatrix(basis);
      camera.updateMatrix(); changed = true;
    }
    // read the angles back after the camera was placed from outside (view buttons, tests)
    function fromCamera() {
      const v = tmp.copy(camera.position).sub(target), d = v.length();
      if (d < 1e-9) return;
      phi = Math.acos(Math.max(-1, Math.min(1, v.z / d)));
      if (Math.sin(phi) > 1e-6) theta = Math.atan2(v.y, v.x);   // at the pole keep the last azimuth
      orient();
    }
    function rotate(dx, dy) {
      const h = canvas.clientHeight || 1;
      // like OrcaSlicer: drag right swings the camera left around the print, drag down raises it (looks down more)
      theta -= 2 * Math.PI * dx / h;
      phi = Math.max(0, Math.min(Math.PI, phi - 2 * Math.PI * dy / h));
      orient();
    }
    function pan(dx, dy) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const move = right.multiplyScalar(-dx * panPerPx.v).add(up.multiplyScalar(dy * panPerPx.v));
      camera.position.add(move); target.add(move); changed = true;
    }
    function zoomAbout(p, f) {
      const dist = camera.position.distanceTo(p);
      if (f < 1 && dist * f < 0.6) f = 0.6 / Math.max(dist, 1e-6);          // don't go through what you point at
      if (f > 1 && dist * f > 4000) f = 4000 / Math.max(dist, 1e-6);
      if (Math.abs(f - 1) < 1e-6) return;
      camera.position.sub(p).multiplyScalar(f).add(p);
      target.sub(p).multiplyScalar(f).add(p);
      changed = true;
    }
    function zoomPoint(clientX, clientY) {
      if (zoomPick && Math.abs(zoomPick.x - clientX) < 3 && Math.abs(zoomPick.y - clientY) < 3) return zoomPick.p;
      const { point, rr } = pickAt(clientX, clientY);
      const p = point || onTargetPlane(rr);
      zoomPick = { x: clientX, y: clientY, p: p.clone() };
      return zoomPick.p;
    }
    function depthPerPx(p) {
      const d = Math.max(0.5, camera.position.distanceTo(p));
      return 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (canvas.clientHeight || 1);
    }
    function end() {
      if (pointerId != null) { try { canvas.releasePointerCapture(pointerId); } catch (e) { /* already released */ } }
      mode = null; pointerId = null; canvas.style.cursor = '';
    }
    // touch: one finger rotates, two fingers pinch-zoom and pan
    const touches = new Map(); let pinch = null;

    canvas.addEventListener('pointerdown', (e) => {
      if (!api.enabled) return;
      canvas.focus({ preventScroll: true });
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const p = zoomPoint(mx, my);
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx, my, p }; panPerPx.v = depthPerPx(p); mode = null;
          return;
        }
      }
      end();
      const panBtn = e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey));
      mode = panBtn ? 'pan' : e.button === 1 ? 'dolly' : e.button === 0 ? 'rotate' : null;
      if (!mode) return;
      pointerId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      if (mode === 'rotate') {
        // OrcaSlicer-style turntable about the middle of the screen: the first line straight ahead
        // of the camera, or the current view centre when nothing is there. It sits on the view
        // axis, so making it the target doesn't move the picture.
        const r = canvas.getBoundingClientRect();
        const { point } = pickAt(r.left + r.width / 2, r.top + r.height / 2);
        if (point) target.copy(point);
        pivot.copy(target);
        canvas.style.cursor = 'grabbing';
      } else {
        const { point, rr } = pickAt(e.clientX, e.clientY);
        const p = point || onTargetPlane(rr);
        pivot.copy(p); panPerPx.v = depthPerPx(p);
        canvas.style.cursor = mode === 'pan' ? 'move' : 'ns-resize';
      }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size === 2) {
          const [a, b] = [...touches.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          pan(mx - pinch.mx, my - pinch.my);
          if (d > 1 && pinch.d > 1) zoomAbout(pinch.p, pinch.d / d);
          pinch.d = d; pinch.mx = mx; pinch.my = my; panPerPx.v = depthPerPx(pinch.p);
          return;
        }
      }
      if (!mode || e.pointerId !== pointerId) return;
      if (e.buttons === 0 && e.pointerType === 'mouse') { end(); return; }   // the button came up where we couldn't see it
      const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
      if (mode === 'rotate') rotate(dx, dy);
      else if (mode === 'pan') pan(dx, dy);
      else if (mode === 'dolly') zoomAbout(pivot, Math.exp(dy * 0.006));
      zoomPick = null;
    });
    const up = (e) => {
      if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; }
      if (e.pointerId === pointerId) end();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', (e) => { if (e.pointerId === pointerId) end(); });
    window.addEventListener('blur', () => { end(); touches.clear(); pinch = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!api.enabled) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const dy = Math.max(-400, Math.min(400, e.deltaY * unit));
      zoomAbout(zoomPoint(e.clientX, e.clientY), Math.exp(dy * 0.0012));
    }, { passive: false });
    canvas.addEventListener('pointerleave', () => { zoomPick = null; });

    api.update = () => {
      const c = changed; changed = false;
      if (c) {
        // keep the near plane in step with how close we are, so zooming in doesn't clip the print
        const near = Math.min(5, Math.max(0.02, camera.position.distanceTo(target) / 400));
        if (Math.abs(near - camera.near) / camera.near > 0.2) { camera.near = near; camera.updateProjectionMatrix(); }
      }
      return c;
    };
    api.sync = () => { fromCamera(); zoomPick = null; changed = true; };
    api.isDragging = () => mode != null;
    api._pivot = () => pivot.clone();
    return api;
  })();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6); sun.position.set(-1, -2, 3); scene.add(sun);

  const bedGroup = new THREE.Group(); scene.add(bedGroup);    // bed + everything printed on it
  const headGroup = new THREE.Group(); scene.add(headGroup);  // nozzle
  const gantry = new THREE.Group(); scene.add(gantry);
  let bedMesh = null;

  function buildHead() {
    const metal = new THREE.MeshLambertMaterial({ color: 0xc8ccd2 });
    // translucent hot-end body so it never hides the line being printed
    const block = new THREE.MeshLambertMaterial({ color: 0x59616b, transparent: true, opacity: 0.38, depthWrite: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.5, 24), metal);
    cone.rotation.x = -Math.PI / 2; cone.position.z = 1.75;        // tip at z = 0
    const body = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 7), block);
    body.position.z = 3.5 + 3.5;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5a1f }));
    headGroup.add(cone, body, tip);
    headGroup.userData.body = body;
  }
  buildHead();
  const beamMat = new THREE.MeshLambertMaterial({ color: 0x5b626b, transparent: true, opacity: 0.28, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 4), beamMat);
  gantry.add(beam);

  function bedTexture(w, h) {
    const px = 4, cw = Math.min(2048, Math.ceil(w * px)), ch = Math.min(2048, Math.ceil(h * px));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.fillStyle = '#2b2f35'; g.fillRect(0, 0, cw, ch);
    const sx = cw / w, sy = ch / h;
    for (let mm = 0; mm <= Math.max(w, h); mm += 10) {
      const major = mm % 50 === 0;
      g.strokeStyle = major ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.09)';
      g.lineWidth = major ? 2 : 1;
      if (mm <= w) { g.beginPath(); g.moveTo(mm * sx, 0); g.lineTo(mm * sx, ch); g.stroke(); }
      if (mm <= h) { g.beginPath(); g.moveTo(0, ch - mm * sy); g.lineTo(cw, ch - mm * sy); g.stroke(); }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }
  function buildBed(bed) {
    if (bedMesh) { bedGroup.remove(bedMesh); bedMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    const w = bed.x1 - bed.x0, h = bed.y1 - bed.y0;
    const shape = new THREE.Shape(bed.poly.map(p => new THREE.Vector2(p[0], p[1])));
    const geo = new THREE.ShapeGeometry(shape);
    // UVs across the bounding box so the grid texture lines up with bed millimetres
    const pos = geo.attributes.position, uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { uv[i * 2] = (pos.getX(i) - bed.x0) / w; uv[i * 2 + 1] = (pos.getY(i) - bed.y0) / h; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mat = new THREE.MeshBasicMaterial({ map: bedTexture(w, h) });
    const plate = new THREE.Mesh(geo, mat);
    plate.position.z = -0.05;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 6, h + 6, 4), new THREE.MeshLambertMaterial({ color: 0x1a1d21 }));
    slab.position.set(bed.x0 + w / 2, bed.y0 + h / 2, -2.1);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.ShapeGeometry(shape)),
                                        new THREE.LineBasicMaterial({ color: 0x8a939c }));
    edge.position.z = 0.01;
    bedMesh = new THREE.Group(); bedMesh.add(slab, plate, edge);
    bedGroup.add(bedMesh);
    beam.scale.set(w + 40, 1, 1);
  }

  /* ------------------------------------------------------------------ path buffers */
  const R = {                    // render state built per job
    segMove: null,              // Uint32Array: extrusion segment -> move index
    extPrefix: null,            // Uint32Array(moves+1): extrusion segments completed before move k
    travelPrefix: null,         // Uint32Array(moves+1): travel segments before move k
    pos: null, col: null,       // Float32Array 6 per segment
    main: null,                 // object rendering every segment, progressively revealed
    layerObj: null, layerObjLayer: -1,
    partial: null,              // the segment being printed right now
    travel: null,
  };
  let lineMat = null, lineMatPartial = null, thinMat = null;
  function lineWidth() { return Math.max(0.2, (job && job.machine.nozzle) ? job.machine.nozzle * 1.05 : 0.42); }

  function makeLines(pos, col, count, bead) {
    if (prefs.lines === 'thin') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setDrawRange(0, count * 2);
      const o = new THREE.LineSegments(g, thinMat); o.frustumCulled = false;
      o.userData.thin = true; return o;
    }
    const g = new THREE.LineSegmentsGeometry();
    g.setPositions(pos); g.setColors(col);
    g.setAttribute('instanceBead', new THREE.InstancedBufferAttribute(bead, 2));
    g.instanceCount = count;
    const o = new THREE.LineSegments2(g, lineMat); o.frustumCulled = false;
    return o;
  }
  function setCount(o, count) {
    if (!o) return;
    if (o.userData.thin) o.geometry.setDrawRange(0, count * 2);
    else o.geometry.instanceCount = count;
  }
  function disposeObj(o) { if (!o) return; bedGroup.remove(o); o.geometry.dispose(); }

  /* LineMaterial already finds, per pixel, how far the view ray passes from the line's axis
     (WORLD_UNITS mode). That is exactly a cylinder: turn the distance into a surface normal and
     light it, so extrusions read as round beads instead of flat ribbons. */
  const shadeUniform = { value: 1 };
  /* Each segment carries its own cross-section (instanceBead = width, height in mm): the bead is an
     ellipse-ish tube, wide across and as tall as the line really is. The quad is sized by the
     ellipse's extent across the view, and the fragment test and the lighting normal use the same
     ellipse, so scarf ramps and Z-contoured lines show their real thickness from the side. */
  const BEAD_VS_PARS = `
    attribute vec2 instanceBead;
    varying vec2 vBead;
    varying vec3 vUp;
    varying vec3 vSide;
    float beadRadius( vec3 dir ) {
      float a = 0.5 * vBead.x * dot( dir, vSide ), b = 0.5 * vBead.y * dot( dir, vUp );
      return max( sqrt( a * a + b * b ), 1e-4 );
    }`;
  const BEAD_FS_PARS = `
    varying vec2 vBead;
    varying vec3 vUp;
    varying vec3 vSide;
    float beadRadius( vec3 dir ) {
      float a = 0.5 * vBead.x * dot( dir, vSide ), b = 0.5 * vBead.y * dot( dir, vUp );
      return max( sqrt( a * a + b * b ), 1e-4 );
    }`;
  function shadedLineMaterial() {
    const m = new THREE.LineMaterial({ vertexColors: true, worldUnits: true, linewidth: 0.42 });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.shadeMode = shadeUniform;
      const vs = shader.vertexShader;
      shader.vertexShader = vs
        .replace('attribute vec3 instanceEnd;', 'attribute vec3 instanceEnd;' + BEAD_VS_PARS)
        .replace('if ( position.x < 0.0 ) offset *= - 1.0;\n\n\t\t\t\tfloat forwardOffset', `if ( position.x < 0.0 ) offset *= - 1.0;
          vBead = instanceBead;
          vUp = normalize( ( modelViewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
          vSide = cross( vUp, worldDir );
          vSide = length( vSide ) > 1e-4 ? normalize( vSide ) : normalize( cross( worldDir, vec3( 1.0, 0.0, 0.0 ) ) );
          float beadR = beadRadius( offset );
          float beadCap = 0.5 * vBead.x;

\t\t\t\tfloat forwardOffset`)
        .replace('start.xyz += - worldDir * linewidth * 0.5;', 'start.xyz += - worldDir * beadCap;')
        .replace('end.xyz += worldDir * linewidth * 0.5;', 'end.xyz += worldDir * beadCap;')
        .replace('offset *= linewidth * 0.5;', 'offset *= beadR;');
      if (shader.vertexShader.indexOf('offset *= beadR;') < 0 || shader.vertexShader.indexOf('float beadR') < 0)
        console.warn('Playback: line shader layout changed; per-line widths are off');
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform float shadeMode;' + BEAD_FS_PARS)
        .replace('float norm = len / linewidth;', `vec3 beadDir = len > 1e-6 ? delta / len : vSide;
				float beadRs = beadRadius( beadDir );
				float norm = len / ( 2.0 * beadRs );`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef WORLD_UNITS
          if ( shadeMode > 0.5 ) {
            float r = beadRs;
            float s = clamp( len / r, 0.0, 1.0 );
            vec3 ld = normalize( lineDir );
            vec3 toCam = -normalize( p2 );
            vec3 c = toCam - dot( toCam, ld ) * ld;
            c = length( c ) > 1e-5 ? normalize( c ) : toCam;
            vec3 side = len > 1e-6 ? -delta / len : vec3( 0.0 );
            vec3 N = normalize( side * s + c * sqrt( max( 0.0, 1.0 - s * s ) ) );
            // round tube -> elliptical bead: normals scale by the inverse of the half-axes
            float ns = dot( N, vSide ), nu = dot( N, vUp );
            float ra = max( 0.5 * vBead.x, 1e-3 ), rb = max( 0.5 * vBead.y, 1e-3 ), rm = max( ra, rb );
            N = normalize( ( N - ns * vSide - nu * vUp ) + vSide * ( ns * rm / ra ) + vUp * ( nu * rm / rb ) );
            vec3 L = normalize( vec3( -0.35, 0.6, 0.72 ) );
            float diff = max( dot( N, L ), 0.0 );
            float spec = pow( max( dot( N, normalize( L + toCam ) ), 0.0 ), 36.0 ) * 0.22;
            diffuseColor.rgb = diffuseColor.rgb * ( 0.34 + 0.76 * diff ) + spec;
          }
        #endif`);
    };
    return m;
  }

  function ensureMaterials() {
    if (!lineMat) {
      lineMat = shadedLineMaterial(); lineMatPartial = shadedLineMaterial();
      thinMat = new THREE.LineBasicMaterial({ vertexColors: true });
    }
    lineMat.linewidth = lineWidth(); lineMatPartial.linewidth = lineWidth();
    resize();
  }

  function buildPaths() {
    const n = job.moves, F = job.flags, P = job.pts;
    let segs = 0, travels = 0;
    for (let k = 0; k < n; k++) { if (F[k] & C.FL_SKIP) continue; if (F[k] & C.FL_EXTRUDE) segs++; else if (F[k] & C.FL_TRAVEL) travels++; }
    const segMove = new Uint32Array(segs), extPrefix = new Uint32Array(n + 1), travelPrefix = new Uint32Array(n + 1);
    const pos = new Float32Array(segs * 6), tpos = new Float32Array(Math.max(1, travels) * 6);
    const bead = new Float32Array(Math.max(1, segs) * 2);
    // "Actual cross-section": each line as wide and tall as the G-code makes it, its centre half its
    // height below the nozzle (where the plastic is). "Uniform": one width, centred on the path.
    const real = prefs.lines !== 'uniform', lw = lineWidth();
    let s = 0, tr = 0;
    for (let k = 0; k < n; k++) {
      extPrefix[k] = s; travelPrefix[k] = tr;
      if (F[k] & C.FL_SKIP) continue;               // blocks the printer won't run are not drawn
      if (F[k] & C.FL_EXTRUDE) {
        segMove[s] = k;
        pos.set(P.subarray(k * 3, k * 3 + 6), s * 6);
        if (real && job.beadW[k] > 0) {
          bead[s * 2] = job.beadW[k]; bead[s * 2 + 1] = job.beadH[k];
          pos[s * 6 + 2] -= job.beadH[k] / 2; pos[s * 6 + 5] -= job.beadH[k] / 2;
        } else { bead[s * 2] = lw; bead[s * 2 + 1] = lw; }
        s++;
      } else if (F[k] & C.FL_TRAVEL) {
        tpos.set(P.subarray(k * 3, k * 3 + 6), tr * 6);
        tr++;
      }
    }
    extPrefix[n] = s; travelPrefix[n] = tr;
    R.segMove = segMove; R.extPrefix = extPrefix; R.travelPrefix = travelPrefix; R.pos = pos; R.bead = bead;
    R.col = new Float32Array(segs * 6);
    computeColors();
    rebuildObjects();
    // travel lines
    if (R.travel) disposeObj(R.travel);
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(tpos, 3)); tg.setDrawRange(0, 0);
    R.travel = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0x4fa3ff, transparent: true, opacity: 0.55 }));
    R.travel.frustumCulled = false;
    bedGroup.add(R.travel);
  }

  function rebuildObjects() {
    ensureMaterials();
    disposeObj(R.main); disposeObj(R.layerObj); disposeObj(R.partial);
    R.main = makeLines(R.pos, R.col, 0, R.bead); bedGroup.add(R.main);
    R.layerObj = null; R.layerObjLayer = -1;
    const pg = new THREE.LineSegmentsGeometry();
    pg.setPositions(new Float32Array(6)); pg.setColors(new Float32Array(6));
    pg.setAttribute('instanceBead', new THREE.InstancedBufferAttribute(new Float32Array(2), 2));
    R.partial = prefs.lines === 'thin'
      ? (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
                 g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3)); const o = new THREE.LineSegments(g, thinMat); o.userData.thin = true; o.frustumCulled = false; return o; })()
      : (() => { const o = new THREE.LineSegments2(pg, lineMatPartial); o.frustumCulled = false; return o; })();
    bedGroup.add(R.partial);
    lastShown = -1;
  }

  /* What's under the cursor, for the camera: the nearest visible line the view ray passes through
     (within its own width, plus a few pixels so thin lines are easy to hit). Returns the world point
     under the cursor at that line's depth, or null. A plain loop over the drawn segments: ~10 ms per million. */
  controls.pick = (rr) => {
    if (!job || !R.pos || !R.segMove.length) return null;
    const off = bedGroup.position;
    const ox = rr.origin.x - off.x, oy = rr.origin.y - off.y, oz = rr.origin.z - off.z;
    const dx = rr.direction.x, dy = rr.direction.y, dz = rr.direction.z;
    const pxAng = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (canvas.clientHeight || 1);
    const done = R.extPrefix[Math.min(curMove, job.moves)] || 0;
    let a = 0, b = done;
    if (prefs.layerOnly && R.layerObj) a = R.layerObj.userData.base;
    const pos = R.pos, bead = R.bead, thin = prefs.lines === 'thin', lw = lineWidth();
    let bestT = Infinity, bx = 0, by = 0, bz = 0;
    for (let s = a; s < b; s++) {
      const i = s * 6;
      const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
      const ux = pos[i + 3] - ax, uy = pos[i + 4] - ay, uz = pos[i + 5] - az;
      // closest points between the ray o + t d and the segment a + u v, v in [0, 1]
      const wx = ox - ax, wy = oy - ay, wz = oz - az;
      const uu = ux * ux + uy * uy + uz * uz, ud = ux * dx + uy * dy + uz * dz;
      const uw = ux * wx + uy * wy + uz * wz, dw = dx * wx + dy * wy + dz * wz;
      const den = uu - ud * ud;
      let v = den > 1e-12 ? (uw - ud * dw) / den : 0;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const px = ax + ux * v, py = ay + uy * v, pz = az + uz * v;
      let t = (px - ox) * dx + (py - oy) * dy + (pz - oz) * dz;
      if (t <= 0 || t >= bestT) continue;
      const ex = ox + dx * t - px, ey = oy + dy * t - py, ez = oz + dz * t - pz;
      const rb = thin ? 0.05 : (bead ? Math.max(bead[s * 2], bead[s * 2 + 1]) : lw) * 0.5;
      const r = rb + t * pxAng * 4, e2 = ex * ex + ey * ey + ez * ez;
      if (e2 > r * r) continue;
      // the spot on the view ray closest to that line (under the cursor, at the line's depth), pulled
      // onto the line itself when the ray only passed near it, so zooming in ends on the plastic
      const k = e2 > rb * rb ? rb / Math.sqrt(e2) : 1;
      bestT = t; bx = px + ex * k; by = py + ey * k; bz = pz + ez * k;
    }
    return bestT < Infinity ? new THREE.Vector3(bx + off.x, by + off.y, bz + off.z) : null;
  };

  /* colour by the selected mode; also fills the legend */
  let colorRange = null;
  function percentile(vals, p) {
    if (!vals.length) return 0;
    const a = Float32Array.from(vals).sort(); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  }
  function computeColors() {
    const mode = prefs.color, segs = R.segMove.length, col = R.col, rgb = [0, 0, 0];
    const filArea = Math.PI * Math.pow(job.machine.filamentDiameter / 2, 2);
    const filColors = String(job.config.filament_colour || job.config.extruder_colour || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const filRGB = filColors.map(hexRGB);
    let value = null, unit = '';
    if (mode === 'speed') { value = (k) => job.vp[k]; unit = 'mm/s'; }
    else if (mode === 'fcmd') { value = (k) => job.fcmd[k]; unit = 'mm/s'; }
    else if (mode === 'flow') { value = (k) => job.plannerDur[k] > 0 ? job.de[k] * filArea / job.plannerDur[k] : 0; unit = 'mm³/s'; }
    else if (mode === 'layertime') { value = (k) => { const L = job.layers[job.layer[k]]; return L ? L.t1 - L.t0 : 0; }; unit = 's'; }
    else if (mode === 'beadh') { value = (k) => job.beadH[k]; unit = 'mm'; }
    else if (mode === 'beadw') { value = (k) => job.beadW[k]; unit = 'mm'; }
    colorRange = null;
    if (value) {
      const sample = []; const stride = Math.max(1, Math.floor(segs / 20000));
      for (let s = 0; s < segs; s += stride) sample.push(value(R.segMove[s]));
      let lo = percentile(sample, 0.01), hi = percentile(sample, 0.99);
      if (mode === 'beadh') {
        // thinned lines (scarf ramps, Z contouring) are a small share of a print: scale from 0 so they stand out
        lo = 0; hi = Math.max(percentile(sample, 0.995), 0.05);
      } else if (mode === 'beadw' && hi - lo < 0.02) {
        const mid = percentile(sample, 0.5); lo = mid * 0.75; hi = mid * 1.25;
      }
      if (hi - lo < 1e-6) { hi = lo + 1; }
      colorRange = { lo, hi, unit };
      for (let s = 0; s < segs; s++) {
        rampRGB((value(R.segMove[s]) - lo) / (hi - lo), rgb);
        col[s * 6] = col[s * 6 + 3] = rgb[0]; col[s * 6 + 1] = col[s * 6 + 4] = rgb[1]; col[s * 6 + 2] = col[s * 6 + 5] = rgb[2];
      }
    } else {
      for (let s = 0; s < segs; s++) {
        const k = R.segMove[s];
        const c = mode === 'filament' ? (filRGB[job.tool[k]] || FEAT_RGB[0]) : FEAT_RGB[featVisible[job.feat[k]] === false ? 0 : job.feat[k]];
        col[s * 6] = col[s * 6 + 3] = c[0]; col[s * 6 + 1] = col[s * 6 + 4] = c[1]; col[s * 6 + 2] = col[s * 6 + 5] = c[2];
      }
    }
    applyShade();
    renderLegend(filColors);
  }
  function applyShade() {
    shadeUniform.value = (prefs.shade === 'tube' || prefs.shade === 'layers') ? 1 : 0;
    const col = R.col, segs = R.segMove.length;
    if (prefs.shade === 'layers') {
      // alternate layers slightly brighter / darker so individual layers are easy to count
      for (let s = 0; s < segs; s++) {
        const f = (job.layer[R.segMove[s]] & 1) ? 0.84 : 1.06;
        for (let q = 0; q < 6; q++) col[s * 6 + q] = Math.min(1, col[s * 6 + q] * f);
      }
    } else if (prefs.shade === 'height') {
      const z0 = job.bed.model.minZ, z1 = Math.max(z0 + 1e-3, job.bed.model.maxZ), P = job.pts;
      for (let s = 0; s < segs; s++) {
        const z = P[R.segMove[s] * 3 + 5];
        const f = 0.45 + 0.6 * Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
        for (let q = 0; q < 6; q++) col[s * 6 + q] = Math.min(1, col[s * 6 + q] * f);
      }
    }
    dirty = true;
  }
  const featVisible = {};

  function renderLegend(filColors) {
    const el = $('legend'); const mode = prefs.color;
    let html = '';
    if (mode === 'feature') {
      const used = new Set(); for (let s = 0; s < R.segMove.length; s += 7) used.add(job.feat[R.segMove[s]]);
      html = '<h4>Line type</h4>' + C.FEATURES.map((f, i) => used.has(i)
        ? '<div class="row"><span class="sw" style="background:' + f[1] + '"></span>' + f[0] + '</div>' : '').join('');
    } else if (mode === 'filament') {
      const used = new Set(); for (let s = 0; s < R.segMove.length; s += 7) used.add(job.tool[R.segMove[s]]);
      html = '<h4>Filament</h4>' + [...used].sort((a, b) => a - b).map(t =>
        '<div class="row"><span class="sw" style="background:' + (filColors[t] || '#9aa3ab') + '"></span>Filament ' + (t + 1) + '</div>').join('');
    } else if (colorRange) {
      const title = { speed: 'Actual speed (peak)', fcmd: 'Set speed', flow: 'Volumetric flow', layertime: 'Layer time',
                      beadh: 'Line height', beadw: 'Line width' }[mode];
      const f = (v) => (colorRange.unit === 'mm' ? v.toFixed(2) : v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + colorRange.unit;
      html = '<h4>' + title + '</h4><div class="grad" style="background:linear-gradient(90deg,' + RANGE.join(',') + ')"></div>' +
             '<div class="ends"><span>' + f(colorRange.lo) + '</span><span>' + f(colorRange.hi) + '</span></div>';
    }
    el.innerHTML = html; el.hidden = !html || !job;
  }

  /* ------------------------------------------------------------------ playback state */
  let job = null, gcodeText = null, lineStarts = null, currentMeta = {};
  let simT = 0, playing = false, lastFrame = 0, lastShown = -1, dirty = true;
  // Live mode: the playback clock follows the real printer (see "live printer" below)
  let live = false, liveRef = null, printerOn = false, printerSt = null, warnedFile = '';
  let curMove = 0;
  let hudTimer = 0;
  const bedCenter = new THREE.Vector3();

  function bedSlinger() {
    if (prefs.motion === 'bed') return true;
    if (prefs.motion === 'head') return false;
    return !!(job && job.bed.bedSlinger);
  }

  function nozzleAt(t) {
    const k = C.moveAt(job, t);
    const st = C.stateIn(job, k, t);
    const P = job.pts, a = k * 3;
    return { k, frac: st.frac, v: st.v,
             x: P[a] + (P[a + 3] - P[a]) * st.frac, y: P[a + 1] + (P[a + 4] - P[a + 1]) * st.frac, z: P[a + 2] + (P[a + 5] - P[a + 2]) * st.frac };
  }

  function setLayerOnlyObject(layerIdx) {
    if (R.layerObjLayer === layerIdx && R.layerObj) return;
    disposeObj(R.layerObj); R.layerObj = null; R.layerObjLayer = layerIdx;
    const L = job.layers[layerIdx]; if (!L) return;
    const a = R.extPrefix[L.first], b = R.extPrefix[layerIdx + 1 < job.layers.length ? job.layers[layerIdx + 1].first : job.moves];
    const pos = R.pos.slice(a * 6, b * 6), col = R.col.slice(a * 6, b * 6), bead = R.bead.slice(a * 2, Math.max(a + 1, b) * 2);
    R.layerObj = makeLines(pos, col, 0, bead); R.layerObj.userData.base = a;
    bedGroup.add(R.layerObj);
  }

  const tmpCol = [0, 0, 0];
  function updateScene(force) {
    if (!job) return;
    const nz = nozzleAt(simT);
    curMove = nz.k;
    const F = job.flags;
    const done = R.extPrefix[nz.k];           // segments fully printed before this move
    const layerIdx = job.layer[nz.k];

    if (prefs.layerOnly) {
      R.main.visible = false;
      setLayerOnlyObject(layerIdx);
      if (R.layerObj) { R.layerObj.visible = true; setCount(R.layerObj, Math.max(0, done - R.layerObj.userData.base)); }
    } else {
      R.main.visible = true; if (R.layerObj) R.layerObj.visible = false;
      if (done !== lastShown || force) { setCount(R.main, done); lastShown = done; }
    }

    // the segment being extruded right now, drawn up to the nozzle
    if ((F[nz.k] & C.FL_EXTRUDE) && nz.frac > 0) {
      const P = job.pts, a = nz.k * 3, s = done;
      const thin = R.partial.userData.thin;
      const dz = thin ? 0 : R.pos[s * 6 + 2] - P[a + 2];      // same bead offset as the finished line
      const p = new Float32Array([P[a], P[a + 1], P[a + 2] + dz, nz.x, nz.y, nz.z + dz]);
      const c = R.col.slice(s * 6, s * 6 + 6);
      if (thin) {
        R.partial.geometry.attributes.position.array.set(p); R.partial.geometry.attributes.position.needsUpdate = true;
        R.partial.geometry.attributes.color.array.set(c); R.partial.geometry.attributes.color.needsUpdate = true;
      } else {
        R.partial.geometry.setPositions(p); R.partial.geometry.setColors(c);
        const bd = R.partial.geometry.attributes.instanceBead;
        bd.array[0] = R.bead[s * 2]; bd.array[1] = R.bead[s * 2 + 1]; bd.needsUpdate = true;
      }
      R.partial.visible = true;
    } else R.partial.visible = false;

    // travel moves of the current layer up to now
    R.travel.visible = prefs.travel;
    if (prefs.travel) {
      const L = job.layers[layerIdx];
      const a = R.travelPrefix[L ? L.first : 0], b = R.travelPrefix[nz.k + ((F[nz.k] & C.FL_TRAVEL) && nz.frac >= 1 ? 1 : 0)];
      R.travel.geometry.setDrawRange(a * 2, Math.max(0, b - a) * 2);
    }

    // nozzle, bed and gantry
    const slinger = bedSlinger();
    const cy = (job.bed.y0 + job.bed.y1) / 2;
    if (slinger) {
      bedGroup.position.set(0, cy - nz.y, 0);
      headGroup.position.set(nz.x, cy, nz.z);
      gantry.position.set((job.bed.x0 + job.bed.x1) / 2, cy, nz.z + 12);
    } else {
      bedGroup.position.set(0, 0, 0);
      headGroup.position.set(nz.x, nz.y, nz.z);
      gantry.position.set((job.bed.x0 + job.bed.x1) / 2, nz.y, nz.z + 12);
    }
    if (prefs.follow) {
      const target = headGroup.position.clone();
      const delta = target.sub(controls.target).multiplyScalar(0.18);
      controls.target.add(delta); camera.position.add(delta);
    }
    hudState = nz;
    dirty = true;
  }

  let hudState = null;
  function updateHud() {
    if (!job || !hudState) return;
    const nz = hudState, k = nz.k, L = job.layer[k], layer = job.layers[L];
    const startOffset = job.layers[0] && job.layers[0].start ? 1 : 0;
    const layerCount = job.layers.length - startOffset;
    $('hTime').textContent = fmtTime(simT);
    $('hTotal').textContent = fmtTime(job.total);
    $('hRemain').textContent = fmtLong(Math.max(0, job.total - simT));
    if (layer && layer.start) $('hLayer').textContent = 'start G-code';
    else $('hLayer').textContent = (L + 1 - startOffset) + ' / ' + layerCount;
    const lp = layer ? (simT - layer.t0) / Math.max(1e-6, layer.t1 - layer.t0) : 0;
    $('hLayerBar').style.width = Math.round(Math.max(0, Math.min(1, lp)) * 100) + '%';
    $('hZ').textContent = nz.z.toFixed(2) + ' mm' + (layer && layer.h ? '  ·  h ' + layer.h.toFixed(2) : '');
    const F = job.flags[k];
    let kind;
    if (F & C.FL_DWELL) kind = '<span class="muted">Waiting</span>';
    else if (F & C.FL_EONLY) kind = '<span class="muted">' + (job.de[k] < 0 ? 'Retract' : (job.feat[k] === 18 ? 'Flush / purge' : 'Unretract / prime')) + '</span>';
    else if (F & C.FL_TRAVEL) kind = '<span class="muted">Travel</span>';
    else { const f = C.FEATURES[job.feat[k]]; kind = '<span class="dot" style="background:' + f[1] + '"></span>' + f[0]; }
    $('hFeat').innerHTML = kind;
    const slow = job.aligned && job.plannerDur[k] > 0 ? 1 : 1;
    $('hSpeed').textContent = Math.round(nz.v * slow) + ' mm/s';
    $('hSpeedSet').textContent = (F & C.FL_DWELL) ? '' : 'of ' + Math.round(job.fcmd[k]) + ' set';
    const filArea = Math.PI * Math.pow(job.machine.filamentDiameter / 2, 2);
    const flow = (F & C.FL_EXTRUDE) && job.len[k] > 0 ? nz.v * job.de[k] / job.len[k] * filArea : 0;
    $('hFlow').textContent = (F & C.FL_EXTRUDE) ? flow.toFixed(1) + ' mm³/s' : '–';
    $('hBead').textContent = (F & C.FL_EXTRUDE) && job.beadW[k] > 0 ? job.beadW[k].toFixed(2) + ' × ' + job.beadH[k].toFixed(2) + ' mm' : '–';
    $('hAcc').textContent = (F & C.FL_DWELL) ? '–' : Math.round(job.ac[k]) + ' mm/s²';
    const fc = String(job.config.filament_colour || '').split(/[;,]/)[job.tool[k]];
    $('hTool').innerHTML = (fc ? '<span class="dot" style="background:' + fc.trim() + '"></span>' : '') + (job.tool[k] + 1);
    $('hSrc').textContent = sourceLine(job.line[k]);
    if (codeOpen) {
      const cur = job.line[k];
      if (cur !== codeLastCur) { codeLastCur = cur; codeFollowTo(!playing); renderCode(); }
    }
    // bottom bar
    $('cTime').textContent = fmtTime(simT); $('cTotal').textContent = fmtTime(job.total);
    $('cPct').textContent = Math.floor(simT / Math.max(1e-9, job.total) * 100) + '%';
    if (document.activeElement !== $('layerIn')) $('layerIn').value = Math.max(1, L + 1 - startOffset);
    drawTimeline();
  }

  function ensureLineStarts() {
    if (!lineStarts && gcodeText) {
      // index line starts once, lazily
      const starts = [0]; let i = -1;
      while ((i = gcodeText.indexOf('\n', i + 1)) >= 0) starts.push(i + 1);
      if (starts[starts.length - 1] >= gcodeText.length) starts.pop();     // no empty last line
      lineStarts = Uint32Array.from(starts);
    }
    return lineStarts;
  }
  function lineText(no, max) {
    if (!gcodeText || !no || !ensureLineStarts() || no > lineStarts.length) return '';
    const a = lineStarts[no - 1], b = no < lineStarts.length ? lineStarts[no] - 1 : gcodeText.length;
    return gcodeText.substring(a, Math.min(b, a + (max || 200))).replace(/\r$/, '');
  }
  function sourceLine(no) { return no ? no + ':  ' + lineText(no, 160).trim() : ''; }

  /* ------------------------------------------------------------------ G-code panel
     A virtual list: only the rows in view exist, so a million-line file scrolls as easily as a
     short one. While following, it glides to keep the running line centred; scrolling by hand
     pauses following until "Follow" is pressed again. Clicking a line seeks to it. */
  const ROW = 18, MAX_SCROLL_H = 1.2e7;
  const codeScroll = $('codeScroll'), codeRows = $('codeRows'), codeSpacer = $('codeSpacer');
  let codeOpen = false, codeFollow = true, codeTarget = null, codeLastCur = -1, flashLine = 0, flashUntil = 0;
  function codeCount() { return ensureLineStarts() ? lineStarts.length : 0; }
  function codeGeom() {
    const n = codeCount(), view = codeScroll.clientHeight || 288;
    const realH = n * ROW, H = Math.min(realH, MAX_SCROLL_H), vis = Math.floor(view / ROW);
    return { n, view, H, scaled: realH > MAX_SCROLL_H, vis };
  }
  function firstLineAt(top, g) {      // 0-based index of the first row shown for a scrollTop
    if (!g.scaled) return Math.floor(top / ROW);
    return Math.round(top / Math.max(1, g.H - g.view) * Math.max(0, g.n - g.vis));
  }
  function scrollTopFor(first, g) {
    first = Math.max(0, Math.min(Math.max(0, g.n - g.vis), first));
    if (!g.scaled) return first * ROW;
    return first / Math.max(1, g.n - g.vis) * Math.max(1, g.H - g.view);
  }
  const escHtml = (t) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function highlight(t) {
    let code = t, comment = '';
    const c = t.indexOf(';'); if (c >= 0) { code = t.substring(0, c); comment = t.substring(c); }
    let html = escHtml(code).replace(/^(\s*)([GMT]\d+(?:\.\d+)?)/i, (m, sp, cmd) =>
      sp + '<span class="' + (/^[mt]/i.test(cmd) ? 'km' : 'k') + '">' + cmd + '</span>');
    html = html.replace(/(\s)([XYZEFIJRSP])(?=[-\d.])/g, '$1<span class="a">$2</span>');
    if (comment) html += '<span class="c">' + escHtml(comment) + '</span>';
    return html;
  }
  function renderCode() {
    if (!codeOpen || !job) return;
    const g = codeGeom();
    codeSpacer.style.height = g.H + 'px';
    const top = codeScroll.scrollTop, first = firstLineAt(top, g);
    const offset = g.scaled ? top : first * ROW;
    const cur = job.line[curMove] || 0;
    let html = '';
    for (let i = first; i < Math.min(g.n, first + g.vis + 3); i++) {
      const no = i + 1;
      html += '<div class="ln' + (no === cur ? ' cur' : no < cur ? ' past' : '') + (no === flashLine && performance.now() < flashUntil ? ' flash' : '') + '" data-line="' + no + '"><span class="no">' + no +
              '</span><span class="tx">' + highlight(lineText(no, 220)) + '</span></div>';
    }
    codeRows.style.transform = 'translateY(' + offset + 'px)';
    codeRows.innerHTML = html;
    $('codeInfo').textContent = 'Line ' + (cur || '–') + ' of ' + g.n.toLocaleString();
  }
  /* Following keeps the running line pinned to the middle row. While playing it moves straight
     there (an eased glide falls behind at high speeds and the highlight drifts out of view);
     the glide is only used for one-off jumps, such as pressing Follow. */
  function codeFollowTo(animate) {
    if (!codeOpen || !codeFollow || !job) return;
    const g = codeGeom(), cur = (job.line[curMove] || 1) - 1;
    const target = scrollTopFor(cur - Math.floor((g.vis - 1) / 2), g);
    if (!animate || playing || Math.abs(target - codeScroll.scrollTop) > g.view * 40) { setCodeScroll(target); codeTarget = null; }
    else codeTarget = target;
  }
  function setCodeScroll(v) { codeScroll.scrollTop = v; renderCode(); }
  function stepCodeScroll() {      // called every animation frame: ease towards the target
    if (codeTarget == null || !codeOpen) return;
    const cur = codeScroll.scrollTop, d = codeTarget - cur;
    if (Math.abs(d) < 0.6) { setCodeScroll(codeTarget); codeTarget = null; return; }
    setCodeScroll(cur + d * 0.22);
  }
  function setFollow(on) {
    codeFollow = on; $('codeFollow').classList.toggle('on', on);
    $('codeFollow').textContent = on ? 'Following' : 'Follow';
    if (on) codeFollowTo(true);
  }
  function setCodeOpen(open) {
    codeOpen = open && !!job;
    $('codePanel').classList.toggle('open', codeOpen);
    $('codePanel').setAttribute('aria-hidden', String(!codeOpen));
    $('codeToggle').setAttribute('aria-expanded', String(codeOpen));
    if (codeOpen) { renderCode(); setFollow(true); codeFollowTo(false); }
  }
  $('codeToggle').onclick = () => setCodeOpen(!codeOpen);
  $('codeFollow').onclick = () => setFollow(true);
  codeScroll.addEventListener('scroll', renderCode);
  // only real user input stops following (programmatic scrolls must not)
  const userScrolled = () => { if (codeFollow) setFollow(false); codeTarget = null; };
  codeScroll.addEventListener('wheel', userScrolled, { passive: true });
  codeScroll.addEventListener('touchstart', userScrolled, { passive: true });
  codeScroll.addEventListener('pointerdown', (e) => { if (e.target === codeScroll) userScrolled(); });   // scrollbar drag
  codeScroll.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) { e.stopPropagation(); userScrolled(); }
  });
  codeRows.addEventListener('click', (e) => {
    const row = e.target.closest('.ln'); if (!row || !job) return;
    const no = parseInt(row.dataset.line, 10);
    // the first move at or after this line; comments and settings jump to the move that follows
    const L = job.line; let lo = 0, hi = job.moves - 1;
    if (!(hi >= 0)) return;
    if (no > L[hi]) { seek(job.total); }
    else {
      while (lo < hi) { const mid = (lo + hi) >> 1; if (L[mid] < no) lo = mid + 1; else hi = mid; }
      seek(job.t0[lo] + (job.dur[lo] > 0 ? Math.min(1e-4, job.dur[lo] / 2) : 0));
    }
    flashLine = no; flashUntil = performance.now() + 600;
    renderCode();
  });

  /* ------------------------------------------------------------------ timeline */
  const tlc = $('tlc'), tg = tlc.getContext('2d');
  let tlHover = -1;
  function drawTimeline() {
    const dpr = window.devicePixelRatio || 1, w = tlc.clientWidth, h = tlc.clientHeight;
    if (tlc.width !== Math.round(w * dpr) || tlc.height !== Math.round(h * dpr)) { tlc.width = Math.round(w * dpr); tlc.height = Math.round(h * dpr); }
    tg.setTransform(dpr, 0, 0, dpr, 0, 0);
    tg.clearRect(0, 0, w, h);
    const fg = cssVar('--fg', '#ddd'), accent = cssVar('--accent', '#009688');
    const trackY = 14, trackH = 12;
    tg.fillStyle = 'rgba(127,137,142,.18)';
    roundRect(tg, 0, trackY, w, trackH, 6); tg.fill();
    if (!job) return;
    const X = (t) => (t / Math.max(1e-9, job.total)) * w;
    // layer bands: alternating shades, so long layers read as long
    for (let i = 0; i < job.layers.length; i++) {
      const L = job.layers[i]; const x0 = X(L.t0), x1 = X(L.t1);
      if (i % 2) { tg.fillStyle = 'rgba(127,137,142,.12)'; tg.fillRect(x0, trackY, Math.max(0.5, x1 - x0), trackH); }
    }
    tg.save(); roundRect(tg, 0, trackY, w, trackH, 6); tg.clip();
    tg.fillStyle = accent; tg.globalAlpha = 0.85; tg.fillRect(0, trackY, X(simT), trackH); tg.globalAlpha = 1; tg.restore();
    // layer ticks
    const n = job.layers.length, every = n > 400 ? 50 : n > 150 ? 20 : n > 50 ? 10 : 5;
    tg.fillStyle = fg; tg.globalAlpha = 0.35;
    const startOffset = job.layers[0] && job.layers[0].start ? 1 : 0;
    for (let i = startOffset; i < n; i++) {
      const num = i + 1 - startOffset;
      if (num % every) continue;
      const x = X(job.layers[i].t0); tg.fillRect(x, trackY + trackH, 1, 4);
    }
    tg.globalAlpha = 1;
    // events
    const filColors = String(job.config.filament_colour || '').split(/[;,]/);
    for (const ev of job.events) {
      const t = ev.move < job.moves ? job.t0[ev.move] : job.total, x = X(t);
      tg.fillStyle = ev.kind === 'pause' ? '#d9534f' : ev.kind === 'heat' ? '#e0913a' : (filColors[ev.tool] || '#7fb2ff').trim();
      tg.beginPath(); tg.moveTo(x, trackY - 1); tg.lineTo(x - 5, trackY - 9); tg.lineTo(x + 5, trackY - 9); tg.closePath(); tg.fill();
      tg.strokeStyle = 'rgba(0,0,0,.4)'; tg.lineWidth = 1; tg.stroke();
    }
    // playhead
    const px = X(simT);
    tg.fillStyle = fg; tg.fillRect(Math.round(px) - 1, trackY - 3, 2, trackH + 6);
    if (tlHover >= 0) { tg.fillStyle = fg; tg.globalAlpha = .4; tg.fillRect(Math.round(tlHover), trackY, 1, trackH); tg.globalAlpha = 1; }
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }
  function timeAtX(clientX) {
    const r = tlc.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (job ? job.total : 0);
  }
  let dragging = false;
  $('tl').addEventListener('pointerdown', (e) => { if (!job) return; dragging = true; $('tl').setPointerCapture(e.pointerId); seek(timeAtX(e.clientX)); });
  $('tl').addEventListener('pointermove', (e) => {
    if (!job) return;
    const r = tlc.getBoundingClientRect(); tlHover = e.clientX - r.left;
    const t = timeAtX(e.clientX);
    if (dragging) seek(t);
    const k = C.moveAt(job, t), L = job.layer[k], so = job.layers[0] && job.layers[0].start ? 1 : 0;
    const ev = job.events.find(ev => Math.abs(((ev.move < job.moves ? job.t0[ev.move] : job.total) - t) / job.total * r.width) < 6);
    const tip = $('tip'); tip.style.display = 'block'; tip.style.left = Math.max(60, Math.min(r.width - 60, tlHover)) + 'px';
    tip.textContent = fmtTime(t) + '  ·  ' + (job.layers[L] && job.layers[L].start ? 'start' : 'layer ' + (L + 1 - so)) + (ev ? '  ·  ' + ev.label : '');
    drawTimeline();
  });
  $('tl').addEventListener('pointerup', () => { dragging = false; });
  $('tl').addEventListener('pointerleave', () => { tlHover = -1; $('tip').style.display = 'none'; drawTimeline(); });

  /* ------------------------------------------------------------------ transport */
  function seek(t) {
    if (!job) return;
    if (live) setLive(false);
    simT = Math.max(0, Math.min(job.total, t));
    updateScene(true); updateHud();
  }
  function setPlaying(p) {
    if (!job) p = false;
    if (p && live) setLive(false);
    if (p && simT >= job.total - 1e-6) simT = 0;
    playing = p; lastFrame = performance.now();
    $('playIco').innerHTML = p ? '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>'
                               : '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>';
  }
  function stepMove(dir) {
    if (!job) return; setPlaying(false);
    let k = C.moveAt(job, simT);
    if (dir > 0) { k++; while (k < job.moves - 1 && job.dur[k] <= 0) k++; seek(k < job.moves ? job.t0[k] + job.dur[k] : job.total); }
    else { const atStart = simT - job.t0[k] < 1e-6; k = atStart ? k - 1 : k; while (k > 0 && job.dur[k] <= 0) k--; seek(Math.max(0, job.t0[Math.max(0, k)])); }
  }
  function stepLayer(dir) {
    if (!job) return;
    // layer steps land on the end of a layer, so the layer is shown complete
    const L = job.layer[C.moveAt(job, simT)];
    const endOf = (i) => Math.max(job.layers[i].t0, job.layers[i].t1 - 1e-4);
    if (dir > 0) {
      if (simT < endOf(L) - 1e-3) seek(endOf(L));
      else seek(L + 1 < job.layers.length ? endOf(L + 1) : job.total);
    } else seek(L > 0 ? endOf(L - 1) : 0);
  }
  function gotoLayer(num) {
    if (!job) return;
    const so = job.layers[0] && job.layers[0].start ? 1 : 0;
    const i = Math.max(0, Math.min(job.layers.length - 1, num - 1 + so));
    seek(job.layers[i].t1 - 1e-6);
  }
  $('play').onclick = () => setPlaying(!playing);
  $('bStart').onclick = () => { setPlaying(false); seek(0); };
  $('bEnd').onclick = () => { setPlaying(false); seek(job ? job.total : 0); };
  $('bPrevM').onclick = () => stepMove(-1);
  $('bNextM').onclick = () => stepMove(1);
  $('bPrevL').onclick = () => stepLayer(-1);
  $('bNextL').onclick = () => stepLayer(1);
  $('layerIn').addEventListener('change', () => gotoLayer(parseInt($('layerIn').value, 10) || 1));
  /* Playback speed: presets, or any multiplier typed into the custom box (0.01× – 10000×). */
  const presetSpeeds = () => [...$('speedSel').options].map(o => parseFloat(o.value)).filter(v => isFinite(v));
  const fmtSpeed = (v) => (Math.round(v * 1000) / 1000) + '×';
  function showSpeed() {
    const isPreset = presetSpeeds().some(v => Math.abs(v - prefs.speed) < 1e-9);
    $('speedSel').value = isPreset ? String(presetSpeeds().find(v => Math.abs(v - prefs.speed) < 1e-9)) : 'custom';
    $('speedCustomWrap').hidden = isPreset;
    if (!isPreset && document.activeElement !== $('speedCustom')) $('speedCustom').value = prefs.speed;
  }
  function setSpeed(v, announce) {
    if (!isFinite(v) || v <= 0) return;
    prefs.speed = Math.min(10000, Math.max(0.01, v)); savePrefs(); showSpeed();
    if (announce) toast('Playback ' + fmtSpeed(prefs.speed));
  }
  $('speedSel').onchange = () => {
    if ($('speedSel').value === 'custom') {
      $('speedCustomWrap').hidden = false; $('speedCustom').value = prefs.speed; $('speedCustom').focus(); $('speedCustom').select();
    } else setSpeed(parseFloat($('speedSel').value));
  };
  $('speedCustom').addEventListener('change', () => setSpeed(parseFloat($('speedCustom').value)));
  $('speedCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') { setSpeed(parseFloat($('speedCustom').value)); $('speedCustom').blur(); } });
  function bumpSpeed(dir) {
    // the next preset above (or below) the current speed, custom values included
    const opts = presetSpeeds().sort((p, q) => p - q);
    const next = dir > 0 ? opts.find(v => v > prefs.speed + 1e-9) : [...opts].reverse().find(v => v < prefs.speed - 1e-9);
    if (next != null) setSpeed(next, true);
  }

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (X.open) return;
    switch (e.key) {
      case 'e': case 'E': if (job) { e.preventDefault(); openExport(); } break;
      case ' ': e.preventDefault(); setPlaying(!playing); break;
      case 'ArrowRight': e.preventDefault(); stepMove(1); break;
      case 'ArrowLeft': e.preventDefault(); stepMove(-1); break;
      case 'ArrowUp': e.preventDefault(); stepLayer(1); break;
      case 'ArrowDown': e.preventDefault(); stepLayer(-1); break;
      case 'Home': setPlaying(false); seek(0); break;
      case 'End': setPlaying(false); seek(job ? job.total : 0); break;
      case '+': case '=': bumpSpeed(1); break;
      case '-': case '_': bumpSpeed(-1); break;
      case 't': case 'T': toggle('travel', $('tTravel')); break;
      case 'l': case 'L': toggle('layerOnly', $('tLayer')); break;
      case 'f': case 'F': toggle('follow', $('tFollow')); break;
      case 'g': case 'G': setCodeOpen(!codeOpen); break;
    }
  });

  /* ------------------------------------------------------------------ options */
  function toggle(key, btn) { prefs[key] = !prefs[key]; btn.classList.toggle('on', prefs[key]); savePrefs(); updateScene(true); }
  function syncOptionUI() {
    $('tTravel').classList.toggle('on', prefs.travel); $('tLayer').classList.toggle('on', prefs.layerOnly);
    $('tFollow').classList.toggle('on', prefs.follow);
    $('colorSel').value = prefs.color; $('motionSel').value = prefs.motion; $('lineSel').value = prefs.lines;
    $('timingSel').value = prefs.timing; showSpeed();
    $('pauseLeaveChk').checked = prefs.pauseOnLeave !== false;
    $('headChk').checked = prefs.head !== false; $('gantryChk').checked = prefs.gantry !== false;
    $('shadeSel').value = prefs.shade || 'tube';
    headGroup.visible = prefs.head !== false; gantry.visible = prefs.gantry !== false;
  }
  $('optBtn').onclick = (e) => { e.stopPropagation(); $('optPanel').hidden = !$('optPanel').hidden; $('optBtn').classList.toggle('on', !$('optPanel').hidden); };
  document.addEventListener('pointerdown', (e) => {
    if (!$('optPanel').hidden && !$('optPanel').contains(e.target) && e.target !== $('optBtn') && !$('optBtn').contains(e.target)) {
      $('optPanel').hidden = true; $('optBtn').classList.remove('on');
    }
  });
  (function about() {
    const info = window.PLAYBACK_ABOUT; if (!info) return;
    $('verText').textContent = 'Real G-code Playback v' + info.version;
    const esc = (t) => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    $('changelog').innerHTML = info.entries.map(e => '<h5>v' + esc(e.version) + ' <span>' + esc(e.date || '') + '</span></h5><ul>' +
      e.changes.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>').join('');
    $('logLink').onclick = (ev) => { ev.preventDefault(); $('changelog').hidden = !$('changelog').hidden; };
  })();
  /* Print options found in this G-code (Bambu conditional blocks). Changing one re-reads the file
     with the new choice and keeps the playback position. */
  function renderFlags() {
    const box = $('flagList');
    const found = job && job.flagsFound ? job.flagsFound : [];
    box.hidden = !found.length;
    if (!found.length) { box.innerHTML = ''; return; }
    const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    box.innerHTML = '<div class="flagHead">Print options in this G-code</div>' + found.map(f =>
      '<label class="check" title="' + esc(f.name) + '"><input type="checkbox" data-flag="' + esc(f.name) + '"' + (f.value ? ' checked' : '') + '> ' +
      esc(f.label) + (f.count > 1 ? ' <span class="muted">×' + f.count + '</span>' : '') + '</label>').join('') +
      '<div class="flagNote">Choose them as you will when sending the print. Heating time is not counted.</div>';
    box.querySelectorAll('input[data-flag]').forEach(inp => inp.onchange = () => {
      prefs.flags = Object.assign({}, prefs.flags, { [inp.dataset.flag]: inp.checked }); savePrefs();
      reparse();
    });
  }
  async function reparse() {
    if (!job || !gcodeText) return;
    const frac = simT / Math.max(1e-9, job.total), wasPlaying = playing, before = job.total;
    await loadText(gcodeText, Object.assign({}, currentMeta, { keepFrac: frac, keepView: true }));
    if (job) toast('Print time ' + (job.total < before ? '−' : '+') + fmtLong(Math.abs(job.total - before)) + ' → ' + fmtLong(job.total));
    if (wasPlaying) setPlaying(true);
  }
  $('pauseLeaveChk').onchange = () => { prefs.pauseOnLeave = $('pauseLeaveChk').checked; savePrefs(); };
  $('headChk').onchange = () => { prefs.head = $('headChk').checked; headGroup.visible = prefs.head; savePrefs(); dirty = true; };
  $('gantryChk').onchange = () => { prefs.gantry = $('gantryChk').checked; gantry.visible = prefs.gantry; savePrefs(); dirty = true; };
  $('shadeSel').onchange = () => { prefs.shade = $('shadeSel').value; savePrefs(); recolor(); };
  $('tTravel').onclick = () => toggle('travel', $('tTravel'));
  $('tLayer').onclick = () => toggle('layerOnly', $('tLayer'));
  $('tFollow').onclick = () => toggle('follow', $('tFollow'));
  function recolor() {
    if (!job) return;
    computeColors();
    if (R.main.userData.thin) R.main.geometry.attributes.color.needsUpdate = true; else R.main.geometry.setColors(R.col);
    R.layerObjLayer = -1; updateScene(true);
  }
  $('colorSel').onchange = () => { prefs.color = $('colorSel').value; savePrefs(); recolor(); };
  $('motionSel').onchange = () => { prefs.motion = $('motionSel').value; savePrefs(); updateScene(true); };
  $('lineSel').onchange = () => { prefs.lines = $('lineSel').value; savePrefs(); if (job) { buildPaths(); updateScene(true); } };
  $('timingSel').onchange = () => {
    prefs.timing = $('timingSel').value; savePrefs();
    if (!job) return;
    const frac = simT / job.total;
    C.applyTiming(job, prefs.timing === 'aligned');
    simT = frac * job.total; describeTiming();
    if (prefs.color === 'layertime') { computeColors(); if (R.main.userData.thin) R.main.geometry.attributes.color.needsUpdate = true; else R.main.geometry.setColors(R.col); }
    updateScene(true); updateHud();
  };

  /* ------------------------------------------------------------------ camera */
  function frame(view) {
    if (!job) return;
    const m = job.bed.model, bed = job.bed;
    const cx = (m.minX + m.maxX) / 2, cy = (m.minY + m.maxY) / 2, cz = (m.minZ + m.maxZ) / 2;
    const size = Math.max(m.maxX - m.minX, m.maxY - m.minY, m.maxZ - m.minZ, 20);
    const yOff = bedSlinger() ? bedGroup.position.y : 0;
    const target = new THREE.Vector3(cx, cy + yOff, cz);
    const d = size * 1.7 + 18;
    let dir;
    if (view === 'top') dir = new THREE.Vector3(0, -1e-5, 1);          // straight down, front of the bed at the bottom
    else if (view === 'front') dir = new THREE.Vector3(0, -1, 0.12);
    else if (view === 'bed') { const s = Math.max(bed.x1 - bed.x0, bed.y1 - bed.y0); target.set((bed.x0 + bed.x1) / 2, (bed.y0 + bed.y1) / 2 + yOff, 0); dir = new THREE.Vector3(-0.55, -1, 0.8); return place(target, dir.normalize().multiplyScalar(s * 1.6)); }
    else dir = new THREE.Vector3(-0.6, -1, 0.75);
    place(target, dir.normalize().multiplyScalar(d));
  }
  function place(target, offset) {
    controls.target.copy(target); camera.position.copy(target).add(offset); camera.updateProjectionMatrix(); controls.sync(); controls.update(); dirty = true;
  }
  $('vIso').onclick = () => frame('iso'); $('vTop').onclick = () => frame('top');
  $('vFront').onclick = () => frame('front'); $('vFit').onclick = () => frame('iso');

  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (lineMat) { lineMat.resolution.set(w, h); lineMatPartial.resolution.set(w, h); }
    dirty = true; drawTimeline();
  }
  new ResizeObserver(resize).observe($('stage'));

  function applyTheme() {
    const bg = cssVar('--bg', '#1e2023');
    scene.background = new THREE.Color(bg);
    dirty = true;
  }

  /* ------------------------------------------------------------------ main loop */
  /* Leaving the Playback tab pauses. OrcaSlicer hides the tab's web view, which the page sees as
     visibilitychange; as a second signal, a long gap between animation frames means the view was
     not being drawn (hidden), which is treated the same way. */
  let lastLoop = 0;
  /* OrcaSlicer hides a tab's panel without telling the web view inside it (on Windows the page stays
     "visible" and keeps animating), so visibilitychange alone never fires there. Clicking another tab
     does take keyboard focus away from the page, though: a window blur is treated as leaving, and the
     next focus or pointer movement inside the page as coming back. */
  let away = false;
  function onLeave() {
    away = true;
    if (playing && prefs.pauseOnLeave !== false) setPlaying(false);
  }
  function onReturn() { away = false; send({ cmd: 'check_latest' }); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) onLeave(); else onReturn(); });
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('blur', () => { if (!document.hasFocus()) onLeave(); });
  window.addEventListener('focus', () => { if (away) onReturn(); });
  document.addEventListener('pointermove', () => { if (away && !document.hidden) onReturn(); }, { passive: true });
  document.addEventListener('pointerdown', () => { if (away && !document.hidden) onReturn(); }, true);

  function loop(now) {
    requestAnimationFrame(loop);
    if (lastLoop && now - lastLoop > 1500) {
      // the view was hidden (no frames were drawn). If playback keeps going while away, catch the
      // clock up by the time spent away so the print has progressed when you come back.
      if (playing && prefs.pauseOnLeave === false && job) {
        simT = Math.min(job.total, simT + (now - lastLoop) / 1000 * prefs.speed);
        lastFrame = now; updateScene(true); updateHud();
      }
      onLeave(); onReturn();
    }
    lastLoop = now;
    if (codeOpen && job && playing) {
      const cur = job.line[curMove];
      if (cur !== codeLastCur) { codeLastCur = cur; codeFollowTo(false); renderCode(); }
    }
    stepCodeScroll();
    if (live && job && liveRef) {
      // follow the printer: run at real time from its last report, easing toward it so a corrected
      // estimate does not make the nozzle jump
      const ahead = liveRef.running ? Math.min(120, (now - liveRef.at) / 1000) : 0;
      const target = Math.max(0, Math.min(liveRef.tMax, liveRef.t + ahead));
      const gap = target - simT;
      simT = Math.abs(gap) > 3 ? target : simT + gap * 0.12;
      updateScene(false);
      if (now - hudTimer > 90) { hudTimer = now; updateHud(); }
    }
    if (playing && job) {
      const dt = Math.min(0.25, (now - lastFrame) / 1000); lastFrame = now;
      simT += dt * prefs.speed;
      if (simT >= job.total) { simT = job.total; setPlaying(false); }
      updateScene(false);
      if (now - hudTimer > 90) { hudTimer = now; updateHud(); }
    }
    if (controls.update()) dirty = true;
    if (prefs.follow && job) dirty = true;
    if (dirty) { renderer.render(scene, camera); dirty = false; }
  }

  /* ------------------------------------------------------------------ loading */
  async function loadText(text, meta) {
    meta = meta || {};
    setPlaying(false);
    busy('Reading G-code…', 0); await nextFrame();
    let parsed;
    try {
      parsed = C.parseGcode(text, { flags: prefs.flags || {}, progress: (f) => { $('busyBar').style.width = Math.round(f * 85) + '%'; } });
      busy('Planning motion…', 0.88); await nextFrame();
      C.planJob(parsed, { align: prefs.timing === 'aligned' });
    } catch (err) {
      busy(null); toast('Could not read this G-code: ' + err.message, true); console.error(err); return false;
    }
    if (parsed.moves < 2) { busy(null); toast('No moves found in this file.', true); return false; }
    // a new G-code replacing one on screen (a re-slice) keeps the view and the time, unless the
    // new print is somewhere else on the bed or shorter than the moment being shown
    const prev = job ? { t: simT, model: job.bed.model } : null;
    job = parsed; gcodeText = text; lineStarts = null; codeLastCur = -1; currentMeta = meta;
    if (codeOpen) { codeScroll.scrollTop = 0; }
    busy('Building paths…', 0.95); await nextFrame();
    for (const k in featVisible) delete featVisible[k];
    buildBed(job.bed);
    buildPaths();
    $('empty').style.display = 'none';
    $('hud').hidden = false; $('viewbtns').hidden = false; $('legend').hidden = false; $('expBtn').disabled = false;
    $('fileName').textContent = meta.name || 'G-code';
    const so = job.layers[0] && job.layers[0].start ? 1 : 0;
    $('fileInfo').textContent = (job.layers.length - so) + ' layers · ' + (job.moves / 1000).toFixed(job.moves > 1e5 ? 0 : 1) + 'k moves' +
      (meta.when ? ' · ' + meta.when : '');
    $('layerIn').max = job.layers.length - so;
    describeTiming();
    if (R.segMove.length > 1200000 && prefs.lines !== 'thin')
      setTimeout(() => toast('Large print (' + Math.round(R.segMove.length / 1e5) / 10 + 'M lines). If playback stutters, use Options → Line style → Thin lines.'), 400);
    let keepView = !!meta.keepView;
    if (meta.keepFrac != null) simT = meta.keepFrac * job.total;
    else if (meta.keepTime != null) simT = Math.min(meta.keepTime, job.total);
    else if (prev) {
      simT = prev.t <= job.total ? prev.t : 0;
      const a = prev.model, b = job.bed.model;
      keepView = keepView || (a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY);
    } else simT = 0;
    if (!keepView) frame('iso');
    renderFlags();
    updateScene(true); updateHud();
    busy(null);
    return true;
  }
  function describeTiming() {
    const b = $('timingBadge'); b.hidden = false;
    if (job.aligned) {
      const adjusted = Math.abs(job.total - job.estimate) > 1;
      b.className = 'badge ok'; b.textContent = (adjusted ? 'Synced to slicer, adjusted for print options · ' : 'Synced to slicer · ') + fmtLong(job.total);
      b.title = 'Total time matches the slicer estimate (' + fmtLong(job.estimate) + '); the motion planner fills in the timing between its progress markers. Planner alone: ' + fmtLong(job.plannerTotal) + '.';
    } else {
      b.className = 'badge'; b.textContent = 'Planner estimate · ' + fmtLong(job.total);
      b.title = job.estimate ? 'Slicer estimate: ' + fmtLong(job.estimate) + '. Choose "match slicer estimate" to sync to it.'
                             : 'No slicer estimate in this file; times come from the built-in motion planner.';
    }
  }

  /* --- files: .gcode and .gcode.3mf (zip) */
  async function readZipGcodes(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip / 3MF file');
    const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder(); const out = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!/\.gcode$/i.test(name)) continue;
      const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
      const data = u8.subarray(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + csize);
      out.push({ name, method, data });
    }
    return out;
  }
  async function inflate(entry) {
    if (entry.method === 0) return new TextDecoder().decode(entry.data);
    if (entry.method !== 8) throw new Error('unsupported compression in 3MF');
    if (typeof DecompressionStream === 'undefined') throw new Error('this viewer cannot unzip 3MF files; export plain G-code instead');
    const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  let pendingPlates = null;
  async function openFile(file) {
    try {
      busy('Opening ' + file.name + '…', 0.02); await nextFrame();
      if (/\.3mf$/i.test(file.name)) {
        const entries = await readZipGcodes(await file.arrayBuffer());
        if (!entries.length) { busy(null); toast('This 3MF has no sliced G-code. Use a .gcode.3mf exported after slicing.', true); return; }
        pendingPlates = { file: file.name, entries };
        const sel = $('plateSel');
        sel.innerHTML = entries.map((e, i) => '<option value="' + i + '">' + (/plate_(\d+)/i.exec(e.name) ? 'Plate ' + /plate_(\d+)/i.exec(e.name)[1] : e.name) + '</option>').join('');
        sel.hidden = entries.length < 2;
        await loadPlate(0);
      } else {
        $('plateSel').hidden = true; pendingPlates = null;
        if (await loadText(await file.text(), { name: file.name, when: 'opened file' })) loadedStamp = null;
      }
    } catch (err) { busy(null); toast(err.message, true); }
  }
  async function loadPlate(i) {
    const e = pendingPlates.entries[i];
    busy('Unpacking ' + e.name + '…', 0.05); await nextFrame();
    await loadText(await inflate(e), { name: pendingPlates.file + (pendingPlates.entries.length > 1 ? ' · plate ' + (i + 1) : ''), when: 'opened file' });
  }
  $('plateSel').onchange = () => { if (pendingPlates) loadPlate(parseInt($('plateSel').value, 10)); };
  $('btnOpen').onclick = $('eOpen').onclick = () => $('file-in').click();
  $('file-in').onchange = () => { const f = $('file-in').files[0]; if (f) openFile(f); $('file-in').value = ''; };
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').style.display = 'grid'; });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop').style.display = 'none'; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('drop').style.display = 'none';
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f);
  });

  /* --- from the plugin: the latest slice, sent in chunks */
  let incoming = null;
  function requestLatest(quiet) {
    if (!host) { toast('Latest slice is only available inside OrcaSlicer.', true); return; }
    hideNewSlice();
    busy('Fetching the latest slice…', 0.02);
    send({ cmd: 'load_latest', quiet: !!quiet });
  }
  /* A newer slice than the one shown: load it if nothing is shown yet, otherwise ask. */
  let loadedStamp = null, dismissedStamp = null, offeredStamp = null;
  function considerLatest(latest) {
    if (!latest || !latest.stamp) return;
    if (latest.stamp === loadedStamp || latest.stamp === dismissedStamp) return;
    if (incoming || $('busy').style.display === 'grid') return;
    if (!job) { requestLatest(true); return; }
    offeredStamp = latest.stamp;
    $('newSliceWhen').textContent = latest.when ? '· ' + latest.when : '';
    $('newSlice').hidden = false;
  }
  function hideNewSlice() { $('newSlice').hidden = true; }
  $('nsLoad').onclick = () => requestLatest(false);
  $('nsKeep').onclick = () => { dismissedStamp = offeredStamp; hideNewSlice(); };
  $('btnLatest').onclick = $('eLatest').onclick = () => requestLatest(false);
  $('btnLatest').disabled = !host; $('eLatest').disabled = !host;

    function onHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.cmd) {
      case 'saved': onSaved(msg); break;
      case 'lib_begin': case 'lib_chunk': case 'lib_end': onLibMessage(msg); break;
      case 'status': {
        if (msg.prefs && typeof msg.prefs === 'object') { Object.assign(prefs, msg.prefs); syncOptionUI(); }
        if (msg.printer) onPrinterCfg(msg.printer);
        renderSetup(msg);
        considerLatest(msg.latest);
        break;
      }
      case 'latest_info':
        renderSetup(msg);
        if (!document.hidden) considerLatest(msg.latest);
        break;
      case 'slice_ready':
        // sliced while this tab is hidden: nothing to do now, the check runs when the tab is shown
        renderSetup(msg);
        if (!document.hidden) considerLatest(msg.latest);
        break;
      case 'gcode_begin':
        incoming = { id: msg.id, name: msg.name, size: msg.size, when: msg.when, stamp: msg.stamp, parts: new Array(msg.chunks), got: 0 };
        busy('Receiving ' + (msg.name || 'G-code') + '…', 0.02);
        break;
      case 'gcode_chunk':
        if (!incoming || msg.id !== incoming.id) break;
        incoming.parts[msg.i] = msg.data; incoming.got++;
        $('busyBar').style.width = Math.round(incoming.got / incoming.parts.length * 40) + '%';
        break;
      case 'gcode_end': {
        if (!incoming || msg.id !== incoming.id) break;
        const inc = incoming; incoming = null;
        if (inc.got !== inc.parts.length) { busy(null); toast('The G-code transfer was incomplete; try again.', true); break; }
        $('plateSel').hidden = true; pendingPlates = null;
        loadText(inc.parts.join(''), { name: inc.name, when: inc.when }).then((ok) => { if (ok) { loadedStamp = inc.stamp || null; hideNewSlice(); } });
        break;
      }
      case 'error':
        busy(null); if (!msg.quiet) toast(msg.message || 'Something went wrong', true);
        if (msg.stamp) dismissedStamp = msg.stamp;     // don't retry the same failing slice on every visit
        if (msg.setup) renderSetup(msg);
        break;
      case 'printer': if (msg.stopped) printerOn = false; onPrinter(msg.status); break;
      case 'toast': toast(msg.message); break;
    }
  }
  function renderSetup(msg) {
    const steps = $('setupSteps');
    if (msg.capture_enabled === false && msg.hint) {
      steps.hidden = false;
      // numbered rows built by hand: a native <ol> picks up the host page's list styles in OrcaSlicer
      steps.innerHTML = '<div class="title">' + msg.hint.title + '</div>' +
        msg.hint.steps.map((t, i) => '<div class="step"><span class="num">' + (i + 1) + '</span><span class="txt">' + t + '</span></div>').join('');
    } else steps.hidden = true;
  }

  /* ------------------------------------------------------------------ live printer */
  /* The plugin asks the printer for its status about once a second and posts it here. In Live mode
     the playback clock follows it: the printer's layer and progress place the nozzle, and between
     reports the clock runs at real time. */
  function syncPrinterFields() {
    const t = $('prType').value;
    $('prSerialWrap').hidden = t !== 'bambu';
    $('prKeyLbl').textContent = t === 'bambu' ? 'LAN access code' : 'API key (only if the printer needs one)';
    $('prHost').placeholder = t === 'bambu' ? 'printer IP, e.g. 192.168.1.50' : 'e.g. 192.168.1.50 or mainsail.local';
  }
  $('prType').onchange = syncPrinterFields;
  syncPrinterFields();
  function onPrinterCfg(p) {
    if (p.cfg) {
      $('prType').value = p.cfg.type || 'bambu'; syncPrinterFields();
      $('prHost').value = p.cfg.host || ''; $('prSerial').value = p.cfg.serial || ''; $('prKey').value = p.cfg.key || '';
      printerOn = !!p.cfg.auto;
    }
    onPrinter(p.status || null);
  }
  $('prConnect').onclick = () => {
    if (!host) { toast('Printers can only be connected inside OrcaSlicer.', true); return; }
    if (printerOn) { send({ cmd: 'printer_disconnect' }); printerOn = false; printerSt = null; setLive(false); onPrinter(null); return; }
    printerOn = true; printerSt = null;
    $('prStatus').textContent = 'Connecting…'; $('prConnect').textContent = 'Disconnect';
    send({ cmd: 'printer_connect', type: $('prType').value, host: $('prHost').value, serial: $('prSerial').value, key: $('prKey').value });
  };
  function printerLine(st) {
    const bits = [({ printing: 'Printing', paused: 'Paused', done: 'Finished', error: 'Error', idle: 'Idle' })[st.state] || st.state];
    if (typeof st.progress === 'number') bits[0] += ' ' + Math.round(st.progress * 100) + '%';
    if (st.layer > 0) bits.push('layer ' + st.layer + (st.total_layers > 0 ? '/' + st.total_layers : ''));
    if (typeof st.nozzle === 'number') bits.push(Math.round(st.nozzle) + '° / ' + Math.round(st.bed || 0) + '°');
    return bits.join(' · ');
  }
  function onPrinter(st) {
    printerSt = st && st.connected ? st : null;
    const ok = !!printerSt;
    $('prConnect').textContent = printerOn ? 'Disconnect' : 'Connect';
    $('prStatus').textContent = ok ? printerLine(st) : (printerOn ? 'Connecting…' + (st && st.error ? ' ' + st.error : '') : (st && st.error ? st.error : 'Not connected'));
    $('hPrinterRow').hidden = !printerOn;
    $('hPrinter').textContent = ok ? printerLine(st) : 'offline';
    $('tLive').disabled = !ok;
    if (!ok) { liveRef = null; if (live && !printerOn) setLive(false); return; }
    if (live) liveUpdate(st);
  }
  const stem = (s) => String(s || '').toLowerCase().replace(/\.(gcode|3mf|bgcode)/g, '').replace(/[^a-z0-9]/g, '');
  function liveUpdate(st) {
    if (!job || !st) return;
    const a = stem(st.file), b = stem(currentMeta && currentMeta.name);
    if (a && b && !a.includes(b) && !b.includes(a) && warnedFile !== a) {
      warnedFile = a; toast('The printer is running “' + st.file + '”, which may not be the G-code shown here.', true);
    }
    if (st.state === 'done') { liveRef = { t: job.total, at: performance.now(), tMax: job.total, running: false }; return; }
    if (st.state !== 'printing' && st.state !== 'paused') { liveRef = null; return; }
    let t = typeof st.progress === 'number' ? st.progress * job.total : null, tMax = job.total;
    if (st.layer > 0) {
      const so = job.layers[0] && job.layers[0].start ? 1 : 0;
      const L = job.layers[Math.max(0, Math.min(job.layers.length - 1, st.layer - 1 + so))];
      t = t === null ? L.t0 : Math.max(L.t0, Math.min(L.t1, t));   // the layer number is exact, the percentage is coarse
      tMax = L.t1;
    }
    if (t === null) { liveRef = null; return; }
    liveRef = { t, at: performance.now(), tMax, running: st.state === 'printing' };
  }
  function setLive(on) {
    if (on && job && printerSt) { setPlaying(false); live = true; liveRef = null; liveUpdate(printerSt); }
    else live = false;
    $('tLive').classList.toggle('on', live);
  }
  $('tLive').onclick = () => { if (!live && !job) { toast('Load the G-code of the print first.', true); return; } setLive(!live); };

  if (host) host.onMessage(onHostMessage);

  /* ------------------------------------------------------------------ boot */
  syncOptionUI();
  applyTheme();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  resize();
  requestAnimationFrame(loop);
  send({ cmd: 'hello' });
  // test hook: standalone page can be driven from the console / a harness
  /* ------------------------------------------------------------------ export: video and images
     Frames are rendered one by one at the chosen size and time step (not recorded off the screen),
     so a video has exact timing whatever the computer's speed. MP4 and WebM go through WebCodecs and
     a muxer; GIF through gifenc. "Whole window" images draw the page itself into an SVG
     foreignObject, with the 3D view and the timeline pasted in as pictures. */
  const X = { open: false, tab: 'video', running: false, cancel: false };
  const xs = (id) => $(id);
  function parseClock(str) {
    const t = String(str || '').trim(); if (!t) return NaN;
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const p = t.split(':').map(Number); if (p.some((v) => !isFinite(v) || v < 0)) return NaN;
    return p.reduce((a, v) => a * 60 + v, 0);
  }
  const moveTime = (k) => (k < job.moves ? job.t0[k] : job.total);
  const layerOffset = () => (job.layers[0] && job.layers[0].start ? 1 : 0);
  function exportEvents() {
    const list = [{ t: 0, label: 'Start of print' }];
    for (const ev of job.events) list.push({ t: moveTime(ev.move), label: ev.label });
    list.push({ t: job.total, label: 'End of print' });
    return list;
  }
  function fillEventSelects() {
    const ev = exportEvents();
    const html = ev.map((e, i) => '<option value="' + i + '">' + fmtTime(e.t) + ' · ' + e.label.replace(/</g, '&lt;') + '</option>').join('');
    xs('xEv0').innerHTML = html; xs('xEv1').innerHTML = html;
    xs('xEv0').value = '0'; xs('xEv1').value = String(ev.length - 1);
    X.events = ev;
  }
  // the time range [t0, t1] the dialog describes, or null with a reason
  function exportRange() {
    const mode = xs('xRange').value, so = layerOffset();
    let t0 = 0, t1 = job.total;
    if (mode === 'layer') {
      const L = job.layers[job.layer[Math.min(curMove, job.moves - 1)]]; t0 = L.t0; t1 = L.t1;
    } else if (mode === 'layers') {
      const n = job.layers.length - so;
      let a = Math.round(+xs('xL0').value), b = Math.round(+xs('xL1').value);
      if (!(a >= 1 && a <= n) || !(b >= 1 && b <= n)) return { err: 'Layers go from 1 to ' + n + '.' };
      if (b < a) [a, b] = [b, a];
      t0 = job.layers[a - 1 + so].t0; t1 = job.layers[b - 1 + so].t1;
    } else if (mode === 'events') {
      const ev = X.events || exportEvents();
      let a = ev[+xs('xEv0').value], b = ev[+xs('xEv1').value];
      if (!a || !b) return { err: 'Pick two events.' };
      t0 = Math.min(a.t, b.t); t1 = Math.max(a.t, b.t);
    } else if (mode === 'time') {
      const a = parseClock(xs('xT0').value), b = parseClock(xs('xT1').value);
      xs('xT0').classList.toggle('bad', !(a >= 0)); xs('xT1').classList.toggle('bad', !(b >= 0));
      if (!(a >= 0) || !(b >= 0)) return { err: 'Times look like 1:23 or 1:02:03.' };
      t0 = Math.min(a, b); t1 = Math.min(job.total, Math.max(a, b));
    }
    t0 = Math.max(0, Math.min(job.total, t0)); t1 = Math.max(0, Math.min(job.total, t1));
    if (t1 - t0 < 0.05) return { err: 'That range is empty.' };
    return { t0, t1 };
  }
  function viewSize() { const r = canvas.getBoundingClientRect(); return { w: Math.max(2, Math.round(r.width)), h: Math.max(2, Math.round(r.height)) }; }
  function exportSize(sel, fmt) {
    const v = viewSize(), aspect = v.w / v.h;
    let h = sel === 'window' ? Math.round(v.h * Math.min(2, window.devicePixelRatio || 1)) : +sel;
    if (fmt === 'gif' && sel === 'window') h = Math.min(h, 480);
    let w = Math.round(h * aspect);
    w -= w % 2; h -= h % 2;                       // encoders want even sizes
    return { w: Math.max(2, w), h: Math.max(2, h) };
  }
  function exportPlan() {
    const r = exportRange(); if (r.err) return r;
    const fmt = xs('xFmt').value, fps = +xs('xFps').value, sp = xs('xSpeed').value;
    const span = r.t1 - r.t0;
    const speed = sp.startsWith('fit') ? Math.max(span / +sp.slice(3), 1e-3) : +sp;
    const length = span / speed, frames = Math.max(1, Math.round(length * fps));
    const size = exportSize(xs('xSize').value, fmt);
    return Object.assign(r, { fmt, fps, speed, length, frames, size });
  }
  function updateExportSummary() {
    if (!job) return;
    const sum = xs('xSum');
    if (X.tab === 'image') {
      const what = document.querySelector('input[name=xWhat]:checked').value;
      const sc = xs('xImgSize').value, v = viewSize();
      const s = what === 'window' ? null : sc === '2160' ? { w: Math.round(2160 * v.w / v.h), h: 2160 } : { w: v.w * +sc * Math.min(2, window.devicePixelRatio || 1), h: v.h * +sc * Math.min(2, window.devicePixelRatio || 1) };
      sum.innerHTML = 'The picture on screen now, at <b>' + fmtTime(simT) + '</b> (layer ' + (job.layer[Math.min(curMove, job.moves - 1)] - layerOffset() + 1) + ')' +
        (s ? ' \u00b7 <b>' + Math.round(s.w) + '\u00d7' + Math.round(s.h) + '</b>' : ' \u00b7 the whole window, as you see it') +
        '<br>File size: <b id="xEst">estimating\u2026</b>';
      xs('xImgSize').disabled = what === 'window';
      xs('xGo').disabled = false; scheduleEstimate(null); return;
    }
    const p = exportPlan();
    if (p.err) { sum.innerHTML = '<span class="warn">' + p.err + '</span>'; xs('xGo').disabled = true; return; }
    const warn = [];
    if (p.fmt === 'gif' && p.frames > 900) warn.push('A GIF this long is very large; MP4 is much smaller.');
    if (p.frames > 36000) warn.push('That is a lot of frames; consider a higher speed.');
    if (p.fmt !== 'gif' && !X.codecs[p.fmt]) warn.push(p.fmt.toUpperCase() + ' video is not supported here.');
    const cd = p.fmt === 'gif' ? null : X.codecs[p.fmt];
    const notes = [];
    if (cd && cd.via !== 'wc') {
      // the bundled encoders manage roughly 10 frames a second at 1080p, scaling with the pixel count
      const secs = p.frames * (p.size.w * p.size.h) / (1920 * 1080) / (cd.via === 'h264' ? 10 : 8) + p.frames * 0.01;
      notes.push('Encoded by the plugin, frame by frame: takes about ' + fmtLong(Math.max(1, secs)) + '.');
    }
    sum.innerHTML = '<b>' + fmtTime(p.t0) + ' \u2192 ' + fmtTime(p.t1) + '</b> of the print at ' + (p.speed >= 10 ? Math.round(p.speed) : +p.speed.toFixed(2)) + '\u00d7 \u2192 a <b>' +
      fmtLong(p.length) + '</b> video \u00b7 ' + p.frames + ' frames \u00b7 ' + p.size.w + '\u00d7' + p.size.h +
      '<br>File size: <b id="xEst">' + (p.fmt === 'gif' ? 'estimating\u2026' : 'up to about ' + fmtBytes(videoBitrate(p) * p.length / 8)) + '</b>' +
      (notes.length ? '<br>' + notes.join(' ') : '') +
      (warn.length ? '<br><span class="warn">' + warn.join(' ') + '</span>' : '');
    xs('xGo').disabled = p.fmt !== 'gif' && !X.codecs[p.fmt];
    if (p.fmt === 'gif') scheduleEstimate(p);
  }
  // which encoders this browser has (checked once, at a common size)
  /* What can encode video here. In a browser opened from file:// or https, WebCodecs (fast, using the
     graphics card). OrcaSlicer puts its page into WebView2 with NavigateToString, which is not a
     secure context, so WebCodecs isn't there: then the bundled WebAssembly encoders take the frames,
     H.264 for MP4 (minih264) and VP8 for WebM (libvpx). Either way every frame is rendered and
     handed over one by one, so length, frame count and size are exactly what the dialog says. */
  async function probeCodecs() {
    if (X.codecs) return X.codecs;
    const c = { mp4: null, webm: null };
    if (typeof VideoEncoder === 'function') {
      const ok = async (codec) => { try { return (await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 4e6, framerate: 30 })).supported; } catch (e) { return false; } };
      if (await ok('avc1.640028') || await ok('avc1.42001f')) c.mp4 = { via: 'wc', kind: 'avc' };
      if (await ok('vp09.00.10.08')) c.webm = { via: 'wc', kind: 'vp9' }; else if (await ok('vp8')) c.webm = { via: 'wc', kind: 'vp8' };
    }
    // the encoders are inline in the standalone page, and come from the plugin on request in OrcaSlicer
    if (!c.mp4 && (window.HME || host)) c.mp4 = { via: 'h264', kind: 'avc' };
    if (!c.webm && ((window.webmWasmFactory && window.WEBM_WASM_B64) || host)) c.webm = { via: 'vpx', kind: 'vp8' };
    X.codecs = c;
    for (const o of xs('xFmt').options) if (o.value !== 'gif') o.disabled = !c[o.value];
    if (xs('xFmt').selectedOptions[0].disabled) xs('xFmt').value = c.mp4 ? 'mp4' : c.webm ? 'webm' : 'gif';
    return c;
  }
  function fmtBytes(n) {
    if (!(n > 0)) return '\u2013';
    return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' kB';
  }
  const videoBitrate = (p) => Math.max(2e6, Math.min(60e6, p.size.w * p.size.h * p.fps * 0.12));
  /* GIF and picture sizes depend on the content, so encode one real frame to measure */
  let estTimer = 0, estSeq = 0;
  function scheduleEstimate(p) {
    clearTimeout(estTimer);
    const seq = ++estSeq;
    estTimer = setTimeout(async () => {
      if (X.running || !X.open) return;
      let n = 0;
      try {
        if (p) {                                   // GIF: one frame (at most 480 px tall, scaled up) x the frame count
          const { w, h } = p.size, sc = Math.min(1, 480 / h), sw = Math.max(2, Math.round(w * sc)), sh = Math.max(2, Math.round(h * sc));
          const c2 = document.createElement('canvas'); c2.width = sw; c2.height = sh;
          const g2 = c2.getContext('2d', { willReadFrequently: true });
          renderAt(simT); g2.drawImage(canvas, 0, 0, sw, sh);
          const data = g2.getImageData(0, 0, sw, sh).data, { GIFEncoder, quantize, applyPalette } = window.gifenc;
          const enc = GIFEncoder(), pal = quantize(data, 256, { format: 'rgb565' });
          enc.writeFrame(applyPalette(data, pal, 'rgb565'), sw, sh, { palette: pal }); enc.finish();
          n = enc.bytes().length / (sc * sc) * p.frames;
        } else {
          const what = document.querySelector('input[name=xWhat]:checked').value;
          n = (await captureImage(what, xs('xImgFmt').value, xs('xImgSize').value)).size;
        }
      } catch (e) { n = 0; }
      if (seq !== estSeq || !xs('xEst')) return;
      xs('xEst').textContent = n ? (p ? 'about ' : '') + fmtBytes(n) : '\u2013';
    }, 250);
  }
  function setExportTab(tab) {
    X.tab = tab;
    xs('xTabVideo').classList.toggle('on', tab === 'video'); xs('xTabImage').classList.toggle('on', tab === 'image');
    xs('xTabVideo').setAttribute('aria-selected', tab === 'video'); xs('xTabImage').setAttribute('aria-selected', tab === 'image');
    xs('xVideo').hidden = tab !== 'video'; xs('xImage').hidden = tab !== 'image';
    updateExportSummary();
  }
  function showRangeRows() {
    const m = xs('xRange').value;
    xs('xLayersRow').hidden = m !== 'layers'; xs('xEventsRow').hidden = m !== 'events'; xs('xTimeRow').hidden = m !== 'time';
    updateExportSummary();
  }
  async function openExport() {
    if (!job || X.running) return;
    setPlaying(false);
    X.open = true; xs('expDlg').hidden = false; xs('xProg').hidden = true; showExportResult(null);
    const so = layerOffset(), n = job.layers.length - so, cur = job.layer[Math.min(curMove, job.moves - 1)] - so + 1;
    xs('xL0').max = xs('xL1').max = n;
    if (!xs('xL0').value) { xs('xL0').value = 1; xs('xL1').value = n; }
    if (!xs('xT0').value) { xs('xT0').value = fmtTime(simT); xs('xT1').value = fmtTime(Math.min(job.total, simT + 60)); }
    if (+xs('xL0').value > n) xs('xL0').value = 1;
    if (+xs('xL1').value > n) xs('xL1').value = n;
    fillEventSelects();
    if (!X.inited) {
      X.inited = true;
      xs('xFps').value = '30'; xs('xSize').value = '1080'; xs('xSpeed').value = 'fit30';
    }
    void cur;
    await probeCodecs();
    setExportTab(X.tab); showRangeRows();
    (X.tab === 'video' ? xs('xRange') : xs('xImgFmt')).focus();
  }
  function closeExport() {
    if (X.running) { X.cancel = true; return; }
    X.open = false; xs('expDlg').hidden = true; canvas.focus({ preventScroll: true });
  }
  xs('expBtn').onclick = openExport;
  xs('xClose').onclick = closeExport; xs('xCancel').onclick = closeExport;
  xs('expDlg').addEventListener('pointerdown', (e) => { if (e.target === xs('expDlg') && !X.running) closeExport(); });
  xs('expDlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeExport(); } e.stopPropagation(); });
  xs('xTabVideo').onclick = () => setExportTab('video'); xs('xTabImage').onclick = () => setExportTab('image');
  xs('xRange').onchange = showRangeRows;
  for (const id of ['xL0', 'xL1', 'xEv0', 'xEv1', 'xT0', 'xT1', 'xFmt', 'xSpeed', 'xSize', 'xFps', 'xImgFmt', 'xImgSize'])
    xs(id).addEventListener(id.startsWith('xT') || id.startsWith('xL') ? 'input' : 'change', updateExportSummary);
  for (const r of document.querySelectorAll('input[name=xWhat]')) r.onchange = updateExportSummary;
  xs('xFmt').addEventListener('change', () => {
    // GIFs: modest size and frame rate by default
    if (xs('xFmt').value === 'gif') { if (+xs('xFps').value > 24) xs('xFps').value = '15'; if (['1080', '1440', '2160'].includes(xs('xSize').value)) xs('xSize').value = '480'; }
    updateExportSummary();
  });
  xs('xNow').onclick = () => { xs('xT0').value = fmtTime(simT); updateExportSummary(); };

  /* --- rendering at a given size; everything is put back afterwards */
  function withRenderSize(w, h, fn) {
    const pr = renderer.getPixelRatio();
    renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (lineMat) { lineMat.resolution.set(w, h); lineMatPartial.resolution.set(w, h); }
    try { return fn(); } finally { renderer.setPixelRatio(pr); resize(); }
  }
  async function withRenderSizeAsync(w, h, fn) {
    const pr = renderer.getPixelRatio();
    const apply = () => {
      renderer.setPixelRatio(1); renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      if (lineMat) { lineMat.resolution.set(w, h); lineMatPartial.resolution.set(w, h); }
    };
    apply(); X.applySize = apply;
    try { return await fn(); } finally { X.applySize = null; renderer.setPixelRatio(pr); resize(); }
  }
  function renderAt(t) {
    simT = Math.max(0, Math.min(job.total, t));
    updateScene(true); controls.update();
    renderer.render(scene, camera); dirty = false;
  }
  function progress(frac, text) {
    xs('xBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (text != null) xs('xProgText').textContent = text;
  }
  const sleep0 = () => new Promise((r) => setTimeout(r, 0));

  async function encodeVideo(p) {
    const { w, h } = p.size, fps = p.fps, dtSim = p.speed / fps;
    const frameUs = 1e6 / fps;
    const bitrate = videoBitrate(p);
    if (p.fmt === 'gif') {
      const { GIFEncoder, quantize, applyPalette } = window.gifenc;
      const gif = GIFEncoder(), c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      const delay = Math.round(100 / fps) * 10;
      await withRenderSizeAsync(w, h, async () => {
        for (let i = 0; i < p.frames; i++) {
          if (X.cancel) throw new Error('cancelled');
          if (X.applySize) X.applySize();
          renderAt(p.t0 + i * dtSim);
          g2.drawImage(canvas, 0, 0, w, h);
          const data = g2.getImageData(0, 0, w, h).data;
          const palette = quantize(data, 256, { format: 'rgb565' });
          gif.writeFrame(applyPalette(data, palette, 'rgb565'), w, h, { palette, delay });
          if (i % 2 === 0) { progress((i + 1) / p.frames, 'Frame ' + (i + 1) + ' of ' + p.frames); await sleep0(); }
        }
      });
      gif.finish();
      return new Blob([gif.bytes()], { type: 'image/gif' });
    }
    const cd = X.codecs[p.fmt];
    if (!cd) throw new Error(p.fmt.toUpperCase() + ' video is not supported here.');
    if (cd.via === 'h264' || cd.via === 'vpx') return encodeWasm(p, cd, bitrate);
    const kind = cd.kind;
    let codec, muxer, target;
    if (kind === 'avc') {
      const big = w * h > 1920 * 1088;
      const cands = big ? ['avc1.640033', 'avc1.640034', 'avc1.4d0033'] : ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'avc1.640033'];
      for (const c of cands) {
        try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' } })).supported) { codec = c; break; } } catch (e) { /* next */ }
      }
    } else {
      for (const c of kind === 'vp8' ? ['vp8'] : ['vp09.00.40.08', 'vp09.00.31.08', 'vp09.00.10.08']) {
        try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: w, height: h, bitrate, framerate: fps })).supported) { codec = c; break; } } catch (e) { /* next */ }
      }
    }
    if (!codec) throw new Error(w + '×' + h + ' is too large for this video encoder; pick a smaller size.');
    if (p.fmt === 'mp4') {
      target = new Mp4Muxer.ArrayBufferTarget();
      muxer = new Mp4Muxer.Muxer({ target, video: { codec: kind === 'avc' ? 'avc' : 'vp9', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
    } else {
      target = new WebMMuxer.ArrayBufferTarget();
      muxer = new WebMMuxer.Muxer({ target, video: { codec: kind === 'vp8' ? 'V_VP8' : 'V_VP9', width: w, height: h, frameRate: fps } });
    }
    let encErr = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
    enc.configure(Object.assign({ codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' }, kind === 'avc' ? { avc: { format: 'avc' } } : {}));
    try {
      await withRenderSizeAsync(w, h, async () => {
        for (let i = 0; i < p.frames; i++) {
          if (X.cancel) throw new Error('cancelled');
          if (encErr) throw encErr;
          if (X.applySize) X.applySize();
          renderAt(p.t0 + i * dtSim);
          const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
          enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
          while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
          if (i % 3 === 0) { progress((i + 1) / p.frames, 'Frame ' + (i + 1) + ' of ' + p.frames); await sleep0(); }
        }
      });
      progress(1, 'Finishing…');
      await enc.flush();
      if (encErr) throw encErr;
      muxer.finalize();
    } finally { if (enc.state !== 'closed') enc.close(); }
    return new Blob([target.buffer], { type: p.fmt === 'mp4' ? 'video/mp4' : 'video/webm' });
  }

  /* The bundled encoders take raw RGBA pixels: render each frame, read it back through a 2D canvas,
     hand it over. H.264 MP4 via h264-mp4-encoder (minih264 + libmp4v2), VP8 WebM via webm-wasm
     (libvpx + libwebm). Both run on the main thread, so the loop yields after every frame. */
  let encodersReady = null;
  const libLoads = new Map();
  function ensureEncoders() {
    if (window.HME && window.webmWasmFactory) return Promise.resolve();
    if (encodersReady) return encodersReady;
    if (!host) return Promise.reject(new Error('The video encoders are not available.'));
    encodersReady = new Promise((resolve, reject) => {
      const id = 'e' + Date.now().toString(36);
      const timer = setTimeout(() => { libLoads.delete(id); reject(new Error('The plugin did not send the video encoders.')); }, 60000);
      libLoads.set(id, { parts: null, got: 0, resolve: (code) => {
        clearTimeout(timer);
        try { const sc = document.createElement('script'); sc.text = code; document.head.appendChild(sc); sc.remove(); } catch (e) { reject(e); return; }
        if (window.HME && window.webmWasmFactory) resolve(); else reject(new Error('The video encoders did not load.'));
      }, reject: (e) => { clearTimeout(timer); reject(e); } });
      send({ cmd: 'load_encoders', id });
    });
    encodersReady.catch(() => { encodersReady = null; });
    return encodersReady;
  }
  function onLibMessage(msg) {
    const L = libLoads.get(msg.id); if (!L) return;
    if (msg.cmd === 'lib_begin') { L.parts = new Array(msg.chunks); L.got = 0; }
    else if (msg.cmd === 'lib_chunk' && L.parts) { L.parts[msg.i] = msg.data; L.got++; progress(L.got / L.parts.length * 0.5, 'Loading the video encoder\u2026'); }
    else if (msg.cmd === 'lib_end') {
      libLoads.delete(msg.id);
      if (msg.error || !L.parts || L.got !== L.parts.length) L.reject(new Error(msg.error || 'The video encoder arrived incomplete.'));
      else L.resolve(L.parts.join(''));
    }
  }
  let vpxModule = null;
  function loadVpx() {
    if (vpxModule) return vpxModule;
    vpxModule = new Promise((resolve, reject) => {
      try {
        const bin = Uint8Array.from(atob(window.WEBM_WASM_B64), (ch) => ch.charCodeAt(0));
        const m = window.webmWasmFactory({ noInitialRun: true, wasmBinary: bin,
          onRuntimeInitialized() { delete m.then; resolve(m); }, onAbort(e) { reject(new Error('The WebM encoder could not start: ' + e)); } });
      } catch (e) { reject(e); }
    });
    vpxModule.catch(() => { vpxModule = null; });
    return vpxModule;
  }
  async function encodeWasm(p, cd, bitrate) {
    const { w, h } = p.size, fps = p.fps, dtSim = p.speed / fps, kbps = Math.max(300, Math.round(bitrate / 1000));
    progress(0, 'Loading the video encoder\u2026');
    await ensureEncoders();
    const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
    const g2 = c2.getContext('2d', { willReadFrequently: true });
    let addFrame, finish, cleanup;
    if (cd.via === 'h264') {
      const enc = await window.HME.createH264MP4Encoder();
      // speed 0..10: 10 is ~11 fps at 1080p in WebAssembly; the bitrate keeps quality, so go fast for big frames
      enc.width = w; enc.height = h; enc.frameRate = fps; enc.kbps = kbps; enc.speed = w * h > 1280 * 720 ? 10 : 7;
      enc.groupOfPictures = Math.max(1, Math.round(fps * 2));
      enc.initialize();
      addFrame = (px) => enc.addFrameRgba(px);
      finish = () => { enc.finalize(); const out = enc.FS.readFile(enc.outputFilename); try { enc.FS.unlink(enc.outputFilename); } catch (e) { /* gone */ } return new Blob([out], { type: 'video/mp4' }); };
      cleanup = () => { try { enc.delete(); } catch (e) { /* already freed */ } };
    } else {
      const m = await loadVpx(), parts = [];
      const enc = new m.WebmEncoder(1, fps, w, h, kbps, true, false, (chunk) => parts.push(new Uint8Array(chunk)));
      const err = enc.lastError(); if (err) { enc.delete(); throw new Error('WebM encoder: ' + err); }
      addFrame = (px) => { if (!enc.addRGBAFrame(px)) throw new Error('WebM encoder: ' + enc.lastError()); };
      finish = () => { enc.finalize(); return new Blob(parts, { type: 'video/webm' }); };
      cleanup = () => { try { enc.delete(); } catch (e) { /* already freed */ } };
    }
    try {
      const t0 = performance.now();
      await withRenderSizeAsync(w, h, async () => {
        for (let i = 0; i < p.frames; i++) {
          if (X.cancel) throw new Error('cancelled');
          if (X.applySize) X.applySize();
          renderAt(p.t0 + i * dtSim);
          g2.drawImage(canvas, 0, 0, w, h);
          addFrame(g2.getImageData(0, 0, w, h).data);
          const left = (performance.now() - t0) / (i + 1) * (p.frames - i - 1) / 1000;
          progress((i + 1) / p.frames, 'Frame ' + (i + 1) + ' of ' + p.frames + (i > 4 ? ' \u00b7 about ' + fmtLong(left) + ' left' : ''));
          await sleep0();
        }
      });
      progress(1, 'Finishing\u2026'); await sleep0();
      return finish();
    } finally { cleanup(); }
  }
  function canvasToBlob(c, type, q) { return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image.'))), type, q)); }
  async function captureImage(what, fmt, scale) {
    const type = 'image/' + fmt, q = fmt === 'png' ? undefined : 0.92;
    const v = viewSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (what === 'render') {
      const h = scale === '2160' ? 2160 : Math.round(v.h * +scale * dpr), w = Math.round(h * v.w / v.h);
      const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
      withRenderSize(w, h, () => { renderAt(simT); c2.getContext('2d').drawImage(canvas, 0, 0); });
      renderAt(simT);
      return canvasToBlob(c2, type, q);
    }
    // whole window: the page drawn by the browser inside an SVG, canvases pasted in as pictures
    renderAt(simT);
    const shots = new Map();
    for (const c of document.querySelectorAll('canvas')) { try { shots.set(c, c.toDataURL('image/png')); } catch (e) { /* skip */ } }
    const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
    const clone = document.documentElement.cloneNode(true);
    const origAll = document.documentElement.querySelectorAll('*'), cloneAll = clone.querySelectorAll('*');
    for (let i = 0; i < origAll.length; i++) {
      const o = origAll[i], c = cloneAll[i];
      if (o.tagName === 'SCRIPT') { c.remove(); continue; }
      if (o.id === 'expDlg' || o.id === 'toast') { c.remove(); continue; }
      if (o.tagName === 'CANVAS' && shots.has(o)) {
        const img = document.createElement('img'); img.src = shots.get(o);
        img.setAttribute('style', (o.getAttribute('style') || '') + ';width:' + o.clientWidth + 'px;height:' + o.clientHeight + 'px;display:block');
        if (o.id) img.id = o.id;
        img.className = o.className; c.replaceWith(img); continue;
      }
      if (o.tagName === 'SELECT') { for (const opt of c.querySelectorAll('option')) opt.toggleAttribute('selected', opt.value === o.value); }
      else if (o.tagName === 'INPUT') { if (o.type === 'checkbox' || o.type === 'radio') c.toggleAttribute('checked', o.checked); else c.setAttribute('value', o.value); }
      if (o.scrollTop) c.setAttribute('data-scroll', o.scrollTop);
    }
    // inline the CSS variables and colours the host set on <html> (theme), and pin the page size
    clone.setAttribute('style', (document.documentElement.getAttribute('style') || '') + ';width:' + W + 'px;height:' + H + 'px');
    const xml = new XMLSerializer().serializeToString(clone);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W * dpr + '" height="' + H * dpr + '" viewBox="0 0 ' + W + ' ' + H + '">' +
                '<foreignObject x="0" y="0" width="' + W + '" height="' + H + '">' + xml + '</foreignObject></svg>';
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not draw the window.')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const c2 = document.createElement('canvas'); c2.width = Math.round(W * dpr); c2.height = Math.round(H * dpr);
    const g = c2.getContext('2d'); g.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e2023'; g.fillRect(0, 0, c2.width, c2.height);
    g.drawImage(img, 0, 0, c2.width, c2.height);
    return canvasToBlob(c2, type, q);
  }

  /* --- saving: the system's Save dialog when there is one (Windows/Chromium), else the plugin
     writes it into its own exports folder (OrcaSlicer on macOS/Linux), else a browser download */
  const MIME = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
  function exportName(ext) {
    const base = String((currentMeta && currentMeta.name) || 'print').replace(/\.gcode(\.3mf)?$/i, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'print';
    return base + (X.tab === 'image' ? '_' + fmtTime(simT).replace(/:/g, '-') : '') + '.' + (ext === 'jpeg' ? 'jpg' : ext);
  }
  async function pickSaveTarget(name, ext) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    const accept = {}; accept[MIME[ext]] = ['.' + (ext === 'jpeg' ? 'jpg' : ext)];
    try { return await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept }] }); }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; return null; }
  }
  const pendingSaves = new Map();
  function saveViaPlugin(name, blob) {
    return new Promise(async (resolve, reject) => {
      const id = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      pendingSaves.set(id, { resolve, reject });
      const buf = new Uint8Array(await blob.arrayBuffer()), CH = 384 * 1024, n = Math.max(1, Math.ceil(buf.length / CH));
      send({ cmd: 'save_begin', id, name, size: buf.length, chunks: n });
      for (let i = 0; i < n; i++) {
        let bin = ''; const part = buf.subarray(i * CH, (i + 1) * CH);
        for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
        send({ cmd: 'save_chunk', id, i, data: btoa(bin) });
        if (i % 4 === 3) { progress((i + 1) / n, 'Saving…'); await sleep0(); }
      }
      send({ cmd: 'save_end', id });
      setTimeout(() => { if (pendingSaves.has(id)) { pendingSaves.delete(id); reject(new Error('The plugin did not answer.')); } }, 30000);
    });
  }
  function onSaved(msg) {
    const p = pendingSaves.get(msg.id); if (!p) return;
    pendingSaves.delete(msg.id);
    if (msg.ok) p.resolve(msg.path); else p.reject(new Error(msg.error || 'Could not save the file.'));
  }
  async function deliver(blob, name, handle) {
    if (handle && handle !== 'cancelled') {
      const w = await handle.createWritable(); await w.write(blob); await w.close();
      return 'Saved ' + handle.name;
    }
    if (host) { const path = await saveViaPlugin(name, blob); X.savedPath = path; return 'Saved to ' + path; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return 'Downloaded ' + name;
  }

  async function runExport() {
    if (!job || X.running) return;
    const isImg = X.tab === 'image';
    const plan = isImg ? null : exportPlan();
    if (plan && plan.err) return;
    const ext = isImg ? xs('xImgFmt').value : plan.fmt;
    const name = exportName(ext);
    // ask where to save first: the Save dialog has to open straight from the click
    const handle = await pickSaveTarget(name, ext);
    if (handle === 'cancelled') return;
    X.running = true; X.cancel = false; X.savedPath = null; showExportResult(null);
    const keep = { t: simT };
    xs('xProg').hidden = false; progress(0, isImg ? 'Capturing…' : 'Rendering…');
    xs('xGo').disabled = true; xs('xCancel').textContent = 'Stop';
    for (const el of xs('expDlg').querySelectorAll('select,input,.tabs button')) el.disabled = true;
    let msg = null, isErr = false;
    try {
      const blob = isImg
        ? await captureImage(document.querySelector('input[name=xWhat]:checked').value, ext, xs('xImgSize').value)
        : await encodeVideo(plan);
      progress(1, 'Saving…');
      msg = await deliver(blob, name, handle) + ' (' + (blob.size >= 1e6 ? (blob.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1e3)) + ' kB') + ')';
    } catch (e) {
      if (e && e.message === 'cancelled') msg = 'Export stopped.';
      else { msg = 'Export failed: ' + (e && e.message ? e.message : e); isErr = true; console.error(e); }
    } finally {
      X.running = false; X.cancel = false;
      simT = keep.t; updateScene(true); updateHud(); dirty = true;
      for (const el of xs('expDlg').querySelectorAll('select,input,.tabs button')) el.disabled = false;
      xs('xCancel').textContent = 'Cancel'; xs('xProg').hidden = true;
      updateExportSummary();
    }
    X.last = { msg, isErr };
    if (!isErr && msg !== 'Export stopped.' && !X.savedPath) { toast(msg); closeExport(); }
    else showExportResult(msg, isErr, X.savedPath);
  }
  xs('xGo').onclick = runExport;
  function showExportResult(msg, isErr, path) {
    const r = xs('xResult');
    if (!msg) { r.hidden = true; return; }
    r.hidden = false; r.className = 'result' + (isErr ? ' err' : '');
    xs('xResultText').textContent = path ? 'Saved into the plugin\u2019s exports folder (OrcaSlicer can\u2019t show a Save dialog here):' : msg;
    xs('xResultPath').hidden = !path; xs('xCopy').hidden = !path;
    if (path) xs('xResultPath').textContent = path;
  }
  xs('xCopy').onclick = async () => {
    const t = xs('xResultPath').textContent;
    let ok = false;
    try { await navigator.clipboard.writeText(t); ok = true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove();
    }
    xs('xCopy').textContent = ok ? 'Copied' : 'Select and copy';
    if (!ok) { const rg = document.createRange(); rg.selectNodeContents(xs('xResultPath')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); }
    setTimeout(() => { xs('xCopy').textContent = 'Copy path'; }, 1600);
  };

  window.PlaybackApp = { loadText, seek, setPlaying, get job() { return job; }, get time() { return simT; },
                         setPrefs(p) { Object.assign(prefs, p); syncOptionUI(); if (job) { if ("lines" in p) buildPaths(); else rebuildObjects(); computeColors(); if (R.main.userData.thin) R.main.geometry.attributes.color.needsUpdate = true; else R.main.geometry.setColors(R.col); updateScene(true); updateHud(); } },
                         frame, onHostMessage,
                         // tests: camera state and the screen position of a bed point
                         _pick(x, y) { const r = canvas.getBoundingClientRect(); const rc = new THREE.Raycaster();
                                       camera.updateMatrixWorld(); rc.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1), camera);
                                       const h = controls.pick(rc.ray); return h ? h.sub(bedGroup.position).toArray() : null; },
                         _export: X, _runExport: runExport, _openExport: openExport,
                         _exportPlan() { return exportPlan(); },
                         _capture(what, fmt, scale) { return captureImage(what, fmt, scale); },
                         _cam() { const d = controls.target.clone().sub(camera.position); return { pos: camera.position.toArray(), posBed: camera.position.clone().sub(bedGroup.position).toArray(), dist: d.length(), dir: d.normalize().toArray(), up: new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).toArray(), pivot: controls._pivot().sub(bedGroup.position).toArray() }; },
                         _project(pt) { camera.updateMatrixWorld(); const v = new THREE.Vector3(pt[0], pt[1], pt[2]).add(bedGroup.position).project(camera); const r = canvas.getBoundingClientRect();
                                        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; },
                         // tests: put the camera at (px,py,pz) looking at (tx,ty,tz), in bed millimetres
                         look(tx, ty, tz, px, py, pz) { controls.target.set(tx, ty, tz); camera.position.set(px, py, pz); camera.updateProjectionMatrix(); controls.sync(); controls.update(); dirty = true; } };
})();
