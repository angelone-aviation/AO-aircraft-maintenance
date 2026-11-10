/**
 * Responsibility: Catches a render error anywhere below it and shows a
 *   plain-words page in place of a blank screen.
 * Layer: UI. React error boundary; reporting stays with the root's
 *   onCaughtError hook (src/data/errorReporting.ts).
 * Dependencies: react.
 */
import { Component, type ReactNode } from "react";

/** The boundary's children, and the page shown once one of them throws. */
export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

/**
 * Renders `children` until one throws while rendering, then `fallback` for
 * the rest of the page's life; a reload starts afresh.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The page an {@link ErrorBoundary} shows at the app's root: what happened,
 * that records are safe, whom to contact, and a reload.
 */
export function RenderFailure() {
  return (
    <>
      <h1>Something went wrong.</h1>
      <p role="alert">
        The app hit an unexpected error and could not show this screen. Your
        records are safe, and entries saved on this device stay queued.
      </p>
      <p>
        Reload to try again. If this keeps happening, contact your Flight
        Program administrator and tell them when it started.
      </p>
      <button
        className="button primary"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </>
  );
}
