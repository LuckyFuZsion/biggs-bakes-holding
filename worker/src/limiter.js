/**
 * Rate limit counters. One Durable Object holds them all, so counts are exact (not per data centre)
 * and, importantly, blocked attempts never touch Firestore, so a flood cannot use up the free
 * Firestore daily write quota.
 */
export class Limiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { key, limit, windowSec } = await request.json();
    const now = Date.now();
    const bucket = Math.floor(now / (windowSec * 1000));
    const id = `${key}_${bucket}`;

    const current = (await this.state.storage.get(id)) || { n: 0 };
    if (current.n >= limit) return Response.json({ ok: false });

    await this.state.storage.put(id, { n: current.n + 1, exp: (bucket + 2) * windowSec * 1000 });

    // Tidy up old windows now and then.
    if (Math.random() < 0.02) {
      const all = await this.state.storage.list();
      for (const [k, v] of all) {
        if (v && v.exp < now) await this.state.storage.delete(k);
      }
    }
    return Response.json({ ok: true });
  }
}
