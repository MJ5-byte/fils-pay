import { Component } from "react";
import type { ReactNode } from "react";

/**
 * Sits inside the router's root route, around every page, so a render error
 * shows a short message and a way back instead of React Router's default
 * screen, which prints the raw error and its stack trace.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="dash-centered">
        <p className="dash-error">Something went wrong on this page.</p>
        <a href={window.location.href}>Reload the page</a>
      </main>
    );
  }
}
