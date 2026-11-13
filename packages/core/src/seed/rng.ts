/** mulberry32. Same seed, same stream. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Knuth for modest means. Above 20, a rounded normal draw keeps the generator fast
 * and still consumes a fixed two random numbers via Box-Muller.
 */
export function poisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 20) {
    const z = boxMuller(rng);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

function boxMuller(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
