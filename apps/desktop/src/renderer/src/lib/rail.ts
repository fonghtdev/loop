/** The rail's active-server pill is 32 px tall and sits on the vertical centre of the active item. */
export const PILL_HEIGHT = 32;

/** translateY of the pill inside the (scrolling) rail content, from the active item's offsetTop and height. */
export const pillOffset = (itemTop: number, itemHeight: number, pillHeight = PILL_HEIGHT) => Math.round(itemTop + (itemHeight - pillHeight) / 2);
