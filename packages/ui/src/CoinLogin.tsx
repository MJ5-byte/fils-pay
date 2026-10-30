import { useRef, type PointerEvent, type ReactNode } from "react";

/** Degrees the coin leans with the pointer at its rim: a clear lean, not a flip. */
const TILT_MAX_DEG = 9;
/** The coin's radius as a share of its image's half width (the rest is shadow). */
const COIN_RADIUS = 0.918;
/** Past the rim the lean fades out over this many more coin radii, never a jump. */
const TILT_FADE = 0.6;
/** Where the render's key light sits on the face (top left), in percent of the disc. */
const GLARE_HOME = { x: 28, y: 24 };
/** How far the highlight slides with the lean, in percent of the disc. */
const GLARE_TRAVEL = 18;

/**
 * The login face both dashboards wear: the page is a real Bahrain 100 fils
 * coin, the form sits on its silver disc, and the eyebrow carries the product
 * name the coin does not. Styles live in `coin-login.css`, which each app
 * imports after `theme.css`; each page passes its own title and form.
 */
export function CoinLogin({ eyebrow, heading, children }: { eyebrow: string; heading: string; children: ReactNode }) {
  const discRef = useRef<HTMLDivElement>(null);

  // Mouse only: a touch has no hover, and reduced motion keeps the coin flat
  // (the CSS also drops the transform there).
  function tiltToward(event: PointerEvent): void {
    const disc = discRef.current;
    if (!disc || event.pointerType !== "mouse") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = disc.getBoundingClientRect();
    const half = box.width / 2;
    const radius = half * COIN_RADIUS;
    let dx = (event.clientX - (box.left + half)) / radius;
    let dy = (event.clientY - (box.top + half)) / radius;
    const reach = Math.hypot(dx, dy);
    if (reach >= 1 + TILT_FADE) {
      settle();
      return;
    }
    if (reach > 1) {
      const fade = (1 + TILT_FADE - reach) / TILT_FADE;
      dx = (dx / reach) * fade;
      dy = (dy / reach) * fade;
    }
    // The face turns toward the pointer. Turning it toward the key light (top
    // left) brightens the highlight there; turning it away dims it, so the
    // sheen always agrees with the light baked into the render.
    const facingKey = Math.max(0, -(dx + dy) / Math.SQRT2);
    disc.dataset.tilting = "";
    disc.style.setProperty("--fp-tilt-x", `${(-dy * TILT_MAX_DEG).toFixed(2)}deg`);
    disc.style.setProperty("--fp-tilt-y", `${(dx * TILT_MAX_DEG).toFixed(2)}deg`);
    disc.style.setProperty("--fp-glare-x", `${(GLARE_HOME.x + dx * GLARE_TRAVEL).toFixed(1)}%`);
    disc.style.setProperty("--fp-glare-y", `${(GLARE_HOME.y + dy * GLARE_TRAVEL).toFixed(1)}%`);
    disc.style.setProperty("--fp-glare-o", (0.45 + 0.55 * facingKey).toFixed(2));
    disc.style.setProperty("--fp-shade-o", Math.min(1, Math.hypot(dx, dy)).toFixed(2));
  }

  function settle(): void {
    const disc = discRef.current;
    if (!disc) return;
    delete disc.dataset.tilting;
    for (const name of ["--fp-tilt-x", "--fp-tilt-y", "--fp-glare-x", "--fp-glare-y", "--fp-glare-o", "--fp-shade-o"]) {
      disc.style.removeProperty(name);
    }
  }

  return (
    <main className="fp-coin-login" onPointerMove={tiltToward} onPointerLeave={settle}>
      <div className="fp-coin-disc" ref={discRef}>
        <div className="fp-coin-field">
          <header className="fp-coin-title">
            <p className="fp-eyebrow">{eyebrow}</p>
            <h1 className="fp-auth-heading">{heading}</h1>
          </header>
          {children}
        </div>
      </div>
    </main>
  );
}

/** The line under the last field: an error, else a notice, taking no height either way. */
export function CoinLoginMessage({ error, notice }: { error: string | null; notice?: string | null }) {
  return (
    <p className={error ? "fp-coin-message fp-coin-message-error" : "fp-coin-message"} role="status">
      {error ?? notice}
    </p>
  );
}
