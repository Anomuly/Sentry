// globe.js
//
// Canvas-rendered spinning globe wrapped in flames, for the brand mark.
//
// Why canvas rather than SVG: a convincing sphere needs per-frame
// spherical foreshortening (landmasses compress toward the limb as they
// rotate away) and organic flame motion. Static SVG paths can't do
// either without looking like flat clip-art, which is what the earlier
// versions looked like.

export function mountGlobe(canvas, size = 64) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cx = size / 2;
  const cy = size * 0.56;
  const R = size * 0.30;

  // Landmasses defined in lon/lat degrees with a rough radius, so they
  // can be projected onto the sphere properly instead of being drawn flat.
  const LAND = [
    { lon: -100, lat: 45, r: 0.30, s: 1.5 },
    { lon: -80,  lat: 15, r: 0.16, s: 1.0 },
    { lon: -60,  lat: -20, r: 0.26, s: 1.6 },
    { lon: 15,   lat: 50, r: 0.20, s: 1.1 },
    { lon: 20,   lat: 5,  r: 0.28, s: 1.7 },
    { lon: 30,   lat: -25, r: 0.18, s: 1.2 },
    { lon: 80,   lat: 40, r: 0.32, s: 1.4 },
    { lon: 110,  lat: 15, r: 0.18, s: 1.0 },
    { lon: 135,  lat: -25, r: 0.22, s: 1.2 },
    { lon: 175,  lat: 60, r: 0.16, s: 0.9 },
  ];

  // Ember particles rising off the flames.
  const embers = Array.from({ length: 14 }, () => ({
    a: Math.random() * Math.PI * 2,
    life: Math.random(),
    speed: 0.004 + Math.random() * 0.006,
    size: 0.6 + Math.random() * 1.4,
  }));

  let rot = 0;
  let t = 0;
  let raf = null;

  function drawFlames() {
    // Layered flame tongues around the sphere, each with its own phase
    // so the whole ring breathes rather than pulsing in lockstep.
    const tongues = 22;
    for (let i = 0; i < tongues; i++) {
      const base = (i / tongues) * Math.PI * 2;
      // Flames concentrate on top and sides, thinner underneath.
      const upward = Math.cos(base - Math.PI / 2);
      const bias = 0.55 + 0.45 * Math.max(0, upward);
      const wobble = Math.sin(t * 0.06 + i * 1.7) * 0.5 + Math.sin(t * 0.11 + i * 0.9) * 0.3;
      const len = R * (0.32 + 0.34 * bias) * (1 + wobble * 0.35);

      const x0 = cx + Math.cos(base) * R * 0.92;
      const y0 = cy + Math.sin(base) * R * 0.92;
      const x1 = cx + Math.cos(base) * (R + len);
      const y1 = cy + Math.sin(base) * (R + len);

      const grad = ctx.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, 'rgba(255,224,130,0.95)');
      grad.addColorStop(0.35, 'rgba(255,90,60,0.75)');
      grad.addColorStop(1, 'rgba(139,47,217,0)');

      ctx.beginPath();
      const spread = 0.13 + 0.05 * Math.sin(t * 0.08 + i);
      ctx.moveTo(cx + Math.cos(base - spread) * R * 0.9, cy + Math.sin(base - spread) * R * 0.9);
      ctx.quadraticCurveTo(
        cx + Math.cos(base + wobble * 0.12) * (R + len * 0.75),
        cy + Math.sin(base + wobble * 0.12) * (R + len * 0.75),
        x1, y1
      );
      ctx.quadraticCurveTo(
        cx + Math.cos(base - wobble * 0.12) * (R + len * 0.55),
        cy + Math.sin(base - wobble * 0.12) * (R + len * 0.55),
        cx + Math.cos(base + spread) * R * 0.9,
        cy + Math.sin(base + spread) * R * 0.9
      );
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Hot inner corona hugging the sphere
    const corona = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.45);
    corona.addColorStop(0, 'rgba(255,140,60,0.55)');
    corona.addColorStop(1, 'rgba(255,60,90,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.45, 0, Math.PI * 2);
    ctx.fillStyle = corona;
    ctx.fill();
  }

  function drawGlobe() {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Ocean base with light from upper-left
    const body = ctx.createRadialGradient(
      cx - R * 0.35, cy - R * 0.38, R * 0.1,
      cx, cy, R * 1.15
    );
    body.addColorStop(0, '#7A1F4E');
    body.addColorStop(0.45, '#4A1038');
    body.addColorStop(1, '#160512');
    ctx.fillStyle = body;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // Landmasses, projected with spherical foreshortening
    ctx.fillStyle = 'rgba(255,120,70,0.55)';
    LAND.forEach(l => {
      const lon = ((l.lon + rot) % 360 + 540) % 360 - 180; // wrap to -180..180
      const lonRad = lon * Math.PI / 180;
      const latRad = l.lat * Math.PI / 180;
      const cosLon = Math.cos(lonRad);
      if (cosLon <= 0.02) return; // on the far side of the sphere

      const x = cx + R * Math.sin(lonRad) * Math.cos(latRad);
      const y = cy - R * Math.sin(latRad);
      // Horizontal squash as the blob approaches the limb
      const rx = R * l.r * cosLon;
      const ry = R * l.r * l.s * 0.62;
      if (rx <= 0.3) return;

      ctx.globalAlpha = 0.30 + 0.55 * cosLon;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // Terminator shading toward the lower-right limb
    const shade = ctx.createRadialGradient(
      cx - R * 0.4, cy - R * 0.4, R * 0.2,
      cx, cy, R * 1.05
    );
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(0.7, 'rgba(0,0,0,0.15)');
    shade.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = shade;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // Specular highlight
    const spec = ctx.createRadialGradient(
      cx - R * 0.42, cy - R * 0.45, 0,
      cx - R * 0.42, cy - R * 0.45, R * 0.55
    );
    spec.addColorStop(0, 'rgba(255,220,190,0.30)');
    spec.addColorStop(1, 'rgba(255,220,190,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    ctx.restore();

    // Hot rim light where the fire meets the sphere edge
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,150,80,0.75)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  function drawEmbers() {
    embers.forEach(e => {
      e.life += e.speed;
      if (e.life > 1) { e.life = 0; e.a = Math.random() * Math.PI * 2; }
      const rise = e.life;
      const dist = R * (1.1 + rise * 0.9);
      const x = cx + Math.cos(e.a) * dist + Math.sin(t * 0.05 + e.a * 3) * 2;
      const y = cy + Math.sin(e.a) * dist - rise * R * 0.8;
      ctx.globalAlpha = (1 - rise) * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, e.size * (1 - rise * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = rise > 0.6 ? '#FF3D68' : '#FFD166';
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function frame() {
    ctx.clearRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';
    drawFlames();
    ctx.globalCompositeOperation = 'source-over';
    drawGlobe();
    ctx.globalCompositeOperation = 'lighter';
    drawEmbers();
    ctx.globalCompositeOperation = 'source-over';

    rot += 0.32;
    t += 1;
    raf = requestAnimationFrame(frame);
  }

  // Respect users who've asked for reduced motion.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    frame();
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';
    drawFlames();
    ctx.globalCompositeOperation = 'source-over';
    drawGlobe();
  } else {
    frame();
  }
}
