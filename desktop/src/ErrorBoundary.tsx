import { Component, type ComponentChildren } from "preact";
import { defaultCopy } from "./copy";
import handMark from "./assets/hand-mark.svg";

type Props = { children: ComponentChildren };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render({ children }: Props, state: State) {
    if (!state.failed) return children;
    return (
      <main class="app-shell loading-shell" role="alert">
        <img class="loading-mark" src={handMark} alt="搭手" />
        <h1>{defaultCopy.uiFailureTitle}</h1>
        <p>{defaultCopy.uiFailureBody}</p>
        <button class="button button-primary" type="button" onClick={() => window.location.reload()}>{defaultCopy.reloadUi}</button>
      </main>
    );
  }
}
