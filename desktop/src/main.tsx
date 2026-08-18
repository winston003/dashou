import { render } from "preact";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

render(<ErrorBoundary><App /></ErrorBoundary>, document.getElementById("app")!);
