/** Delays before a tooltip shows: pointer hover is slower than keyboard focus (which has no "passing over"). */
export const TOOLTIP_DELAY = { hover: 400, focus: 300 } as const;

/**
 * The timing of one tooltip: `enter` starts the delay, `leave` cancels or hides, Escape hides at once and stays
 * dismissed until the pointer leaves or focus moves away (so a hovering mouse does not bring it straight back).
 */
export function createTooltipTimer(show: () => void, hide: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  let dismissed = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const close = () => {
    cancel();
    if (visible) hide();
    visible = false;
  };
  return {
    enter(kind: keyof typeof TOOLTIP_DELAY) {
      if (visible || timer || dismissed) return;
      timer = setTimeout(() => {
        timer = undefined;
        visible = true;
        show();
      }, TOOLTIP_DELAY[kind]);
    },
    leave() {
      dismissed = false;
      close();
    },
    escape() {
      dismissed = true;
      close();
    },
    dispose: close,
  };
}
