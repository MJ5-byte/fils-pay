import type { ReactNode } from "react";

/**
 * A whole-page face for when there is no page to show: the brand's coin on
 * the ink and red diagonal, the same composition as the merchant sign-in, so
 * a wrong URL or a crash still looks like FilsPay instead of a router default.
 * It never prints the error itself; what went wrong stays in the console.
 */
function StatusFace({ code, title, action }: { code?: string; title: string; action: ReactNode }) {
  return (
    <main className="fp-status-face">
      <div className="fp-status-coin">
        <div className="fp-status-mark">
          <p className="fp-eyebrow">FilsPay</p>
          {code ? <p className="fp-status-code" aria-hidden="true">{code}</p> : null}
        </div>
      </div>
      <div className="fp-status-copy">
        <h1 className={code ? "fp-status-title" : "fp-status-title fp-status-title-solo"}>
          {code ? <span className="fp-visually-hidden">{code}. </span> : null}
          {title}
        </h1>
        {action}
      </div>
    </main>
  );
}

/** A full page load, not a client-side link, so it also works from an error element. */
export function NotFoundPage({ homeHref, homeLabel }: { homeHref: string; homeLabel: string }) {
  return (
    <StatusFace
      code="404"
      title="This page doesn't exist."
      action={<a className="dash-button dash-button-primary" href={homeHref}>{homeLabel}</a>}
    />
  );
}

export function CrashPage() {
  return (
    <StatusFace
      title="Something went wrong"
      action={
        <button type="button" className="dash-button dash-button-primary" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      }
    />
  );
}

/**
 * Stands in while a route guard asks the API who is signed in. That answer
 * usually takes a few hundred milliseconds and ends in a redirect, so the
 * mark only fades in after a delay (in CSS) and the common case shows nothing
 * at all. It sits on the page's own background so a signed-in user goes
 * straight from it to the light dashboard without a dark flash.
 */
export function SessionCheck() {
  return (
    <main className="fp-session-check" role="status">
      <span className="fp-visually-hidden">Checking your session</span>
      <span className="fp-session-coin" aria-hidden="true" />
    </main>
  );
}
