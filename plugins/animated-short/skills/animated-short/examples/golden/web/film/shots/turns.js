// Shot "turns": three paper shapes take turns. On its cue each one winds up (anticipation),
// hops (stretch in the air, squash on landing) and swaps to a glad face at the moment of
// deepest squash, so the expression never snaps; the others idle out of phase, blink on their
// own seeded schedules and look toward whoever is hopping. Cues come from the element's
// "cues" map (hop0, hop1, hop2). Drawn in the element's box, origin at its centre.
FILM.shot('turns', function (ctx, t, api) {
  const { D, ACT, box } = api;
  const ts = api.ts; // stop-motion time: acting advances at 15 fps like everything else
  const cast = [
    { kind: 'circle', color: 'coral', x: -0.32, size: 180 },
    { kind: 'rect', color: 'teal', x: 0, size: 170 },
    { kind: 'triangle', color: 'gold', x: 0.32, size: 195 },
  ];
  const hops = [api.cue('hop0'), api.cue('hop1'), api.cue('hop2')];
  const floorY = box.h * 0.3;
  let active = -1;
  hops.forEach((h, i) => { if (ts >= h - 0.3) active = i; });

  D.ink(ctx, [[-box.w * 0.46, floorY + 6], [0, floorY + 2], [box.w * 0.46, floorY + 8]], { w: 5, seed: api.seed % 1000, t, c: 'ink', wob: 1.2 });
  cast.forEach((c, i) => {
    const id = api.id + ':' + i, x = c.x * box.w, s = c.size;
    const idle = ACT.idle(ts, id, { bob: 2.5, sway: 1.2, breathe: 0.02 });
    const leap = ACT.leap(ts, hops[i], 0.45, { h: 130, amt: 0.2 });
    const take = ACT.takes(ts, [{ pose: 'calm' }, { at: hops[i], pose: 'glad' }, { at: hops[i] + 1.4, pose: 'calm' }], { amt: 0.08 });
    const [bx, by, br] = ACT.boil(id, t);
    const air = -leap.y;
    // contact shadow shrinks as the shape rises
    ctx.save(); ctx.fillStyle = D.sh(0.16 * (1 - Math.min(0.7, air / 200)));
    ctx.beginPath(); ctx.ellipse(x, floorY + 4, s * 0.42 * (1 - air / 500), s * 0.07, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    // squash and stretch pivot on the feet so the shape stays planted
    ctx.save();
    ctx.translate(x + bx, floorY - air + by);
    ctx.rotate(api.U.deg(idle.r + br));
    ctx.scale(leap.sx * take.sx * idle.sx, leap.sy * take.sy * idle.sy);
    ctx.translate(0, -s / 2);
    D.paperShape(ctx, c.kind, s, c.kind === 'triangle' ? s * 0.92 : s, c.color, (api.seed + i * 31) % 1000, { lift: Math.min(1, air / 130) });
    const look = active < 0 || active === i ? [0, active === i ? -0.6 : 0] : [Math.sign(cast[active].x - c.x), 0];
    ACT.face(ctx, 0, c.kind === 'triangle' ? s * 0.16 : 0, s * 0.9, { pose: take.pose, blink: ACT.blink(ts, api.seed + i * 17), look, t, seed: i + 3 });
    ctx.restore();
  });
});
