import { createStore } from "zustand/vanilla";

/** Whether the window is focused and on screen: the main process pushes it (the DOM cannot see a hidden window). */
export const windowFocus = createStore<{ focused: boolean }>(() => ({ focused: document.hasFocus() }));
window.loop.onFocusChange((focused) => windowFocus.setState({ focused }));
