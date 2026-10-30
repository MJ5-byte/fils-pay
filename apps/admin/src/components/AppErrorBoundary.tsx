import { Component } from "react";
import type { ReactNode } from "react";
import { CrashPage } from "@filspay/ui";

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
    return <CrashPage />;
  }
}
