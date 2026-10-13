/** Drag-and-drop and paste helpers (pure; the components only wire events). */

type DataTransferLike = { types?: readonly string[]; files?: ArrayLike<File> };

/** A drag carrying files (text drags and in-page drags do not show the overlay). */
export const hasFiles = (dt: DataTransferLike | null | undefined): boolean => !!dt?.types && Array.from(dt.types).includes("Files");

/** Set on dragstart of a channel/category row; the channel column reacts only to drags that carry it, never to files. */
export const LAYOUT_DRAG = "application/x-loop-layout";
export const isLayoutDrag = (dt: DataTransferLike | null | undefined): boolean => !!dt?.types && Array.from(dt.types).includes(LAYOUT_DRAG);

/**
 * Files of a paste, or [] to leave the paste alone (plain text). Files win, except when the clipboard also has
 * HTML (copying from Word or a spreadsheet brings an image of the cells along with the text the user wants).
 */
export function pastedFiles(dt: DataTransferLike | null | undefined): File[] {
  if (!dt?.files?.length) return [];
  if (Array.from(dt.types ?? []).includes("text/html")) return [];
  return Array.from(dt.files);
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Screenshots arrive as "image.png": give pasted images a readable Vietnamese name, numbered when several. */
export function nameForPasted(file: File, index: number): File {
  const ext = EXT[file.type];
  if (!ext || (file.name && file.name !== "image." + ext)) return file;
  return new File([file], `anh-dan${index ? `-${index + 1}` : ""}.${ext}`, { type: file.type });
}

/** The window itself never handles a dropped file (that would navigate Electron to it). */
export function blockFileNavigation(target: Pick<Window, "addEventListener" | "removeEventListener">) {
  const stop = (e: Event) => e.preventDefault();
  target.addEventListener("dragover", stop);
  target.addEventListener("drop", stop);
  return () => {
    target.removeEventListener("dragover", stop);
    target.removeEventListener("drop", stop);
  };
}
